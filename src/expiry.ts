import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer';
import { OpayService } from './payments';
import { OrdersService } from './orders';
import { releaseStaleHolds } from './common';
import { DEMO_DOMAIN } from './demo-data';

const full = { listing: { include: { seller: true } }, buyer: true } as const;

/**
 * The housekeeping that keeps nothing stuck. Runs every 5 minutes while the server is awake.
 * On Render's free plan the server sleeps after 15 minutes without visitors, so keep it awake with a free pinger (see DEPLOY.md).
 * Every query already filters by time, so this is the cleanup layer, not the only guard.
 */
@Injectable()
export class ExpiryService {
  private log = new Logger('Sweep');
  private running = false;
  constructor(private prisma: PrismaService, private mail: MailerService, private opay: OpayService, private orders: OrdersService) {}

  @Cron('*/5 * * * *')
  async sweep() {
    if (this.running) return; // never let two sweeps overlap
    this.running = true;
    try {
      await this.step('close ended listings', () => this.closeListings());
      await this.step('release unpaid holds', () => releaseStaleHolds(this.prisma));
      await this.step('check unconfirmed payments', () => this.reconcilePayments());
      await this.step('close missed pickups', () => this.missedPickups());
      await this.step('send pickup reminders', () => this.reminders());
    } finally { this.running = false; }
  }

  // One failing step must not stop the others
  private async step(name: string, fn: () => Promise<any>) {
    try { await fn(); } catch (e: any) { this.log.error(`Sweep step "${name}" failed: ${e?.message || e}`); }
  }

  private closeListings() {
    return this.prisma.listing.updateMany({ where: { status: 'ACTIVE', saleEndsAt: { lte: new Date() } }, data: { status: 'EXPIRED' } });
  }

  // OPay normally tells us when a payment succeeds. If the server was asleep or the notification was lost, this finds the payment anyway.
  private async reconcilePayments() {
    if (!this.opay.enabled) return;
    const since = new Date(Date.now() - 45 * 60000);
    const open = await this.prisma.order.findMany({
      where: { status: { in: ['PENDING_PAYMENT', 'CANCELLED'] }, paidAt: null, payUrl: { not: null }, createdAt: { gte: since, lte: new Date(Date.now() - 60000) } },
      select: { paymentRef: true }, take: 20, orderBy: { createdAt: 'asc' },
    });
    for (const o of open) {
      try { await this.orders.syncWithOpay(o.paymentRef); } catch (e: any) { this.log.warn(`Could not check ${o.paymentRef}: ${e?.message}`); }
    }
  }

  // Paid reservations not collected by the pickup deadline = no-show. The seller keeps the money, stock is not restored.
  private async missedPickups() {
    const now = new Date();
    const late = await this.prisma.order.findMany({
      where: { status: 'RESERVED', listing: { pickupBy: { lte: now }, seller: { email: { not: { endsWith: DEMO_DOMAIN } } } } },
      include: full, take: 100,
    });
    for (const o of late) {
      const moved = await this.prisma.$transaction(async (tx) => {
        const r = await tx.order.updateMany({ where: { id: o.id, status: 'RESERVED' }, data: { status: 'EXPIRED' } });
        if (r.count === 1) await tx.user.update({ where: { id: o.buyerId }, data: { noShows: { increment: 1 } } });
        return r.count === 1;
      });
      if (moved) {
        const d = { orderNo: o.orderNo, title: o.listing.title, quantity: o.quantity, amountPaid: o.amountPaid, buyerName: o.buyer.name, buyerEmail: o.buyer.email, business: o.listing.seller.businessName || o.listing.seller.name, sellerEmail: o.listing.seller.email };
        await this.mail.orderMissedBuyer(d);
        await this.mail.orderMissedSeller(d);
      }
    }
    // Orders on demo listings (test version) are closed quietly. They never count against the tester.
    await this.prisma.order.updateMany({ where: { status: 'RESERVED', listing: { pickupBy: { lte: now }, seller: { email: { endsWith: DEMO_DOMAIN } } } }, data: { status: 'EXPIRED' } });
  }

  // One reminder per order, about an hour before the pickup deadline
  private async reminders() {
    const now = new Date();
    const due = await this.prisma.order.findMany({
      where: { status: 'RESERVED', reminderSentAt: null, listing: { pickupBy: { gt: now, lte: new Date(now.getTime() + 60 * 60000) } } },
      include: full, take: 30,
    });
    for (const o of due) {
      const r = await this.prisma.order.updateMany({ where: { id: o.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
      if (r.count === 1) {
        await this.mail.pickupReminder({ orderNo: o.orderNo, title: o.listing.title, quantity: o.quantity, amountPaid: o.amountPaid, buyerName: o.buyer.name, buyerEmail: o.buyer.email, business: o.listing.seller.businessName || o.listing.seller.name, address: o.listing.address, area: o.listing.area, city: o.listing.city, pickupBy: o.listing.pickupBy, pickupCode: o.pickupCode });
      }
    }
  }
}
