import { Injectable, Logger } from '@nestjs/common';
import { frontendUrl, naira } from './common';

export const esc = (s: any) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const when = (d: Date | string) => new Date(d).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

/** Shapes the order emails need. Built by the code that triggers the email. */
export type OrderMail = {
  orderNo: string; title: string; quantity: number; amountPaid: number;
  buyerName: string; buyerEmail: string;
  business: string; sellerEmail?: string; sellerPhone?: string;
  address?: string; area?: string; city?: string; pickupBy?: Date | string; pickupCode?: string;
};

/**
 * Sends email through Resend (https://resend.com).
 * - With no RESEND_API_KEY it only prints to the log (local mode).
 * - Resend's free plan allows 100 emails a day. Important emails (verification, order codes, refunds) are always attempted.
 *   "low" priority emails (admin alerts, reminders, thank-yous) are skipped once the day is nearly used up.
 * - Failed sends are retried, because a lost pickup-code email would leave a buyer stuck. The code is also always visible in My orders.
 */
@Injectable()
export class MailerService {
  private log = new Logger('Mailer');
  private sentAt: number[] = []; // timestamps of sends in the last 24 hours

  private budgetLeft() { const day = Date.now() - 86400000; this.sentAt = this.sentAt.filter((t) => t > day); return 100 - this.sentAt.length; }

  async send(to: string, subject: string, html: string, opts: { devNote?: string; low?: boolean } = {}) {
    const key = process.env.RESEND_API_KEY;
    if (!key) { this.log.warn(`LOCAL MODE, no email sent. To: ${to} | ${subject}${opts.devNote ? ' | ' + opts.devNote : ''}`); return false; }
    if (opts.low && this.budgetLeft() < 25) { this.log.warn(`Skipped low-priority email to save the daily limit: ${subject}`); return false; }
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: process.env.MAIL_FROM || 'GbaanJo <onboarding@resend.dev>', to: [to], subject, html }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) { this.sentAt.push(Date.now()); return true; }
        const text = await res.text();
        this.log.error(`Email failed (${res.status}) to ${to}: ${text}`);
        if (res.status !== 429 && res.status < 500) return false; // a 4xx will not fix itself (bad address, unverified domain)
      } catch (e: any) { this.log.error(`Email error to ${to}: ${e?.message || e}`); }
      await sleep(attempt * 1000);
    }
    return false;
  }

  private wrap(body: string) {
    return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#15211B"><h2 style="color:#0E3B2C;margin:0 0 16px">Gbaan<span style="color:#F4B52E">Jo</span></h2>${body}<p style="color:#5A6B61;font-size:12px;margin-top:32px">If you did not expect this email, you can ignore it. Questions? Just reply to this email.</p></div>`;
  }
  private button(link: string, label: string) {
    return `<p style="margin:24px 0"><a href="${link}" style="background:#D52B1E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${esc(label)}</a></p><p style="font-size:12px;color:#5A6B61">Or paste this link into your browser:<br>${link}</p>`;
  }
  private box(inner: string) { return `<div style="background:#F1F5EE;border-radius:12px;padding:16px;margin:16px 0">${inner}</div>`; }
  private code(c: string) { return `<div style="background:#0E3B2C;color:#F4B52E;border-radius:12px;padding:16px;text-align:center;font-size:34px;font-weight:bold;letter-spacing:8px;margin:16px 0">${esc(c)}</div>`; }

  // ---------- Accounts ----------
  sendVerification(to: string, name: string, link: string) {
    return this.send(to, 'Verify your GbaanJo email', this.wrap(`<p>Hi ${esc(name)},</p><p>Please confirm your email address. This link works for 24 hours.</p>${this.button(link, 'Verify my email')}`), { devNote: 'VERIFY LINK: ' + link });
  }
  sendPasswordReset(to: string, name: string, link: string) {
    return this.send(to, 'Reset your GbaanJo password', this.wrap(`<p>Hi ${esc(name)},</p><p>We got a request to reset your password. This link works for 1 hour. If it was not you, ignore this email and your password stays the same.</p>${this.button(link, 'Choose a new password')}`), { devNote: 'RESET LINK: ' + link });
  }
  sellerDecision(to: string, business: string, approved: boolean, reason?: string) {
    const body = approved
      ? `<p>Good news! <b>${esc(business)}</b> has been approved as a GbaanJo seller.</p><p>Next steps: add your payout account, upload food photos and list your first deal.</p>${this.button(frontendUrl() + '/seller', 'Go to my shop')}`
      : `<p>We could not approve <b>${esc(business)}</b> yet.</p><p><b>Reason:</b> ${esc(reason || 'Please check your details')}</p><p>Log in, fix your details and resubmit your application.</p>${this.button(frontendUrl() + '/seller', 'Fix my application')}`;
    return this.send(to, approved ? 'Your GbaanJo seller application is approved' : 'Update on your GbaanJo seller application', this.wrap(body));
  }
  payoutAccountChanged(to: string, business: string, bank: string, last4: string) {
    return this.send(to, 'Your GbaanJo payout account was changed', this.wrap(`<p>The payout account for <b>${esc(business)}</b> was just set to <b>${esc(bank)}, account ending ${esc(last4)}</b>.</p><p><b>Was this not you?</b> Reset your password right away and reply to this email.</p>`));
  }

  // ---------- Orders: buyer ----------
  orderPaidBuyer(o: OrderMail) {
    const body = `<p>Hi ${esc(o.buyerName)}, your payment was received. Your food is reserved! 🎉</p>
      ${this.box(`<b>${o.quantity} × ${esc(o.title)}</b><br>Order ${esc(o.orderNo)} · ${naira(o.amountPaid)} paid<br>from ${esc(o.business)}`)}
      <p>Show this code to the seller when you collect:</p>${this.code(o.pickupCode || '')}
      <p><b>Collect by ${o.pickupBy ? esc(when(o.pickupBy)) : ''}</b><br>${esc(o.address)}, ${esc(o.area)}, ${esc(o.city)}${o.sellerPhone ? `<br>Seller phone: ${esc(o.sellerPhone)}` : ''}</p>
      <p style="font-size:13px;color:#5A6B61">Anyone who shows this code gets the food, so only share it with someone you trust. You can cancel for a refund from My orders until the sale ends.</p>${this.button(frontendUrl() + '/orders', 'Open my orders')}`;
    return this.send(o.buyerEmail, `Your code for ${o.title} (${o.orderNo})`, this.wrap(body));
  }
  orderCancelledBuyer(o: Pick<OrderMail, 'orderNo' | 'title' | 'buyerName' | 'buyerEmail' | 'amountPaid'>, refund: boolean, reason: string) {
    const body = `<p>Hi ${esc(o.buyerName)},</p><p>Your order <b>${esc(o.orderNo)}</b> (${esc(o.title)}) was cancelled. ${esc(reason)}</p>
      ${refund ? this.box(`<b>Refund: ${naira(o.amountPaid)}</b><br>We process refunds within 1 to 3 working days and will email you when it is sent.`) : '<p>You were not charged.</p>'}
      ${this.button(frontendUrl() + '/deals', 'See live deals')}`;
    return this.send(o.buyerEmail, `Order ${o.orderNo} cancelled`, this.wrap(body));
  }
  refundSent(o: Pick<OrderMail, 'orderNo' | 'title' | 'buyerName' | 'buyerEmail' | 'amountPaid'>) {
    return this.send(o.buyerEmail, `Your refund for ${o.orderNo} is on its way`, this.wrap(`<p>Hi ${esc(o.buyerName)},</p><p>We have refunded <b>${naira(o.amountPaid)}</b> for order <b>${esc(o.orderNo)}</b> (${esc(o.title)}).</p><p>Depending on your bank or card, it can take a few working days to show up. If you do not see it after 5 working days, reply to this email.</p>`));
  }
  pickupReminder(o: OrderMail) {
    return this.send(o.buyerEmail, `Reminder: collect your food from ${o.business}`, this.wrap(`<p>Hi ${esc(o.buyerName)}, your food is waiting. 🍽️</p>${this.box(`<b>${o.quantity} × ${esc(o.title)}</b><br>Collect by <b>${o.pickupBy ? esc(when(o.pickupBy)) : ''}</b><br>${esc(o.address)}, ${esc(o.area)}`)}<p>Pickup code: <b style="letter-spacing:3px">${esc(o.pickupCode)}</b></p><p style="font-size:13px;color:#5A6B61">If you cannot make it, send someone you trust with your code. Orders not collected in time are not refunded.</p>${this.button(frontendUrl() + '/orders', 'Open my orders')}`), { low: true });
  }
  orderMissedBuyer(o: OrderMail) {
    return this.send(o.buyerEmail, `You missed the pickup for ${o.orderNo}`, this.wrap(`<p>Hi ${esc(o.buyerName)},</p><p>The pickup time for <b>${esc(o.title)}</b> from ${esc(o.business)} has passed and the order was not collected. As our rules say, the seller keeps the payment for food they prepared.</p><p style="font-size:13px;color:#5A6B61">Missing 3 pickups pauses ordering on your account, so please only reserve what you can collect.</p>`), { low: true });
  }
  pickedUpBuyer(o: OrderMail) {
    return this.send(o.buyerEmail, 'Enjoy your food! How was it?', this.wrap(`<p>Hi ${esc(o.buyerName)}, thanks for rescuing good food today. 💚</p><p>You are helping us get GbaanJo right. Two minutes of feedback means a lot while we are testing.</p>${this.button(frontendUrl() + '/feedback', 'Share feedback')}`), { low: true });
  }

  // ---------- Orders: seller ----------
  newOrderSeller(o: OrderMail) {
    if (!o.sellerEmail) return Promise.resolve(false);
    return this.send(o.sellerEmail, `New order: ${o.quantity} × ${o.title}`, this.wrap(`<p>Hi ${esc(o.business)}, you have a new paid order! 🎉</p>${this.box(`<b>${o.quantity} × ${esc(o.title)}</b><br>Order ${esc(o.orderNo)} · customer ${esc(o.buyerName)}<br>Collect by <b>${o.pickupBy ? esc(when(o.pickupBy)) : ''}</b>`)}<p>Please keep the food ready. When the customer arrives, ask for their 6-digit code and enter it under <b>My shop → Orders</b>.</p>${this.button(frontendUrl() + '/seller', 'Open my shop')}`));
  }
  orderCancelledSeller(o: OrderMail, reason: string) {
    if (!o.sellerEmail) return Promise.resolve(false);
    return this.send(o.sellerEmail, `Order ${o.orderNo} was cancelled`, this.wrap(`<p>Hi ${esc(o.business)},</p><p>Order <b>${esc(o.orderNo)}</b> (${o.quantity} × ${esc(o.title)}) was cancelled. ${esc(reason)}</p><p>The portion went back on sale if your sale is still running. You do not need to do anything.</p>`), { low: true });
  }
  orderMissedSeller(o: OrderMail) {
    if (!o.sellerEmail) return Promise.resolve(false);
    return this.send(o.sellerEmail, `Customer did not collect ${o.orderNo}`, this.wrap(`<p>Hi ${esc(o.business)},</p><p>The customer did not collect order <b>${esc(o.orderNo)}</b> (${o.quantity} × ${esc(o.title)}) before the pickup time. The payment is still yours and will be included in your next payout.</p>`), { low: true });
  }
  payoutSent(to: string, business: string, amount: number, orders: number, bank: string, last4: string) {
    return this.send(to, `GbaanJo payout sent: ${naira(amount)}`, this.wrap(`<p>Hi ${esc(business)}, we have sent your payout. 💸</p>${this.box(`<b>${naira(amount)}</b> for ${orders} order${orders === 1 ? '' : 's'}<br>to ${esc(bank)}, account ending ${esc(last4)}`)}<p style="font-size:13px;color:#5A6B61">It normally arrives within minutes, but can take a few hours depending on your bank. If it does not show by tomorrow, reply to this email.</p>`));
  }
  listingCancelledSeller(to: string, business: string, title: string, reason: string) {
    return this.send(to, `Your listing "${title}" was removed`, this.wrap(`<p>Hi ${esc(business)},</p><p>Your listing <b>${esc(title)}</b> was removed. ${esc(reason)}</p><p>Open orders for it were cancelled and refunded to the buyers. Reply to this email if you have questions.</p>`));
  }

  // ---------- Admin ----------
  /** Tells the admin about things that need action, so nothing waits unnoticed. Needs ADMIN_ALERT_EMAIL (or ADMIN_EMAIL). */
  adminAlert(subject: string, lines: string) {
    const to = process.env.ADMIN_ALERT_EMAIL || process.env.ADMIN_EMAIL;
    if (!to) return Promise.resolve(false);
    return this.send(to, '[GbaanJo admin] ' + subject, this.wrap(`<p>${lines}</p>${this.button(frontendUrl() + '/admin', 'Open admin')}`), { low: true });
  }
}
