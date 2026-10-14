import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from './prisma.service';
import { RULES, restoreStock } from './common';
import { DEMO_DOMAIN } from './demo-data';

// Runs every 15 minutes (keeps a free serverless database able to sleep). Queries already filter by time, so this is the cleanup layer, not the only guard.
@Injectable()
export class ExpiryService {
  private log = new Logger('Expiry');
  constructor(private prisma: PrismaService) {}

  @Cron('*/15 * * * *')
  async sweep() {
    try {
      const now = new Date();
      // 1. Close listings whose sale window ended
      await this.prisma.listing.updateMany({ where: { status: 'ACTIVE', saleEndsAt: { lte: now } }, data: { status: 'EXPIRED' } });

      // 2. Unpaid holds: free the food if the buyer did not pay in time
      const cut = new Date(now.getTime() - RULES.HOLD_MINUTES * 60000);
      const stale = await this.prisma.order.findMany({ where: { status: 'PENDING_PAYMENT', createdAt: { lte: cut } }, include: { listing: true } });
      for (const o of stale) {
        await this.prisma.$transaction(async (tx) => {
          const r = await tx.order.updateMany({ where: { id: o.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
          if (r.count === 1) await restoreStock(tx, o);
        });
      }

      // 3. Paid reservations not collected by the pickup deadline = no-show. The seller keeps the money, stock is not restored.
      const late = await this.prisma.order.findMany({ where: { status: 'RESERVED', listing: { pickupBy: { lte: now }, seller: { email: { not: { endsWith: DEMO_DOMAIN } } } } }, select: { id: true, buyerId: true } });
      for (const o of late) {
        await this.prisma.$transaction(async (tx) => {
          const r = await tx.order.updateMany({ where: { id: o.id, status: 'RESERVED' }, data: { status: 'EXPIRED' } });
          if (r.count === 1) await tx.user.update({ where: { id: o.buyerId }, data: { noShows: { increment: 1 } } });
        });
      }
      // Orders on demo listings (test version) are closed quietly. They never count against the tester.
      await this.prisma.order.updateMany({ where: { status: 'RESERVED', listing: { pickupBy: { lte: now }, seller: { email: { endsWith: DEMO_DOMAIN } } } }, data: { status: 'EXPIRED' } });
    } catch (e) { this.log.error(e); }
  }
}
