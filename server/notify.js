// server/notify.js — order alerts.
//
// The in-app inbox is always on (it's just rows in `messages`). Email is opt-in:
// a user only gets mail if they put an address on their profile AND the server
// has RESEND_API_KEY. With no key this no-ops quietly, so the app runs fine
// without any mail provider configured.
//
// No dependency: Resend is a plain HTTPS API, so fetch is enough.
import { q } from './config.js';

const KEY  = process.env.RESEND_API_KEY;
const FROM = process.env.MAIL_FROM || 'World Swap <onboarding@resend.dev>';
const BASE = process.env.PUBLIC_URL || 'https://www.topworldmedia.world';

if (!KEY) console.log('[notify] RESEND_API_KEY not set — email alerts are off (in-app inbox still works).');

async function emailFor(wallet) {
  const { rows } = await q(`SELECT email FROM users WHERE lower(wallet) = $1`, [String(wallet).toLowerCase()]);
  return rows[0]?.email || null;
}

async function send(to, subject, lines) {
  if (!KEY || !to) return false;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55;color:#101418">
    ${lines.map(l => `<p style="margin:0 0 12px">${l}</p>`).join('')}
    <p style="margin:20px 0 0"><a href="${BASE}/app" style="color:#0b7">Open World Swap →</a></p>
    <p style="margin:22px 0 0;font-size:12px;color:#889">You're getting this because you added an email to your World Swap profile. Remove it there to stop these.</p>
  </div>`;
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to, subject, html }),
    });
    if (!r.ok) console.error('[notify] resend', r.status, await r.text().catch(() => ''));
    return r.ok;
  } catch (e) {
    console.error('[notify] send failed', e.message);   // never let mail break a request
    return false;
  }
}

// Fire-and-forget: notifications must never block or fail an order action.
export function notify(wallet, subject, lines) {
  (async () => {
    const to = await emailFor(wallet);
    if (to) await send(to, subject, lines);
  })().catch(e => console.error('[notify]', e.message));
}

export const tmpl = {
  newOrder:  (title, amt)      => ['You have a new order.', `<b>${title}</b> — ${amt} USDC.`, 'The buyer has funded escrow. Ship it or start the work, then mark it in the app.'],
  newMessage:(title, from)     => [`New message about <b>${title}</b>.`, `From ${from}.`],
  shipped:   (title, carrier)  => [`<b>${title}</b> has shipped.`, carrier ? `Carrier: ${carrier}.` : 'Check the app for tracking.', 'Confirm delivery when it arrives to release the funds.'],
  released:  (title, amt)      => ['Funds released.', `<b>${title}</b> — ${amt} USDC is on its way to your wallet.`],
  disputed:  (title)           => [`A dispute was opened on <b>${title}</b>.`, 'Funds are frozen until the arbiter resolves it.'],
};
