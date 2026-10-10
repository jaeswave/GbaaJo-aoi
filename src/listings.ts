import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { IsIn, IsInt, IsISO8601, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from './prisma.service';
import { AuthGuard, CATEGORIES, CITIES, CurrentUser, Roles, RULES, cancelOrders } from './common';

export class CreateListingDto {
  @IsString() @Length(3, 80) title: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  @IsOptional() @IsString() @MaxLength(300) imageUrl?: string;
  @IsIn(CATEGORIES) category: string;
  @IsIn(CITIES) city: string;
  @IsString() @Length(2, 60) area: string;
  @IsString() @Length(5, 200) address: string;
  @IsInt() @Min(100) originalPrice: number;
  @IsInt() @Min(50) price: number;
  @IsInt() @Min(1) @Max(200) quantity: number;
  @IsISO8601() saleEndsAt: string;
  @IsISO8601() pickupBy: string;
}

// The exact street address is NOT public. Buyers only get it after paying.
const publicSelect = {
  id: true, title: true, description: true, imageUrl: true, category: true, city: true, area: true, originalPrice: true, price: true,
  quantity: true, quantityLeft: true, saleEndsAt: true, pickupBy: true, status: true,
  seller: { select: { businessName: true, verified: true } },
};

@Injectable()
export class ListingsService {
  constructor(private prisma: PrismaService) {}

  async create(sellerId: string, dto: CreateListingDto) {
    const seller = await this.prisma.user.findUnique({ where: { id: sellerId }, select: { subaccountCode: true, emailVerifiedAt: true, approvalStatus: true } });
    if (!seller?.emailVerifiedAt) throw new ForbiddenException('Please verify your email first. Check your inbox for the link.');
    if (seller.approvalStatus !== 'APPROVED') throw new ForbiddenException('Your seller application is still under review.');
    if (!seller.subaccountCode) throw new BadRequestException('Set up your payout account first (My shop, then Payouts) so you can get paid.');
    if (dto.imageUrl) {
      const cloud = process.env.CLOUDINARY_CLOUD_NAME;
      if (!cloud || !dto.imageUrl.startsWith(`https://res.cloudinary.com/${cloud}/`)) throw new BadRequestException('That photo is not valid. Please upload it again.');
    }

    const now = Date.now(), ends = new Date(dto.saleEndsAt).getTime(), pick = new Date(dto.pickupBy).getTime();
    if (ends < now + RULES.MIN_SALE_MINUTES * 60000) throw new BadRequestException(`Sale must end at least ${RULES.MIN_SALE_MINUTES} minutes from now`);
    if (ends > now + RULES.MAX_SALE_HOURS * 3600000) throw new BadRequestException(`Sale cannot run longer than ${RULES.MAX_SALE_HOURS} hours`);
    if (pick < ends) throw new BadRequestException('Pickup deadline must be after the sale ends');
    if (pick > ends + RULES.MAX_PICKUP_HOURS * 3600000) throw new BadRequestException(`Pickup deadline must be within ${RULES.MAX_PICKUP_HOURS} hours of the sale ending`);
    if (dto.price > Math.floor(dto.originalPrice * (1 - RULES.MIN_DISCOUNT))) throw new BadRequestException(`Discount must be at least ${RULES.MIN_DISCOUNT * 100}% off the original price`);
    const active = await this.prisma.listing.count({ where: { sellerId, status: 'ACTIVE' } });
    if (active >= RULES.MAX_ACTIVE_LISTINGS) throw new BadRequestException('You have too many active listings');
    return this.prisma.listing.create({
      data: { ...dto, imageUrl: dto.imageUrl || null, saleEndsAt: new Date(dto.saleEndsAt), pickupBy: new Date(dto.pickupBy), quantityLeft: dto.quantity, sellerId },
      select: publicSelect,
    });
  }

  // Time is checked on the SERVER at query time, so an expired listing can never show,
  // even if the background sweep is a minute late.
  list(q: { city?: string; category?: string; q?: string }) {
    return this.prisma.listing.findMany({
      where: {
        status: 'ACTIVE', quantityLeft: { gt: 0 }, saleEndsAt: { gt: new Date() },
        seller: { approvalStatus: 'APPROVED', suspended: false },
        ...(CITIES.includes(q.city) ? { city: q.city } : {}),
        ...(CATEGORIES.includes(q.category) ? { category: q.category } : {}),
        ...(q.q ? { title: { contains: String(q.q).slice(0, 50), mode: 'insensitive' as const } } : {}),
      },
      orderBy: { saleEndsAt: 'asc' }, take: 60, select: publicSelect,
    });
  }

  async one(id: string) {
    const l = await this.prisma.listing.findUnique({ where: { id }, select: publicSelect });
    if (!l) throw new NotFoundException('Listing not found');
    return l;
  }

  mine(sellerId: string) {
    return this.prisma.listing.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' }, take: 100, select: { ...publicSelect, address: true } });
  }

  cancel(sellerId: string, id: string) {
    return this.prisma.$transaction(async (tx) => {
      const l = await tx.listing.findUnique({ where: { id } });
      if (!l) throw new NotFoundException('Listing not found');
      if (l.sellerId !== sellerId) throw new ForbiddenException('Not your listing');
      await cancelOrders(tx, { listingId: id });
      return tx.listing.update({ where: { id }, data: { status: 'CANCELLED' }, select: publicSelect });
    });
  }
}

@Controller('listings')
export class ListingsController {
  constructor(private svc: ListingsService) {}
  @Get('meta') meta() { return { categories: CATEGORIES, cities: CITIES, rules: RULES }; }
  @Get() list(@Query() q: any) { return this.svc.list(q); }
  @UseGuards(AuthGuard) @Roles('SELLER') @Get('mine/all') mine(@CurrentUser() u: any) { return this.svc.mine(u.sub); }
  @Get(':id') one(@Param('id') id: string) { return this.svc.one(id); }
  @UseGuards(AuthGuard) @Roles('SELLER') @Post() create(@CurrentUser() u: any, @Body() dto: CreateListingDto) { return this.svc.create(u.sub, dto); }
  @UseGuards(AuthGuard) @Roles('SELLER') @Patch(':id/cancel') cancel(@CurrentUser() u: any, @Param('id') id: string) { return this.svc.cancel(u.sub, id); }
}
