import { CanActivate, createParamDecorator, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from './prisma.service';

export const CATEGORIES = ['Cooked meals', 'Bakery', 'Fresh produce', 'Meat & fish', 'Dairy & drinks', 'Frozen foods', 'Snacks & small chops', 'Groceries'];
export const CITIES = ['Lagos', 'Abuja', 'Port Harcourt', 'Ibadan', 'Kano', 'Enugu', 'Benin City', 'Kaduna', 'Warri', 'Owerri', 'Abeokuta', 'Jos'];

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
  PLATFORM_FEE_PERCENT: 10,   // ChopNow's commission on every sale
  MIN_FEE: 50,                // minimum commission per order, in naira
  HOLD_MINUTES: 10,           // how long food is held while the buyer pays
  BUYER_SERVICE_FEE: 100,     // flat fee added to every order, in naira (set 0 to turn it off)
};

// ChopNow's cut of an order total (naira). Never more than the order itself.
export const feeFor = (total: number) => Math.min(total, Math.max(RULES.MIN_FEE, Math.round((total * RULES.PLATFORM_FEE_PERCENT) / 100)));

export const frontendUrl = () => (process.env.FRONTEND_URL || 'http://localhost:5173').split(',')[0].trim();

// Cancel every open order matching `where`. Paid ones are flagged so you refund them from the admin page.
export async function cancelOrders(tx: any, where: any) {
  await tx.order.updateMany({ where: { ...where, status: 'RESERVED' }, data: { status: 'CANCELLED', refundDue: true } });
  await tx.order.updateMany({ where: { ...where, status: 'PENDING_PAYMENT' }, data: { status: 'CANCELLED' } });
}

// Put an order's units back on sale, if the sale window is still open.
export async function restoreStock(tx: any, o: any) {
  const l = o.listing;
  if (['ACTIVE', 'SOLD_OUT'].includes(l.status) && l.saleEndsAt > new Date()) {
    await tx.listing.update({ where: { id: l.id }, data: { quantityLeft: { increment: o.quantity }, status: 'ACTIVE' } });
  }
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
    const u = await this.prisma.user.findUnique({ where: { id: req.user.sub }, select: { role: true, suspended: true } });
    if (!u) throw new UnauthorizedException('Please log in again');
    if (u.suspended) throw new ForbiddenException('Your account is suspended. Please contact support.');
    req.user.role = u.role;
    const roles = this.reflector.getAllAndOverride<string[]>('roles', [ctx.getHandler(), ctx.getClass()]);
    if (roles && !roles.includes(u.role)) throw new ForbiddenException('Your account type cannot do this');
    return true;
  }
}
