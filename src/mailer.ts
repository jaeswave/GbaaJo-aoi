import { Injectable, Logger } from '@nestjs/common';
import { frontendUrl } from './common';

const esc = (s: string) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Sends email through Resend. With no RESEND_API_KEY it only prints to the terminal (local mode). */
@Injectable()
export class MailerService {
  private log = new Logger('Mailer');

  async send(to: string, subject: string, html: string, devNote?: string) {
    const key = process.env.RESEND_API_KEY;
    if (!key) { this.log.warn(`LOCAL MODE, no email sent. To: ${to} | ${subject}${devNote ? ' | ' + devNote : ''}`); return; }
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: process.env.MAIL_FROM || 'GbaanJo <onboarding@resend.dev>', to: [to], subject, html }),
      });
      if (!res.ok) this.log.error(`Email failed (${res.status}): ${await res.text()}`);
    } catch (e) { this.log.error(e); }
  }

  private wrap(body: string) {
    return `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#15211B"><h2 style="color:#0E3B2C;margin:0 0 16px">Gbaan<span style="color:#F4B52E">Jo</span></h2>${body}<p style="color:#5A6B61;font-size:12px;margin-top:32px">If you did not expect this email, you can ignore it.</p></div>`;
  }
  private button(link: string, label: string) {
    return `<p style="margin:24px 0"><a href="${link}" style="background:#D52B1E;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:bold">${label}</a></p><p style="font-size:12px;color:#5A6B61">Or paste this link into your browser:<br>${link}</p>`;
  }

  sendVerification(to: string, name: string, link: string) {
    return this.send(to, 'Verify your GbaanJo email', this.wrap(`<p>Hi ${esc(name)},</p><p>Please confirm your email address. This link works for 24 hours.</p>${this.button(link, 'Verify my email')}`), 'VERIFY LINK: ' + link);
  }

  sellerDecision(to: string, business: string, approved: boolean, reason?: string) {
    const body = approved
      ? `<p>Good news! <b>${esc(business)}</b> has been approved as a GbaanJo seller.</p><p>Log in to add your payout account, upload food photos and list your first deal.</p>${this.button(frontendUrl() + '/seller', 'Go to my shop')}`
      : `<p>We could not approve <b>${esc(business)}</b> yet.</p><p><b>Reason:</b> ${esc(reason || 'Please check your details')}</p><p>Log in, fix your details and resubmit your application.</p>${this.button(frontendUrl() + '/seller', 'Fix my application')}`;
    return this.send(to, approved ? 'Your GbaanJo seller application is approved' : 'Update on your GbaanJo seller application', this.wrap(body));
  }
}
