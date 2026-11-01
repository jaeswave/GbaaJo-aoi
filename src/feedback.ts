import { Body, Controller, Post, Req } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsIn, IsInt, IsOptional, IsString, Length, Max, MaxLength, Min } from 'class-validator';
import { PrismaService } from './prisma.service';
import { MailerService, esc } from './mailer';

export class FeedbackDto {
  @IsOptional() @IsIn(['BUG', 'IDEA', 'PRAISE', 'GENERAL']) category?: string;
  @IsOptional() @IsInt() @Min(1) @Max(5) rating?: number;
  @IsString() @Length(5, 1500) message: string;
  @IsOptional() @IsString() @MaxLength(80) name?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsString() @MaxLength(120) page?: string;
}
export class WaitlistDto {
  @IsEmail() email: string;
  @IsString() @Length(2, 40) city: string;
}

// Open to everyone (pilot testers do not always have an account), so it is rate limited.
@Controller()
export class FeedbackController {
  constructor(private prisma: PrismaService, private jwt: JwtService, private mail: MailerService) {}

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('feedback') async feedback(@Req() req: any, @Body() dto: FeedbackDto) {
    let userId: string | null = null;
    try { userId = this.jwt.verify((req.headers.authorization || '').replace('Bearer ', '')).sub; } catch { /* not logged in, that is fine */ }
    const row = await this.prisma.feedback.create({ data: { userId, category: dto.category || 'GENERAL', rating: dto.rating ?? null, message: dto.message.trim(), name: dto.name?.trim() || null, email: dto.email?.toLowerCase() || null, page: dto.page || null } });
    if (row.category === 'BUG' || (row.rating && row.rating <= 2)) void this.mail.adminAlert('Pilot feedback needs a look', `<b>${esc(row.category)}</b>${row.rating ? ` · ${row.rating}/5` : ''}<br>${esc(row.message.slice(0, 300))}`);
    return { ok: true };
  }

  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('waitlist') async waitlist(@Body() dto: WaitlistDto) {
    await this.prisma.waitlist.upsert({ where: { email: dto.email.toLowerCase() }, update: { city: dto.city }, create: { email: dto.email.toLowerCase(), city: dto.city } });
    return { ok: true };
  }
}
