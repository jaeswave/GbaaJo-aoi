import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Headers, HttpCode, Injectable, Logger, NotFoundException, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
import { PrismaService } from './prisma.service';
import { PaystackService } from './payments';
import { AuthGuard, CurrentUser, Roles, RULES, feeFor, frontendUrl, restoreStock } from './common';

export class ReserveDto {
  @IsString() listingId: string;
  @IsInt() @Min(1) @Max(RULES.MAX_PER_ORDER) quantity: number;
}
export class CompleteDto { @IsString() @Length(6, 6) code: string; }

const ORDER_NO_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so numbers are easy to read out
const makeOrderNo = () => 'GJ-' + Array.from(randomBytes(6), (b) => ORDER_NO_CHARS[b % ORDER_NO_CHARS.length]).join('');

const listingInfo = { select: { title: true, category: true, imageUrl: true, address: true, area: true, city: true, pickupBy: true, saleEndsAt: true, seller: { select: { businessName: true, phone: true } } } };

@Injectable()
export class OrdersService {
  private log = new Logger('Orders');
  constructor(private prisma: PrismaService, private paystack: PaystackService) {}

  /** Step 1: hold the food and create an unpaid order. Step 2: send the buyer to Paystack. */
  async reserve(buyerId: string, dto: ReserveDto) {
    const reference = 'gj_' + randomBytes(10).toString('hex');
    const { order, subaccount, email } = await this.prisma.$transaction(async (tx) => {
      const buyer = await tx.user.findUnique({ where: { id: buyerId } });
      if (!buyer) throw new ForbiddenException('Account not found');
      if (!buyer.emailVerifiedAt) throw new ForbiddenException('Please verify your email before ordering. Check your inbox for the link.');
      if (buyer.noShows >= RULES.MAX_NO_SHOWS) throw new ForbiddenException('Ordering is paused on your account after repeated no-shows. Contact support.');
      const open = await tx.order.count({ where: { buyerId, status: { in: ['PENDING_PAYMENT', 'RESERVED'] } } });
      if (open >= RULES.MAX_OPEN_ORDERS) throw new BadRequestException(`You can only hold ${RULES.MAX_OPEN_ORDERS} open orders at once`);
      const listing = await tx.listing.findUnique({ where: { id: dto.listingId }, include: { seller: { select: { subaccountCode: true, suspended: true, approvalStatus: true } } } });
      const now = new Date();
      if (!listing || listing.status !== 'ACTIVE' || listing.saleEndsAt <= now || listing.seller.suspended || listing.seller.approvalStatus !== 'APPROVED') throw new BadRequestException('This listing is no longer available');
      if (listing.sellerId === buyerId) throw new BadRequestException('You cannot order your own listing');
      if (this.paystack.enabled && !listing.seller.subaccountCode) throw new BadRequestException('This seller has not finished setting up payouts yet');
      if (await tx.order.count({ where: { buyerId, listingId: listing.id, status: { in: ['PENDING_PAYMENT', 'RESERVED'] } } })) throw new ConflictException('You already have an order for this listing');

      // One conditional UPDATE: two buyers can never take the last unit at the same time.
      const taken = await tx.listing.updateMany({
        where: { id: listing.id, status: 'ACTIVE', saleEndsAt: { gt: now }, quantityLeft: { gte: dto.quantity } },
        data: { quantityLeft: { decrement: dto.quantity } },
      });
      if (taken.count === 0) throw new ConflictException('Not enough left. Someone just got it.');
      const fresh = await tx.listing.findUnique({ where: { id: listing.id } });
      if (fresh.quantityLeft === 0) await tx.listing.update({ where: { id: listing.id }, data: { status: 'SOLD_OUT' } });

      // A pickup code is never reused by two open orders of the same seller
      let pickupCode = '';
      for (let i = 0; i < 10; i++) {
        pickupCode = String(randomInt(100000, 1000000));
        const clash = await tx.order.count({ where: { pickupCode, status: { in: ['PENDING_PAYMENT', 'RESERVED'] }, listing: { sellerId: listing.sellerId } } });
        if (!clash) break;
      }

      const food = listing.price * dto.quantity, commission = feeFor(food), buyerFee = RULES.BUYER_SERVICE_FEE;
      const order = await tx.order.create({
        data: { orderNo: makeOrderNo(), listingId: listing.id, buyerId, quantity: dto.quantity, totalPrice: food, buyerFee, amountPaid: food + buyerFee, platformFee: commission, sellerAmount: food - commission, pickupCode, paystackRef: reference },
        include: { listing: listingInfo },
      });
      return { order, subaccount: listing.seller.subaccountCode, email: buyer.email };
    });

    // Local test mode (no Paystack key): treat the order as paid straight away.
    if (!this.paystack.enabled) {
      await this.confirmPayment(reference, order.amountPaid * 100);
      return { order: await this.one(order.id), authorizationUrl: null };
    }
    try {
      const init = await this.paystack.initialize({
        email, amountKobo: order.amountPaid * 100, feeKobo: (order.platformFee + order.buyerFee) * 100, // GbaanJo keeps the seller commission + the buyer service fee
        reference, subaccount, callbackUrl: frontendUrl() + '/pay/callback', metadata: { orderId: order.id, orderNo: order.orderNo },
      });
      await this.prisma.order.update({ where: { id: order.id }, data: { payUrl: init.authorization_url } });
      return { order, authorizationUrl: init.authorization_url as string };
    } catch (e) { await this.release(order.id); throw e; }
  }

  /** Called by the Paystack webhook AND by the verify endpoint. Safe to run more than once. */
  async confirmPayment(reference: string, amountKobo: number) {
    const o = await this.prisma.order.findUnique({ where: { paystackRef: reference } });
    if (!o) return false;
    const expected = (o.amountPaid || o.totalPrice) * 100;
    if (amountKobo !== expected) { this.log.error(`Amount mismatch on ${reference}: got ${amountKobo}, expected ${expected}`); return false; }
    if (o.paidAt) return true;
    if (o.status === 'PENDING_PAYMENT') {
      await this.prisma.order.updateMany({ where: { id: o.id, status: 'PENDING_PAYMENT' }, data: { status: 'RESERVED', paidAt: new Date() } });
      return true;
    }
    // Money arrived after the hold was released (or the order was cancelled): flag it for a refund.
    await this.prisma.order.update({ where: { id: o.id }, data: { paidAt: new Date(), refundDue: true } });
    return true;
  }

  /** Buyer comes back from Paystack. We ask Paystack directly, so we never trust the browser. */
  async verify(buyerId: string, reference: string) {
    const o = await this.prisma.order.findFirst({ where: { paystackRef: reference, buyerId } });
    if (!o) throw new NotFoundException('Order not found');
    if (o.status === 'PENDING_PAYMENT' && this.paystack.enabled) {
      const data = await this.paystack.verify(reference);
      if (data.status === 'success') await this.confirmPayment(reference, data.amount);
    }
    const fresh = await this.prisma.order.findUnique({ where: { id: o.id } });
    return { status: fresh.status, refundDue: fresh.refundDue };
  }

  release(orderId: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.order.findUnique({ where: { id: orderId }, include: { listing: true } });
      if (!o) return;
      const r = await tx.order.updateMany({ where: { id: orderId, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
      if (r.count === 1) await restoreStock(tx, o);
    });
  }

  one(id: string) { return this.prisma.order.findUnique({ where: { id }, include: { listing: listingInfo } }); }

  async mine(buyerId: string) {
    const rows = await this.prisma.order.findMany({ where: { buyerId }, orderBy: { createdAt: 'desc' }, take: 50, include: { listing: listingInfo } });
    return rows.map((o) => ({ ...o, pickupCode: ['RESERVED', 'PICKED_UP'].includes(o.status) ? o.pickupCode : null }));
  }

  cancel(buyerId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const o = await tx.order.findUnique({ where: { id }, include: { listing: true } });
      if (!o || o.buyerId !== buyerId) throw new NotFoundException('Order not found');
      if (o.status === 'PENDING_PAYMENT') {
        const r = await tx.order.updateMany({ where: { id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
        if (r.count === 1) await restoreStock(tx, o);
        return { ok: true, refund: false };
      }
      if (o.status !== 'RESERVED') throw new BadRequestException('This order can no longer be cancelled');
      if (o.listing.saleEndsAt <= new Date()) throw new BadRequestException('The sale has ended, so this order can no longer be cancelled. If you cannot collect it, send someone with your code or contact the seller.');
      const r = await tx.order.updateMany({ where: { id, status: 'RESERVED' }, data: { status: 'CANCELLED', refundDue: true } });
      if (r.count === 0) throw new BadRequestException('This order can no longer be cancelled');
      await restoreStock(tx, o);
      return { ok: true, refund: true };
    });
  }

  sellerOrders(sellerId: string) {
    return this.prisma.order.findMany({
      where: { listing: { sellerId }, status: { not: 'PENDING_PAYMENT' } }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, orderNo: true, quantity: true, totalPrice: true, sellerAmount: true, status: true, createdAt: true, buyer: { select: { name: true } }, listing: { select: { title: true, pickupBy: true } } },
    });
  }

  // Seller types the pickup code. Whoever holds the code is allowed to collect, so we do not check who is standing there.
  async lookup(sellerId: string, code: string) {
    const o = await this.prisma.order.findFirst({
      where: { pickupCode: code, status: 'RESERVED', listing: { sellerId, pickupBy: { gt: new Date() } } },
      select: { id: true, orderNo: true, quantity: true, buyer: { select: { name: true } }, listing: { select: { title: true } } },
    });
    if (!o) throw new BadRequestException('No paid order matches that code. Check the digits and the pickup time.');
    return { id: o.id, orderNo: o.orderNo, quantity: o.quantity, title: o.listing.title, buyerName: o.buyer.name };
  }

  async complete(sellerId: string, id: string, code: string) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { listing: true } });
    if (!o || o.listing.sellerId !== sellerId) throw new NotFoundException('Order not found');
    if (o.status !== 'RESERVED') throw new BadRequestException(`This order is ${o.status.toLowerCase().replace('_', ' ')}, so it cannot be handed over`);
    if (o.listing.pickupBy <= new Date()) throw new BadRequestException('The pickup window has closed');
    if (o.pickupCode !== code) throw new BadRequestException('Wrong pickup code');
    const res = await this.prisma.order.updateMany({ where: { id, status: 'RESERVED' }, data: { status: 'PICKED_UP' } });
    if (res.count === 0) throw new ConflictException('Order was just updated. Refresh and try again.');
    return { ok: true };
  }
}

@Controller('orders')
@UseGuards(AuthGuard)
export class OrdersController {
  constructor(private svc: OrdersService) {}
  @Roles('BUYER') @Post() reserve(@CurrentUser() u: any, @Body() dto: ReserveDto) { return this.svc.reserve(u.sub, dto); }
  @Roles('BUYER') @Get('mine') mine(@CurrentUser() u: any) { return this.svc.mine(u.sub); }
  @Roles('BUYER') @Get('verify/:reference') verify(@CurrentUser() u: any, @Param('reference') ref: string) { return this.svc.verify(u.sub, ref); }
  @Roles('BUYER') @Patch(':id/cancel') cancel(@CurrentUser() u: any, @Param('id') id: string) { return this.svc.cancel(u.sub, id); }
  @Roles('SELLER') @Get('seller') seller(@CurrentUser() u: any) { return this.svc.sellerOrders(u.sub); }
  @Roles('SELLER') @Throttle({ default: { limit: 15, ttl: 60000 } }) @Post('lookup') lookup(@CurrentUser() u: any, @Body() dto: CompleteDto) { return this.svc.lookup(u.sub, dto.code); }
  @Roles('SELLER') @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post(':id/complete')
  complete(@CurrentUser() u: any, @Param('id') id: string, @Body() dto: CompleteDto) { return this.svc.complete(u.sub, id, dto.code); }
}

/** Paystack calls this URL after every payment. We check the signature so nobody can fake a payment. */
@Controller('payments')
export class PaymentsController {
  constructor(private orders: OrdersService) {}
  @SkipThrottle() @Post('webhook') @HttpCode(200)
  async webhook(@Req() req: any, @Headers('x-paystack-signature') sig: string) {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key || !req.rawBody || !sig) throw new ForbiddenException();
    const expected = Buffer.from(createHmac('sha512', key).update(req.rawBody).digest('hex'));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) throw new ForbiddenException();
    const evt = JSON.parse(req.rawBody.toString());
    if (evt.event === 'charge.success') await this.orders.confirmPayment(evt.data.reference, evt.data.amount);
    return { ok: true };
  }
}
