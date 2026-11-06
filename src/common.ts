import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';

export const CATEGORIES = ['Cooked meals', 'Bakery', 'Fresh produce', 'Meat & fish', 'Dairy & drinks', 'Frozen foods', 'Snacks & small chops', 'Groceries'];

// Cities where GbaanJo is live. Lagos only for the pilot. To open another city later, set ACTIVE_CITIES="Lagos,Abuja" on the server. No code change needed.
export const CITIES = (process.env.ACTIVE_CITIES || 'Lagos').split(',').map((s) => s.trim()).filter(Boolean);
// Shown on the "notify me" list for people outside the live cities
export const COMING_SOON = ['Abuja', 'Port Harcourt', 'Ibadan', 'Kano', 'Enugu', 'Benin City', 'Kaduna', 'Warri', 'Owerri', 'Abeokuta', 'Jos', 'Other'].filter((c) => !CITIES.includes(c));

// Every business rule lives here so you can tune it in one place.
export const RULES = {
  MIN_DISCOUNT: 0.3,          // price must be at least 30% below original
  MIN_SALE_MINUTES: 15,       // a listing must stay open at least 15 min
  MAX_SALE_HOURS: 72,         // and at most 72 hours
  MAX_PICKUP_HOURS: 24,       // pickup deadline is at most 24h after sale ends
  MAX_ACTIVE_LISTINGS: 20,    // per seller
  MAX_PER_ORDER: 5,           // units per reservation
  MAX_OPEN_ORDERS: 3,         // open reservations per buyer
  MAX_NO_SHOWS: 3,            // buyers with 3 no-shows can't reserve
  PLATFORM_FEE_PERCENT: 10,   // GbaanJo's commission on every sale
  MIN_FEE: 50,                // minimum commission per order, in naira
  HOLD_MINUTES: 10,           // how long food is held while the buyer pays (the OPay payment link expires at the same time)
  HOLD_GRACE_MINUTES: 2,      // extra minutes before we release the food, so a payment in progress is not lost
  BUYER_SERVICE_FEE: 100,     // flat fee added to every order, in naira (set 0 to turn it off)
};

// GbaanJo's cut of an order total (naira). Never more than the order itself.
export const feeFor = (total: number) => Math.min(total, Math.max(RULES.MIN_FEE, Math.round((total * RULES.PLATFORM_FEE_PERCENT) / 100)));

const clean = (s: string) => s.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
// The first FRONTEND_URL entry without a * is the public address used in email links and payment redirects
export const frontendUrl = () => {
  const list = (process.env.FRONTEND_URL || '').split(',').map(clean).filter((s) => s && !s.includes('*'));
  return list[0] || 'http://localhost:5173';
};
// The public address of this server. OPay sends payment notifications here. Render sets RENDER_EXTERNAL_URL for you.
export const backendUrl = () => clean(process.env.BACKEND_URL || process.env.RENDER_EXTERNAL_URL || 'http://localhost:3000');

export const naira = (n: number) => '₦' + Number(n).toLocaleString('en-NG');
// Nigerian numbers are stored as 080... or +234... OPay wants +234...
export const intlPhone = (p: string) => (p.startsWith('+') ? p : '+234' + p.replace(/^0/, ''));
// Start of today in Lagos (UTC+1, no daylight saving), so "today" on the admin page matches the clock in Nigeria
export const lagosDayStart = () => {
  const lagosNow = new Date(Date.now() + 3600000);
  return new Date(Date.UTC(lagosNow.getUTCFullYear(), lagosNow.getUTCMonth(), lagosNow.getUTCDate()) - 3600000);
};

// An order whose buyer needs to be told it was cancelled
export type Affected = { id: string; orderNo: string; status: string; amountPaid: number; title: string; buyerName: string; buyerEmail: string; refund: boolean };

// Cancel every open order matching `where`. Paid ones are flagged so you refund them from the admin page.
// Returns who was affected so the caller can email them after the transaction commits.
export async function cancelOrders(tx: any, where: any): Promise<Affected[]> {
  const open = await tx.order.findMany({
    where: { ...where, status: { in: ['RESERVED', 'PENDING_PAYMENT'] } },
    select: { id: true, orderNo: true, status: true, amountPaid: true, buyer: { select: { name: true, email: true } }, listing: { select: { title: true } } },
  });
  await tx.order.updateMany({ where: { ...where, status: 'RESERVED' }, data: { status: 'CANCELLED', refundDue: true } });
  await tx.order.updateMany({ where: { ...where, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
  return open.map((o: any) => ({ id: o.id, orderNo: o.orderNo, status: o.status, amountPaid: o.amountPaid, title: o.listing.title, buyerName: o.buyer.name, buyerEmail: o.buyer.email, refund: o.status === 'RESERVED' }));
}

// Put an order's units back on sale, if the sale window is still open.
export async function restoreStock(tx: any, o: any) {
  const l = o.listing;
  if (['ACTIVE', 'SOLD_OUT'].includes(l.status) && l.saleEndsAt > new Date()) {
    await tx.listing.update({ where: { id: l.id }, data: { quantityLeft: { increment: o.quantity }, status: 'ACTIVE' } });
  }
}

// Free the food of buyers who started a payment and never finished. Used by the background sweep AND before every
// reservation, so a stale hold can never block a real buyer even if the server was asleep.
export async function releaseStaleHolds(prisma: PrismaService, listingId?: string) {
  const cut = new Date(Date.now() - (RULES.HOLD_MINUTES + RULES.HOLD_GRACE_MINUTES) * 60000);
  const stale = await prisma.order.findMany({ where: { status: 'PENDING_PAYMENT', createdAt: { lte: cut }, ...(listingId ? { listingId } : {}) }, include: { listing: true }, take: 100 });
  let released = 0;
  for (const o of stale) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.order.updateMany({ where: { id: o.id, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
      if (r.count === 1) { await restoreStock(tx, o); released++; }
    });
  }
  return released;
}

export const Roles = (...roles: string[]) => SetMetadata('roles', roles);
export const CurrentUser = createParamDecorator((_d, ctx: ExecutionContext) => ctx.switchToHttp().getRequest().user);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private jwt: JwtService, private reflector: Reflector, private prisma: PrismaService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    try { req.user = this.jwt.verify(token); } catch { throw new UnauthorizedException('Please log in'); }
    // Check the database on every request so a suspended user is locked out immediately
    const u = await this.prisma.user.findUnique({
      where: { id: req.user.sub },
      select: { role: true, suspended: true, passwordHash: true },
    });
    if (!u) throw new UnauthorizedException('Please log in again');
    if (u.suspended) throw new ForbiddenException('Your account is suspended. Please contact support.');

        // A login token is tied to the current password. Changing or resetting the password logs out every other device.
    if (req.user.ph !== u.passwordHash.slice(-12)) throw new UnauthorizedException('Please log in again');
    req.user.role = u.role;
    const roles = this.reflector.getAllAndOverride<string[]>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(u.role)) throw new ForbiddenException('Your account type cannot do this');
    return true;
  }
}
