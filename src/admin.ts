import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApprovalStatus } from '@prisma/client';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer';
import { AuthGuard, Roles, cancelOrders, lagosDayStart, restoreStock } from './common';
import { DEMO_DOMAIN } from './demo-data';

export class FlagDto { @IsBoolean() value: boolean; }
export class ReviewDto {
  @IsBoolean() approve: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}
export class MarkPaidDto { @IsArray() @ArrayNotEmpty() @ArrayMaxSize(300) @IsString({ each: true }) orderIds: string[]; }
export class FeedbackStatusDto { @IsIn(['NEW', 'SEEN', 'DONE']) status: string; }

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService, private mail: MailerService) {}

  async overview() {
    const start = lagosDayStart();
    const paid = { paidAt: { not: null }, refundedAt: null, refundDue: false } as any;
    const [buyers, sellers, activeListings, ordersToday, pickedUp, noShows, suspended, money, refundsPending, pendingApps, feedbackNew, waitlist] = await Promise.all([
      this.prisma.user.count({ where: { role: 'BUYER' } }),
      this.prisma.user.count({ where: { role: 'SELLER', approvalStatus: 'APPROVED' } }),
      this.prisma.listing.count({ where: { status: 'ACTIVE', saleEndsAt: { gt: new Date() } } }),
      this.prisma.order.count({ where: { createdAt: { gte: start }, paidAt: { not: null } } }),
      this.prisma.order.count({ where: { status: 'PICKED_UP' } }),
      this.prisma.order.count({ where: { status: 'EXPIRED' } }),
      this.prisma.user.count({ where: { suspended: true } }),
      this.prisma.order.aggregate({ where: paid, _sum: { amountPaid: true, platformFee: true, buyerFee: true } }),
      this.prisma.order.count({ where: { refundDue: true, refundedAt: null } }),
      this.prisma.user.count({ where: { role: 'SELLER', approvalStatus: 'PENDING' } }),
      this.prisma.feedback.count({ where: { status: 'NEW' } }),
      this.prisma.waitlist.count(),
    ]);
    const s = money._sum;
    return { buyers, sellers, activeListings, ordersToday, pickedUp, noShows, suspended, sales: s.amountPaid || 0, fees: (s.platformFee || 0) + (s.buyerFee || 0), refundsPending, pendingApps, feedbackNew, waitlist };
  }

  applications(status: ApprovalStatus = 'PENDING') {
    return this.prisma.user.findMany({
      where: { role: 'SELLER', approvalStatus: status },
      orderBy: { createdAt: 'asc' }, take: 100,
      select: { id: true, name: true, email: true, phone: true, businessName: true, rcNumber: true, emailVerifiedAt: true, approvalStatus: true, rejectionReason: true, createdAt: true },
    });
  }

  async review(id: string, approve: boolean, reason?: string) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.role !== 'SELLER') throw new NotFoundException('Seller not found');
    if (approve && !u.emailVerifiedAt) throw new BadRequestException('This seller has not verified their email yet');
    if (!approve && !reason?.trim()) throw new BadRequestException('Give a reason so the seller knows what to fix');
    await this.prisma.user.update({
      where: { id },
      data: { approvalStatus: approve ? 'APPROVED' : 'REJECTED', rejectionReason: approve ? null : reason.trim(), verified: approve, reviewedAt: new Date() },
    });
    await this.mail.sellerDecision(u.email, u.businessName || u.name, approve, reason);
    return { ok: true };
  }

  users(role?: string, q?: string) {
    const term = q ? String(q).slice(0, 50) : '';
    return this.prisma.user.findMany({
      where: {
        role: (role === 'BUYER' || role === 'SELLER' ? role : { not: 'ADMIN' }) as any,
        ...(term ? { OR: [
          { name: { contains: term, mode: 'insensitive' as const } },
          { email: { contains: term, mode: 'insensitive' as const } },
          { businessName: { contains: term, mode: 'insensitive' as const } },
        ] } : {}),
      },
      orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, name: true, email: true, phone: true, city: true, role: true, businessName: true, rcNumber: true, approvalStatus: true, noShows: true, suspended: true, verified: true, createdAt: true, accountName: true, bankName: true },
    });
  }

  async suspend(id: string, value: boolean) {
    const out = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id } });
      if (!u) throw new NotFoundException('User not found');
      if (u.role === 'ADMIN') throw new BadRequestException('Admins cannot be suspended');
      await tx.user.update({ where: { id }, data: { suspended: value } });
      let affected: Awaited<ReturnType<typeof cancelOrders>> = [];
      if (value && u.role === 'SELLER') {
        affected = await cancelOrders(tx, { listing: { sellerId: id } });
        await tx.listing.updateMany({ where: { sellerId: id, status: { in: ['ACTIVE', 'SOLD_OUT'] } }, data: { status: 'CANCELLED' } });
      }
      if (value && u.role === 'BUYER') {
        const open = await tx.order.findMany({ where: { buyerId: id, status: { in: ['PENDING_PAYMENT', 'RESERVED'] } }, include: { listing: true } });
        for (const o of open) {
          await tx.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', refundDue: o.status === 'RESERVED' } });
          await restoreStock(tx, o);
        }
      }
      return { affected };
    });
    for (const o of out.affected) void this.mail.orderCancelledBuyer({ orderNo: o.orderNo, title: o.title, buyerName: o.buyerName, buyerEmail: o.buyerEmail, amountPaid: o.amountPaid }, o.refund, 'The seller is no longer available on GbaanJo.');
    return { ok: true };
  }

  async verify(id: string, value: boolean) {
    const u = await this.prisma.user.findUnique({ where: { id } });
    if (!u || u.role !== 'SELLER') throw new NotFoundException('Seller not found');
    await this.prisma.user.update({ where: { id }, data: { verified: value } });
    return { ok: true };
  }

  async resetNoShows(id: string) {
    await this.prisma.user.update({ where: { id }, data: { noShows: 0 } }).catch(() => { throw new NotFoundException('User not found'); });
    return { ok: true };
  }

  listings(status?: string) {
    return this.prisma.listing.findMany({
      where: status ? { status: status as any } : {}, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, title: true, category: true, city: true, area: true, address: true, price: true, originalPrice: true, quantity: true, quantityLeft: true, status: true, saleEndsAt: true, seller: { select: { businessName: true, phone: true, verified: true } } },
    });
  }

  async removeListing(id: string) {
    const { affected, l } = await this.prisma.$transaction(async (tx) => {
      const l = await tx.listing.findUnique({ where: { id }, include: { seller: { select: { email: true, businessName: true, name: true } } } });
      if (!l) throw new NotFoundException('Listing not found');
      const affected = await cancelOrders(tx, { listingId: id });
      await tx.listing.update({ where: { id }, data: { status: 'CANCELLED' } });
      return { affected, l };
    });
    for (const o of affected) void this.mail.orderCancelledBuyer({ orderNo: o.orderNo, title: o.title, buyerName: o.buyerName, buyerEmail: o.buyerEmail, amountPaid: o.amountPaid }, o.refund, 'This listing was removed by GbaanJo.');
    void this.mail.listingCancelledSeller(l.seller.email, l.seller.businessName || l.seller.name, l.title, 'It did not meet our listing rules. Reply to this email if you think this was a mistake.');
    return { ok: true };
  }

  refunds() {
    return this.prisma.order.findMany({
      where: { refundDue: true, refundedAt: null }, orderBy: { createdAt: 'asc' }, take: 100,
      select: { id: true, orderNo: true, totalPrice: true, amountPaid: true, paymentRef: true, opayOrderNo: true, createdAt: true, buyer: { select: { name: true, email: true, phone: true } }, listing: { select: { title: true, seller: { select: { businessName: true } } } } },
    });
  }

  async markRefunded(id: string) {
    const o = await this.prisma.order.findFirst({ where: { id, refundDue: true, refundedAt: null }, include: { buyer: true, listing: true } });
    const r = await this.prisma.order.updateMany({ where: { id, refundDue: true, refundedAt: null }, data: { refundDue: false, refundedAt: new Date() } });
    if (r.count === 0 || !o) throw new NotFoundException('No pending refund for this order');
    void this.mail.refundSent({ orderNo: o.orderNo, title: o.listing.title, buyerName: o.buyer.name, buyerEmail: o.buyer.email, amountPaid: o.amountPaid });
    return { ok: true };
  }

  /**
   * What GbaanJo owes each seller. OPay pays everything to GbaanJo, so sellers are paid by bank transfer after the handover.
   * An order counts once the food was handed over, or the buyer missed the pickup (the seller keeps the money).
   * Refunded orders never count.
   */
  async payouts() {
    const rows = await this.prisma.order.findMany({
      where: { status: { in: ['PICKED_UP', 'EXPIRED'] }, paidAt: { not: null }, paidOutAt: null, refundDue: false, refundedAt: null, listing: { seller: { email: { not: { endsWith: DEMO_DOMAIN } } } } },
      select: { id: true, sellerAmount: true, listing: { select: { seller: { select: { id: true, businessName: true, name: true, bankName: true, accountName: true, accountNumber: true } } } } },
      orderBy: { createdAt: 'asc' }, take: 1000,
    });
    const bySeller = new Map<string, any>();
    for (const o of rows) {
      const s = o.listing.seller;
      const r = bySeller.get(s.id) || { sellerId: s.id, businessName: s.businessName || s.name, bankName: s.bankName || 'NO BANK DETAILS YET', accountName: s.accountName || '', accountNumber: s.accountNumber || '', owed: 0, orderIds: [] as string[] };
      r.owed += o.sellerAmount; r.orderIds.push(o.id);
      bySeller.set(s.id, r);
    }
    return [...bySeller.values()].sort((a, b) => b.owed - a.owed);
  }

  async markPaid(orderIds: string[]) {
    const orders = await this.prisma.order.findMany({
      where: { id: { in: orderIds }, status: { in: ['PICKED_UP', 'EXPIRED'] }, paidOutAt: null, refundDue: false },
      select: { id: true, sellerAmount: true, listing: { select: { seller: { select: { id: true, email: true, businessName: true, name: true, bankName: true, accountNumber: true } } } } },
    });
    if (!orders.length) throw new BadRequestException('Nothing to mark as paid. These orders may already be paid out.');
    // updateMany with the same filter, so an order can never be marked paid twice even if two admins click at once
    const r = await this.prisma.order.updateMany({ where: { id: { in: orders.map((o) => o.id) }, paidOutAt: null }, data: { paidOutAt: new Date() } });
    const bySeller = new Map<string, { seller: any; amount: number; n: number }>();
    for (const o of orders) {
      const s = o.listing.seller;
      const e = bySeller.get(s.id) || { seller: s, amount: 0, n: 0 };
      e.amount += o.sellerAmount; e.n++;
      bySeller.set(s.id, e);
    }
    for (const { seller, amount, n } of bySeller.values()) {
      void this.mail.payoutSent(seller.email, seller.businessName || seller.name, amount, n, seller.bankName || 'your bank', (seller.accountNumber || '').slice(-4));
    }
    return { ok: true, count: r.count };
  }

  feedback(status?: string) {
    return this.prisma.feedback.findMany({
      where: status ? { status } : {}, orderBy: { createdAt: 'desc' }, take: 200,
      select: { id: true, category: true, rating: true, message: true, name: true, email: true, page: true, status: true, createdAt: true, user: { select: { name: true, email: true, role: true } } },
    });
  }
  async setFeedbackStatus(id: string, status: string) {
    await this.prisma.feedback.update({ where: { id }, data: { status } }).catch(() => { throw new NotFoundException('Feedback not found'); });
    return { ok: true };
  }
}

@Controller('admin')
@UseGuards(AuthGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private svc: AdminService) {}
  @Get('overview') overview() { return this.svc.overview(); }
  @Get('applications') applications(@Query('status') status?: string) { return this.svc.applications((['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? status : 'PENDING') as ApprovalStatus); }
  @Patch('applications/:id') review(@Param('id') id: string, @Body() dto: ReviewDto) { return this.svc.review(id, dto.approve, dto.reason); }
  @Get('users') users(@Query('role') role?: string, @Query('q') q?: string) { return this.svc.users(role, q); }
  @Patch('users/:id/suspend') suspend(@Param('id') id: string, @Body() dto: FlagDto) { return this.svc.suspend(id, dto.value); }
  @Patch('users/:id/verify') verify(@Param('id') id: string, @Body() dto: FlagDto) { return this.svc.verify(id, dto.value); }
  @Patch('users/:id/reset-noshows') reset(@Param('id') id: string) { return this.svc.resetNoShows(id); }
  @Get('listings') listings(@Query('status') status?: string) { return this.svc.listings(status); }
  @Patch('listings/:id/remove') remove(@Param('id') id: string) { return this.svc.removeListing(id); }
  @Get('refunds') refunds() { return this.svc.refunds(); }
  @Patch('orders/:id/refunded') refunded(@Param('id') id: string) { return this.svc.markRefunded(id); }
  @Get('payouts') payouts() { return this.svc.payouts(); }
  @Post('payouts/mark-paid') markPaid(@Body() dto: MarkPaidDto) { return this.svc.markPaid(dto.orderIds); }
  @Get('feedback') feedback(@Query('status') status?: string) { return this.svc.feedback(status); }
  @Patch('feedback/:id') feedbackStatus(@Param('id') id: string, @Body() dto: FeedbackStatusDto) { return this.svc.setFeedbackStatus(id, dto.status); }
}
