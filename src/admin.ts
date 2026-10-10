import { BadRequestException, Body, Controller, Get, Injectable, NotFoundException, Param, Patch, Query, UseGuards } from '@nestjs/common';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer';
import { AuthGuard, Roles, cancelOrders, restoreStock } from './common';

export class FlagDto { @IsBoolean() value: boolean; }
export class ReviewDto {
  @IsBoolean() approve: boolean;
  @IsOptional() @IsString() @MaxLength(300) reason?: string;
}

@Injectable()
export class AdminService {
  constructor(private prisma: PrismaService, private mail: MailerService) {}

  async overview() {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const paid = { paidAt: { not: null }, refundedAt: null, refundDue: false } as any;
    const [buyers, sellers, activeListings, ordersToday, pickedUp, noShows, suspended, money, refundsPending, pendingApps] = await Promise.all([
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
    ]);
    const s = money._sum;
    return { buyers, sellers, activeListings, ordersToday, pickedUp, noShows, suspended, sales: s.amountPaid || 0, fees: (s.platformFee || 0) + (s.buyerFee || 0), refundsPending, pendingApps };
  }

  applications(status = 'PENDING') {
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
      select: { id: true, name: true, email: true, phone: true, role: true, businessName: true, rcNumber: true, approvalStatus: true, noShows: true, suspended: true, verified: true, createdAt: true, accountName: true, bankName: true },
    });
  }

  suspend(id: string, value: boolean) {
    return this.prisma.$transaction(async (tx) => {
      const u = await tx.user.findUnique({ where: { id } });
      if (!u) throw new NotFoundException('User not found');
      if (u.role === 'ADMIN') throw new BadRequestException('Admins cannot be suspended');
      await tx.user.update({ where: { id }, data: { suspended: value } });
      if (value && u.role === 'SELLER') {
        await cancelOrders(tx, { listing: { sellerId: id } });
        await tx.listing.updateMany({ where: { sellerId: id, status: { in: ['ACTIVE', 'SOLD_OUT'] } }, data: { status: 'CANCELLED' } });
      }
      if (value && u.role === 'BUYER') {
        const open = await tx.order.findMany({ where: { buyerId: id, status: { in: ['PENDING_PAYMENT', 'RESERVED'] } }, include: { listing: true } });
        for (const o of open) {
          await tx.order.update({ where: { id: o.id }, data: { status: 'CANCELLED', refundDue: o.status === 'RESERVED' } });
          await restoreStock(tx, o);
        }
      }
      return { ok: true };
    });
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

  removeListing(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const l = await tx.listing.findUnique({ where: { id } });
      if (!l) throw new NotFoundException('Listing not found');
      await cancelOrders(tx, { listingId: id });
      await tx.listing.update({ where: { id }, data: { status: 'CANCELLED' } });
      return { ok: true };
    });
  }

  refunds() {
    return this.prisma.order.findMany({
      where: { refundDue: true, refundedAt: null }, orderBy: { createdAt: 'asc' }, take: 100,
      select: { id: true, orderNo: true, totalPrice: true, amountPaid: true, paystackRef: true, createdAt: true, buyer: { select: { name: true, email: true, phone: true } }, listing: { select: { title: true, seller: { select: { businessName: true } } } } },
    });
  }

  async markRefunded(id: string) {
    const r = await this.prisma.order.updateMany({ where: { id, refundDue: true, refundedAt: null }, data: { refundDue: false, refundedAt: new Date() } });
    if (r.count === 0) throw new NotFoundException('No pending refund for this order');
    return { ok: true };
  }
}

@Controller('admin')
@UseGuards(AuthGuard)
@Roles('ADMIN')
export class AdminController {
  constructor(private svc: AdminService) {}
  @Get('overview') overview() { return this.svc.overview(); }
  @Get('applications') applications(@Query('status') status?: string) { return this.svc.applications(['PENDING', 'APPROVED', 'REJECTED'].includes(status) ? status : 'PENDING'); }
  @Patch('applications/:id') review(@Param('id') id: string, @Body() dto: ReviewDto) { return this.svc.review(id, dto.approve, dto.reason); }
  @Get('users') users(@Query('role') role?: string, @Query('q') q?: string) { return this.svc.users(role, q); }
  @Patch('users/:id/suspend') suspend(@Param('id') id: string, @Body() dto: FlagDto) { return this.svc.suspend(id, dto.value); }
  @Patch('users/:id/verify') verify(@Param('id') id: string, @Body() dto: FlagDto) { return this.svc.verify(id, dto.value); }
  @Patch('users/:id/reset-noshows') reset(@Param('id') id: string) { return this.svc.resetNoShows(id); }
  @Get('listings') listings(@Query('status') status?: string) { return this.svc.listings(status); }
  @Patch('listings/:id/remove') remove(@Param('id') id: string) { return this.svc.removeListing(id); }
  @Get('refunds') refunds() { return this.svc.refunds(); }
  @Patch('orders/:id/refunded') refunded(@Param('id') id: string) { return this.svc.markRefunded(id); }
}
