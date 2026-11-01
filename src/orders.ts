import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Injectable, Logger, NotFoundException, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { IsInt, IsString, Length, Max, Min } from 'class-validator';
import { randomBytes, randomInt } from 'crypto';
import { PrismaService } from './prisma.service';
import { OpayService } from './payments';
import { MailerService, OrderMail } from './mailer';
import { AuthGuard, CurrentUser, Roles, RULES, backendUrl, feeFor, frontendUrl, intlPhone, releaseStaleHolds, restoreStock } from './common';

export class ReserveDto {
  @IsString() listingId: string;
  @IsInt() @Min(1) @Max(RULES.MAX_PER_ORDER) quantity: number;
}
export class CompleteDto { @IsString() @Length(6, 6) code: string; }

const ORDER_NO_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I so numbers are easy to read out
const makeOrderNo = () => 'GJ-' + Array.from(randomBytes(6), (b) => ORDER_NO_CHARS[b % ORDER_NO_CHARS.length]).join('');

const listingInfo = { select: { title: true, category: true, imageUrl: true, address: true, area: true, city: true, pickupBy: true, saleEndsAt: true, seller: { select: { businessName: true, phone: true } } } };
// Everything the emails need about an order
const full = { listing: { include: { seller: true } }, buyer: true } as const;

@Injectable()
export class OrdersService {
  private log = new Logger('Orders');
  constructor(private prisma: PrismaService, private opay: OpayService, private mail: MailerService) {}

  private mailData(o: any): OrderMail {
    return {
      orderNo: o.orderNo, title: o.listing.title, quantity: o.quantity, amountPaid: o.amountPaid,
      buyerName: o.buyer.name, buyerEmail: o.buyer.email,
      business: o.listing.seller.businessName || o.listing.seller.name, sellerEmail: o.listing.seller.email, sellerPhone: o.listing.seller.phone,
      address: o.listing.address, area: o.listing.area, city: o.listing.city, pickupBy: o.listing.pickupBy, pickupCode: o.pickupCode,
    };
  }

  /**
   * What a buyer is allowed to see. The pickup code, the street address and the seller's phone only appear once the order is PAID,
   * so nobody can start a reservation just to read the address.
   */
  private view(o: any) {
    const paid = o.status === 'RESERVED' || o.status === 'PICKED_UP';
    const l = o.listing;
    return {
      id: o.id, orderNo: o.orderNo, status: o.status, quantity: o.quantity, totalPrice: o.totalPrice, buyerFee: o.buyerFee, amountPaid: o.amountPaid,
      createdAt: o.createdAt, paidAt: o.paidAt, refundDue: o.refundDue, refundedAt: o.refundedAt,
      payUrl: o.status === 'PENDING_PAYMENT' ? o.payUrl : null,
      pickupCode: paid ? o.pickupCode : null,
      listing: {
        title: l.title, category: l.category, imageUrl: l.imageUrl, area: l.area, city: l.city, pickupBy: l.pickupBy, saleEndsAt: l.saleEndsAt,
        address: paid ? l.address : null,
        seller: { businessName: l.seller.businessName, phone: paid ? l.seller.phone : null },
      },
    };
  }

  /** Step 1: hold the food and create an unpaid order. Step 2: send the buyer to the OPay payment page. */
  async reserve(buyerId: string, dto: ReserveDto) {
    const reference = 'gj_' + randomBytes(10).toString('hex');
    // Free any expired holds on this listing first, so a stale hold can never block a real buyer
    await releaseStaleHolds(this.prisma, dto.listingId).catch((e) => this.log.error(e));

    const { order, buyer } = await this.prisma.$transaction(async (tx) => {
      const buyer = await tx.user.findUnique({ where: { id: buyerId } });
      if (!buyer) throw new ForbiddenException('Account not found');
      if (!buyer.emailVerifiedAt) throw new ForbiddenException('Please verify your email before ordering. Check your inbox for the link.');
      if (buyer.noShows >= RULES.MAX_NO_SHOWS) throw new ForbiddenException('Ordering is paused on your account after repeated no-shows. Contact support.');
      const open = await tx.order.count({ where: { buyerId, status: { in: ['PENDING_PAYMENT', 'RESERVED'] } } });
      if (open >= RULES.MAX_OPEN_ORDERS) throw new BadRequestException(`You can only hold ${RULES.MAX_OPEN_ORDERS} open orders at once`);
      const listing = await tx.listing.findUnique({ where: { id: dto.listingId }, include: { seller: { select: { accountNumber: true, suspended: true, approvalStatus: true } } } });
      const now = new Date();
      if (!listing || listing.status !== 'ACTIVE' || listing.saleEndsAt <= now || listing.seller.suspended || listing.seller.approvalStatus !== 'APPROVED') throw new BadRequestException('This listing is no longer available');
      if (listing.sellerId === buyerId) throw new BadRequestException('You cannot order your own listing');
      if (this.opay.enabled && !listing.seller.accountNumber) throw new BadRequestException('This seller has not finished setting up payouts yet');
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
        data: { orderNo: makeOrderNo(), listingId: listing.id, buyerId, quantity: dto.quantity, totalPrice: food, buyerFee, amountPaid: food + buyerFee, platformFee: commission, sellerAmount: food - commission, pickupCode, paymentRef: reference },
        include: { listing: listingInfo },
      });
      return { order, buyer };
    });

    // Local test mode (no OPay keys): treat the order as paid straight away.
    if (!this.opay.enabled) {
      await this.confirmPayment(reference, order.amountPaid * 100);
      const paid = await this.prisma.order.findUnique({ where: { id: order.id }, include: { listing: listingInfo } });
      return { order: this.view(paid), authorizationUrl: null };
    }

    try {
      const init = await this.opay.createCashier({
        reference,
        amountKobo: order.amountPaid * 100,
        returnUrl: `${frontendUrl()}/pay/callback?reference=${reference}`,
        cancelUrl: `${frontendUrl()}/orders`,
        callbackUrl: `${backendUrl()}/payments/opay/callback`,
        expireMinutes: RULES.HOLD_MINUTES, // the payment link dies when our hold on the food does
        user: { id: buyer.id, name: buyer.name, email: buyer.email, phone: intlPhone(buyer.phone) },
        product: { name: order.listing.title.slice(0, 100), description: `${order.quantity} x ${order.listing.title} from ${order.listing.seller.businessName}`.slice(0, 200) },
      });
      await this.prisma.order.update({ where: { id: order.id }, data: { payUrl: init.cashierUrl, opayOrderNo: init.orderNo } });
      return { order: this.view({ ...order, payUrl: init.cashierUrl }), authorizationUrl: init.cashierUrl };
    } catch (e) { await this.release(order.id); throw e; }
  }

  /**
   * Marks an order as paid. Called after we have confirmed with OPay that the money really arrived. Safe to run more than once.
   * paidKobo is what OPay says was paid. It must match exactly what we asked for.
   */
  async confirmPayment(reference: string, paidKobo: number, opayOrderNo?: string) {
    const o = await this.prisma.order.findUnique({ where: { paymentRef: reference }, include: full });
    if (!o) return false;
    const expected = o.amountPaid * 100;
    if (paidKobo !== expected) {
      this.log.error(`Amount mismatch on ${reference}: got ${paidKobo}, expected ${expected}`);
      void this.mail.adminAlert('Payment amount mismatch', `Order ${o.orderNo} (${reference}) was paid with an unexpected amount: ${paidKobo} kobo instead of ${expected}. Check it in the OPay dashboard.`);
      return false;
    }
    if (o.paidAt) return true;

    if (o.status === 'PENDING_PAYMENT') {
      const r = await this.prisma.order.updateMany({ where: { id: o.id, status: 'PENDING_PAYMENT', paidAt: null }, data: { status: 'RESERVED', paidAt: new Date(), ...(opayOrderNo ? { opayOrderNo } : {}) } });
      if (r.count === 1) {
        const data = this.mailData(o);
        void this.mail.orderPaidBuyer(data);
        void this.mail.newOrderSeller(data);
      }
      return true;
    }

    // Money arrived after the hold was released (or the order was cancelled): flag it for a refund and tell the buyer.
    const r = await this.prisma.order.updateMany({ where: { id: o.id, paidAt: null }, data: { paidAt: new Date(), refundDue: true, ...(opayOrderNo ? { opayOrderNo } : {}) } });
    if (r.count === 1) {
      void this.mail.orderCancelledBuyer(this.mailData(o), true, 'Your payment arrived after the hold on the food had expired, so we could not keep it for you.');
      void this.mail.adminAlert('Late payment to refund', `Order ${o.orderNo} was paid after its hold expired. It is on the Refunds list.`);
    }
    return true;
  }

  /** Ask OPay what happened to a payment and act on it. Used by the notification, the return page and the background sweep. */
  async syncWithOpay(reference: string) {
    const s = await this.opay.status(reference);
    if (!s) return null;
    if (s.status === 'SUCCESS') await this.confirmPayment(reference, s.amountKobo, s.orderNo);
    else if (s.status === 'CLOSE') {
      // The payment page expired or was closed, so free the food now instead of waiting for the sweep
      const o = await this.prisma.order.findUnique({ where: { paymentRef: reference }, select: { id: true } });
      if (o) await this.release(o.id);
    }
    return s.status;
  }

  /** Buyer comes back from OPay. We ask OPay directly, so we never trust the browser. */
  async verify(buyerId: string, reference: string) {
    const o = await this.prisma.order.findFirst({ where: { paymentRef: reference, buyerId } });
    if (!o) throw new NotFoundException('Order not found');
    if (o.status === 'PENDING_PAYMENT' && this.opay.enabled) {
      try { await this.syncWithOpay(reference); } catch (e: any) { this.log.warn(`verify ${reference}: ${e?.message}`); }
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

  async one(id: string) {
    const o = await this.prisma.order.findUnique({ where: { id }, include: { listing: listingInfo } });
    return o ? this.view(o) : null;
  }

  async mine(buyerId: string) {
    const rows = await this.prisma.order.findMany({ where: { buyerId }, orderBy: { createdAt: 'desc' }, take: 50, include: { listing: listingInfo } });
    return rows.map((o) => this.view(o));
  }

  async cancel(buyerId: string, id: string) {
    const out = await this.prisma.$transaction(async (tx) => {
      const o = await tx.order.findUnique({ where: { id }, include: full });
      if (!o || o.buyerId !== buyerId) throw new NotFoundException('Order not found');
      if (o.status === 'PENDING_PAYMENT') {
        const r = await tx.order.updateMany({ where: { id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
        if (r.count === 1) await restoreStock(tx, o);
        return { refund: false, o: null };
      }
      if (o.status !== 'RESERVED') throw new BadRequestException('This order can no longer be cancelled');
      if (o.listing.saleEndsAt <= new Date()) throw new BadRequestException('The sale has ended, so this order can no longer be cancelled. If you cannot collect it, send someone with your code or contact the seller.');
      const r = await tx.order.updateMany({ where: { id, status: 'RESERVED' }, data: { status: 'CANCELLED', refundDue: true } });
      if (r.count === 0) throw new BadRequestException('This order can no longer be cancelled');
      await restoreStock(tx, o);
      return { refund: true, o };
    });
    if (out.o) {
      const data = this.mailData(out.o);
      void this.mail.orderCancelledBuyer(data, true, 'You cancelled it.');
      void this.mail.orderCancelledSeller(data, 'The customer cancelled it.');
      void this.mail.adminAlert('Refund to process', `Order ${out.o.orderNo} was cancelled by the buyer and needs a refund of ₦${out.o.amountPaid.toLocaleString('en-NG')}.`);
    }
    return { ok: true, refund: out.refund };
  }

  sellerOrders(sellerId: string) {
    return this.prisma.order.findMany({
      where: { listing: { sellerId }, status: { not: 'PENDING_PAYMENT' } }, orderBy: { createdAt: 'desc' }, take: 100,
      select: { id: true, orderNo: true, quantity: true, totalPrice: true, sellerAmount: true, status: true, createdAt: true, paidOutAt: true, buyer: { select: { name: true } }, listing: { select: { title: true, pickupBy: true } } },
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
    const o = await this.prisma.order.findUnique({ where: { id }, include: full });
    if (!o || o.listing.sellerId !== sellerId) throw new NotFoundException('Order not found');
    if (o.status !== 'RESERVED') throw new BadRequestException(`This order is ${o.status.toLowerCase().replace('_', ' ')}, so it cannot be handed over`);
    if (o.listing.pickupBy <= new Date()) throw new BadRequestException('The pickup window has closed');
    if (o.pickupCode !== code) throw new BadRequestException('Wrong pickup code');
    const res = await this.prisma.order.updateMany({ where: { id, status: 'RESERVED' }, data: { status: 'PICKED_UP' } });
    if (res.count === 0) throw new ConflictException('Order was just updated. Refresh and try again.');
    void this.mail.pickedUpBuyer(this.mailData(o));
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

/**
 * OPay calls this URL when a payment changes (set the same address as "Webhook URL" in the OPay dashboard).
 * We check the signature, then ask OPay's status API to confirm, so a forged request can never mark an order as paid.
 * We answer 200 once handled. Any other answer makes OPay retry for 72 hours (which is what we want if our database is down).
 */
@Controller('payments')
export class PaymentsController {
  private log = new Logger('OpayCallback');
  constructor(private orders: OrdersService, private opay: OpayService) {}

  @SkipThrottle() @Post('opay/callback') @HttpCode(200)
  async callback(@Body() body: any) {
    if (!this.opay.enabled || !this.opay.verifyCallback(body)) throw new ForbiddenException();
    const p = body.payload;
    if (body.type !== 'transaction-status' || p.refunded === true || p.refunded === 'true') return { ok: true }; // refund notices need nothing from us
    this.log.log(`OPay says ${p.reference} is ${p.status}`);
    await this.orders.syncWithOpay(String(p.reference));
    return { ok: true };
  }
}
