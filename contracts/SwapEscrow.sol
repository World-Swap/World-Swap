// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title SwapEscrow
 * @notice Non-custodial escrow for World Swap. Funds live in THIS contract,
 *         governed only by code — World Swap operators cannot move them.
 *         - Buyer funds an order in USDC.
 *         - Only the buyer can release (pays seller 99.5% + fee 0.5% in one tx).
 *         - Disputes are resolved ONLY by the arbiter (a multisig), which may
 *           release to the seller or refund the buyer. No unilateral operator control.
 *         - Digital goods can settle instantly (fund + release atomically).
 *
 * @dev Illustrative reference. Get a professional audit before mainnet funds.
 */
contract SwapEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20  public immutable token;         // USDC
    address public immutable feeRecipient;  // World Swap fee wallet
    address public arbiter;                 // dispute resolver (multisig)
    uint16  public constant FEE_BPS = 50;   // 0.5%

    enum State { None, Funded, Released, Refunded, Disputed }

    struct Order {
        address buyer;
        address seller;
        uint256 amount;
        State   state;
    }

    mapping(bytes32 => Order) public orders;   // onchainOrderId => Order

    event Funded(bytes32 indexed orderId, address indexed buyer, address indexed seller, uint256 amount);
    event Released(bytes32 indexed orderId, uint256 toSeller, uint256 fee);
    event Refunded(bytes32 indexed orderId, uint256 amount);
    event Disputed(bytes32 indexed orderId, address by);
    event ArbiterChanged(address arbiter);

    modifier onlyArbiter() { require(msg.sender == arbiter, "not arbiter"); _; }

    constructor(address _token, address _feeRecipient, address _arbiter) {
        require(_token != address(0) && _feeRecipient != address(0) && _arbiter != address(0), "zero addr");
        token = IERC20(_token);
        feeRecipient = _feeRecipient;
        arbiter = _arbiter;
    }

    /// @notice Buyer funds escrow. Requires prior USDC approve() for `amount`.
    function fundEscrow(bytes32 orderId, address seller, uint256 amount) external nonReentrant {
        require(orders[orderId].state == State.None, "order exists");
        require(seller != address(0) && amount > 0, "bad params");
        orders[orderId] = Order({ buyer: msg.sender, seller: seller, amount: amount, state: State.Funded });
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(orderId, msg.sender, seller, amount);
    }

    /// @notice Buyer releases funds after receiving the goods/work.
    function release(bytes32 orderId) external nonReentrant {
        Order storage o = orders[orderId];
        require(o.state == State.Funded || o.state == State.Disputed, "not releasable");
        require(msg.sender == o.buyer, "only buyer");
        _settle(orderId, o);
    }

    /// @notice Instant settlement for digital goods: fund + release in one tx.
    ///         No hold period — used only when delivery is instant.
    function settleInstant(bytes32 orderId, address seller, uint256 amount) external nonReentrant {
        require(orders[orderId].state == State.None, "order exists");
        require(seller != address(0) && amount > 0, "bad params");
        Order memory o = Order({ buyer: msg.sender, seller: seller, amount: amount, state: State.Funded });
        orders[orderId] = o;
        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Funded(orderId, msg.sender, seller, amount);
        _settle(orderId, orders[orderId]);
    }

    /// @notice Either party flags a dispute; funds freeze until the arbiter rules.
    function raiseDispute(bytes32 orderId) external {
        Order storage o = orders[orderId];
        require(o.state == State.Funded, "not funded");
        require(msg.sender == o.buyer || msg.sender == o.seller, "not a party");
        o.state = State.Disputed;
        emit Disputed(orderId, msg.sender);
    }

    /// @notice Arbiter resolves a dispute: release to seller or refund buyer.
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

    function setArbiter(address _arbiter) external onlyArbiter {
        require(_arbiter != address(0), "zero addr");
        arbiter = _arbiter;
        emit ArbiterChanged(_arbiter);
    }

    // --- internal: split 99.5% seller / 0.5% fee, atomically ------------------
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
