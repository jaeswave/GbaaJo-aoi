import { BadRequestException, Controller, ForbiddenException, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { createHash } from 'crypto';
import { PrismaService } from './prisma.service';
import { AuthGuard, CurrentUser, Roles } from './common';

// Photos go straight from the seller's browser to Cloudinary. We only sign the request, so nothing is stored on our server.
@Controller('uploads')
@UseGuards(AuthGuard)
@Roles('SELLER')
export class UploadsController {
  constructor(private prisma: PrismaService) {}

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('sign') async sign(@CurrentUser() u: any) {
    const { CLOUDINARY_CLOUD_NAME: cloudName, CLOUDINARY_API_KEY: apiKey, CLOUDINARY_API_SECRET: secret } = process.env;
    if (!cloudName || !apiKey || !secret) throw new BadRequestException('Photo upload is not set up yet');
    const seller = await this.prisma.user.findUnique({ where: { id: u.sub }, select: { approvalStatus: true, emailVerifiedAt: true } });
    if (seller.approvalStatus !== 'APPROVED' || !seller.emailVerifiedAt) throw new ForbiddenException('You can upload photos once your application is approved');
    const timestamp = Math.floor(Date.now() / 1000);
    const folder = 'chopnow/listings';
    const signature = createHash('sha1').update(`folder=${folder}&timestamp=${timestamp}${secret}`).digest('hex');
    return { cloudName, apiKey, timestamp, folder, signature };
  }
}
