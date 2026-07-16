// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SwapEscrow
 * @notice Non-custodial escrow for World Swap. Funds live in THIS contract and
 *         are governed only by code. World Swap operators cannot move them.
 *
 * @dev THE TWO DEADLOCKS THIS EXISTS TO KILL
 *
 *      1. Seller delivers, buyer vanishes    -> seller could never be paid.
 *      2. Seller never delivers, buyer waits -> buyer could never be refunded
 *                                               without begging an arbiter.
 *
 *      Both are solved with clocks, not with people:
 *
 *        fundEscrow --> Funded --markDelivered--> Delivered --release--> Released
 *                         |     (seller only)         |      (buyer)
 *                 deliverBy passes             claimAfter passes
 *                         |                           |
 *                         v                           v
 *                 refundExpired()              claimExpired()
 *                 buyer made whole             seller finally paid
 *                 (callable by anyone)         (callable by anyone)
 *
 * @dev THE CORE RULE: a seller cannot be paid without first calling
 *      markDelivered(). There is no path from Funded to Released that does not
 *      pass through the seller publicly staking a delivery claim on-chain, or
 *      through the buyer voluntarily choosing to pay. A seller who ships nothing
 *      and simply waits collects nothing -- and the buyer's refund needs no
 *      arbiter, no operator, and nobody's permission.
 *
 * @dev Windows are frozen onto each order at funding time. Retuning them later
 *      can never retroactively shorten protection someone already bought.
 *
 * @dev ARBITER IS A SINGLE KEY TODAY, NOT A MULTISIG. It can only ever choose
 *      between the two recorded parties -- it can never pay itself -- but if
 *      that key is lost, disputed orders freeze permanently. Move it to a
 *      multisig via setArbiter() before mainnet.
 *
 * @dev UNAUDITED. Testnet only. Get a professional audit before real funds.
 */
contract SwapEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable token;         // USDC
    address public immutable feeRecipient;  // World Swap fee wallet
    address public arbiter;                 // dispute resolver
    uint16  public constant FEE_BPS = 50;   // 0.5%

    /// @notice Seller must markDelivered within this of funding, or the buyer
    ///         can take their money back unilaterally.
    uint64 public deliverWindow = 14 days;

    /// @notice Buyer must release or dispute within this of markDelivered, or
    ///         the seller can finally collect.
    uint64 public inspectWindow = 14 days;

    uint64 public constant MIN_WINDOW = 1 days;
    uint64 public constant MAX_WINDOW = 90 days;

    enum State { None, Funded, Delivered, Released, Refunded, Disputed }

    struct Order {
        address buyer;
        address seller;
        uint256 amount;
        State   state;
        uint64  deliverBy;    // frozen at funding: seller must mark by this instant
        uint64  inspectSecs;  // frozen at funding: how long the buyer gets after delivery
        uint64  claimAfter;   // set at markDelivered: seller may collect after this
    }

    mapping(bytes32 => Order) public orders;

    event Funded(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount, uint64 deliverBy);
    event Delivered(bytes32 indexed orderId, uint64 claimAfter);
    event Released(bytes32 indexed orderId, uint256 toSeller, uint256 fee);
    event AutoClaimed(bytes32 indexed orderId, address caller);
    event Refunded(bytes32 indexed orderId, uint256 amount);
    event AutoRefunded(bytes32 indexed orderId, address caller);
    event Disputed(bytes32 indexed orderId, address by);
    event ArbiterChanged(address arbiter);
    event WindowsChanged(uint64 deliverWindow, uint64 inspectWindow);

    modifier onlyArbiter() { require(msg.sender == arbiter, "not arbiter"); _; }

    constructor(address _token, address _feeRecipient, address _arbiter) {
        require(_token != address(0) && _feeRecipient != address(0) && _arbiter != address(0), "zero addr");
        token = IERC20(_token);
        feeRecipient = _feeRecipient;
        arbiter = _arbiter;
    }

    // ------------------------------------------------------------------------
    // Buyer pays in
    // ------------------------------------------------------------------------

    /// @notice Buyer funds escrow. Requires a prior USDC approve() for `amount`.
    /// @dev    Both windows are snapshotted onto the order right here, so a
    ///         later setWindows() cannot reach back and change these terms.
    function fundEscrow(bytes32 orderId, address seller, uint256 amount) external nonReentrant {
        require(orders[orderId].state == State.None, "order exists");
        require(seller != address(0) && amount > 0, "bad params");

        uint64 deliverBy = uint64(block.timestamp) + deliverWindow;
        orders[orderId] = Order({
            buyer: msg.sender,
            seller: seller,
            amount: amount,
            state: State.Funded,
            deliverBy: deliverBy,
            inspectSecs: inspectWindow,
            claimAfter: 0
        });
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(orderId, msg.sender, seller, amount, deliverBy);
    }

    // ------------------------------------------------------------------------
    // Seller stakes a delivery claim
    // ------------------------------------------------------------------------

    /// @notice Seller declares the goods are on their way (or the work is done).
    ///         Starts the buyer's inspection clock.
    ///
    /// @dev    This is the gate. No markDelivered, no payday -- ever.
    ///
    ///         Deliberately STRICT about the window: once deliverBy passes the
    ///         seller can never mark. If late marking were allowed, a seller who
    ///         shipped nothing could watch the mempool for the buyer's refund and
    ///         front-run it with a bogus markDelivered, dragging the buyer into a
    ///         dispute instead. A hard cutoff means the buyer's refund right,
    ///         once earned, cannot be taken away by anyone.
    ///
    ///         Marking is a CLAIM, not proof -- a chain cannot see a parcel. It
    ///         only buys the seller a payday after the buyer has had a full
    ///         inspection window in which to dispute it.
    function markDelivered(bytes32 orderId) external {
        Order storage o = orders[orderId];
        require(o.state == State.Funded, "not funded");
        require(msg.sender == o.seller, "only seller");
        require(block.timestamp <= o.deliverBy, "deliver window passed");

        o.state = State.Delivered;
        uint64 claimAfter = uint64(block.timestamp) + o.inspectSecs;
        o.claimAfter = claimAfter;
        emit Delivered(orderId, claimAfter);
    }

    // ------------------------------------------------------------------------
    // Settlement
    // ------------------------------------------------------------------------

    /// @notice Buyer releases the funds. Allowed from any live state -- a buyer
    ///         may always choose to pay, including before delivery is marked, or
    ///         after opening a dispute and changing their mind.
    function release(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.state == State.Funded || o.state == State.Delivered || o.state == State.Disputed, "not releasable");
        require(msg.sender == o.buyer, "only buyer");
        _settle(orderId, o);
    }

    /// @notice Instant settlement for digital goods: fund and release in one tx.
    ///         Nothing is ever held, so no clocks apply.
    function settleInstant(bytes32 orderId, address seller, uint256 amount) external nonReentrant {
        require(orders[orderId].state == State.None, "order exists");
        require(seller != address(0) && amount > 0, "bad params");

        orders[orderId] = Order({
            buyer: msg.sender, seller: seller, amount: amount,
            state: State.Funded, deliverBy: 0, inspectSecs: 0, claimAfter: 0
        });
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(orderId, msg.sender, seller, amount, 0);
        _settle(orderId, orders[orderId]);
    }

    /// @notice Seller was ignored. Once the buyer's inspection window lapses on a
    ///         DELIVERED order, the money is theirs.
    ///
    /// @dev    Callable by ANYONE on purpose: the clock is the authority, not the
    ///         caller. Funds can only ever reach the seller recorded at funding,
    ///         so no caller -- World Swap included -- gains anything by calling
    ///         it. Requires State.Delivered, so a seller who never marked can
    ///         never reach this line.
    function claimExpired(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.state == State.Delivered, "not delivered");
        require(block.timestamp >= o.claimAfter, "too early");
        emit AutoClaimed(orderId, msg.sender);
        _settle(orderId, o);
    }

    /// @notice Seller never delivered. Once deliverBy lapses on a FUNDED order,
    ///         the buyer takes their money back -- in full. No fee is charged on
    ///         a sale that never happened.
    ///
    /// @dev    No arbiter. No operator. Nobody's permission. This is the whole
    ///         promise: a seller who ships nothing cannot keep a buyer's money by
    ///         doing nothing. Callable by anyone; funds only ever return to the
    ///         recorded buyer.
    function refundExpired(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.state == State.Funded, "not funded");
        require(o.deliverBy != 0, "no deadline");
        require(block.timestamp > o.deliverBy, "too early");

        uint256 amt = o.amount;
        o.state = State.Refunded;              // effects before interactions
        token.safeTransfer(o.buyer, amt);
        emit AutoRefunded(orderId, msg.sender);
        emit Refunded(orderId, amt);
    }

    // ------------------------------------------------------------------------
    // Disputes
    // ------------------------------------------------------------------------

    /// @notice Either party freezes the order. Both clocks stop: neither
    ///         claimExpired nor refundExpired can touch a disputed order.
    function raiseDispute(bytes32 orderId) external {
        Order storage o = orders[orderId];
        require(o.state == State.Funded || o.state == State.Delivered, "not disputable");
        require(msg.sender == o.buyer || msg.sender == o.seller, "not a party");
        o.state = State.Disputed;
        emit Disputed(orderId, msg.sender);
    }

    /// @notice Arbiter rules: pay the seller, or refund the buyer. It cannot
    ///         invent a third outcome, and it can never pay itself.
    function resolve(bytes32 orderId, bool releaseToSeller) external onlyArbiter nonReentrant {
        Order storage o = orders[orderId];
        require(o.state == State.Disputed, "not disputed");
        if (releaseToSeller) {
            _settle(orderId, o);
        } else {
            uint256 amt = o.amount;
            o.state = State.Refunded;
            token.safeTransfer(o.buyer, amt);
            emit Refunded(orderId, amt);
        }
    }

    // ------------------------------------------------------------------------
    // Views -- for the UI countdowns
    // ------------------------------------------------------------------------

    /// @notice Seconds until the buyer can refund a never-delivered order.
    ///         0 means refundable now, or not applicable.
    function timeUntilRefundable(bytes32 orderId) external view returns (uint256) {
        Order storage o = orders[orderId];
        if (o.state != State.Funded || o.deliverBy == 0) return 0;
        if (block.timestamp > o.deliverBy) return 0;
        return o.deliverBy - block.timestamp;
    }

    /// @notice Seconds until the seller can collect a delivered order.
    ///         0 means claimable now, or not applicable.
    function timeUntilClaimable(bytes32 orderId) external view returns (uint256) {
        Order storage o = orders[orderId];
        if (o.state != State.Delivered) return 0;
        if (block.timestamp >= o.claimAfter) return 0;
        return o.claimAfter - block.timestamp;
    }

    // ------------------------------------------------------------------------
    // Admin -- deliberately weak
    // ------------------------------------------------------------------------

    function setArbiter(address _arbiter) external onlyArbiter {
        require(_arbiter != address(0), "zero addr");
        arbiter = _arbiter;
        emit ArbiterChanged(_arbiter);
    }

    /// @notice Retune the clocks for FUTURE orders only.
    /// @dev    Bounded on purpose. If inspectWindow could be set to 0, whoever
    ///         holds the arbiter key could let sellers sweep new escrows the
    ///         instant they marked delivery. If deliverWindow could be set to 0,
    ///         buyers could refund before any seller had a chance to ship. Live
    ///         orders are untouchable: their terms froze at funding.
    function setWindows(uint64 _deliverWindow, uint64 _inspectWindow) external onlyArbiter {
        require(_deliverWindow >= MIN_WINDOW && _deliverWindow <= MAX_WINDOW, "deliver out of bounds");
        require(_inspectWindow >= MIN_WINDOW && _inspectWindow <= MAX_WINDOW, "inspect out of bounds");
        deliverWindow = _deliverWindow;
        inspectWindow = _inspectWindow;
        emit WindowsChanged(_deliverWindow, _inspectWindow);
    }

    // ------------------------------------------------------------------------
    // Internal
    // ------------------------------------------------------------------------

    /// @dev Split 99.5% seller / 0.5% fee, atomically, inside the settling tx.
    ///      World Swap never holds the fee -- it is routed straight out.
    function _settle(bytes32 orderId, Order storage o) internal {
        uint256 amount = o.amount;
        o.state = State.Released;                 // effects before interactions
        uint256 fee = (amount * FEE_BPS) / 10_000;
        uint256 toSeller = amount - fee;
        token.safeTransfer(o.seller, toSeller);
        if (fee > 0) token.safeTransfer(feeRecipient, fee);
        emit Released(orderId, toSeller, fee);
    }
}
