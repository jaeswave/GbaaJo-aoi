import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer';
import { AuthGuard, CurrentUser, frontendUrl } from './common';

const RC_PATTERN = /^(RC|BN)\s?-?\s?\d{4,9}$/i;
const RC_MESSAGE = 'Enter your CAC number, like RC1234567 or BN1234567';
const cleanRc = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export class RegisterDto {
  @IsEmail() email: string;
  @IsString() @MinLength(8, { message: 'Password must be at least 8 characters' }) password: string;
  @IsString() @Length(2, 60) name: string;
  @Matches(/^(\+234|0)[789][01]\d{8}$/, { message: 'Enter a valid Nigerian phone number' }) phone: string;
  @IsIn(['BUYER', 'SELLER']) role: 'BUYER' | 'SELLER';
  @IsOptional() @IsString() @Length(2, 80) businessName?: string;
  @IsOptional() @Matches(RC_PATTERN, { message: RC_MESSAGE }) rcNumber?: string;
}
export class LoginDto { @IsEmail() email: string; @IsString() password: string; }
export class VerifyDto { @IsString() @Length(20, 200) token: string; }
export class ResubmitDto {
  @IsString() @Length(2, 80) businessName: string;
  @Matches(RC_PATTERN, { message: RC_MESSAGE }) rcNumber: string;
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private mail: MailerService) {}

  view(u: any) {
    return { id: u.id, name: u.name, role: u.role, businessName: u.businessName, emailVerified: !!u.emailVerifiedAt, approvalStatus: u.approvalStatus, rejectionReason: u.rejectionReason };
  }
  private session(u: any) { return { token: this.jwt.sign({ sub: u.id, role: u.role, name: u.name }), user: this.view(u) }; }

  // Only a hash of the token is stored, so a database leak cannot be used to verify accounts.
  private async sendVerification(u: any) {
    const token = randomBytes(32).toString('hex');
    await this.prisma.user.update({ where: { id: u.id }, data: { verifyToken: sha(token), verifyTokenExpires: new Date(Date.now() + 24 * 3600 * 1000) } });
    await this.mail.sendVerification(u.email, u.name, `${frontendUrl()}/verify-email?token=${token}`);
  }

  async register(dto: RegisterDto) {
    const seller = dto.role === 'SELLER';
    if (seller && !dto.businessName) throw new BadRequestException('Sellers must give a business name');
    if (seller && !dto.rcNumber) throw new BadRequestException('Sellers must give their CAC number (RC or BN)');
    const email = dto.email.toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('An account with this email already exists');
    const rc = seller ? cleanRc(dto.rcNumber) : null;
    if (rc && (await this.prisma.user.findUnique({ where: { rcNumber: rc } }))) throw new ConflictException('This CAC number is already linked to another account. Contact support if it is yours.');
    const u = await this.prisma.user.create({
      data: { email, name: dto.name, phone: dto.phone, role: dto.role, businessName: seller ? dto.businessName : null, rcNumber: rc, approvalStatus: seller ? 'PENDING' : 'APPROVED', emailVerifiedAt: process.env.SKIP_EMAIL_VERIFICATION === 'true' ? new Date() : null, passwordHash: await bcrypt.hash(dto.password, 10) },
    });
    await this.sendVerification(u);
    return this.session(u);
  }

  async login(dto: LoginDto) {
    const u = await this.prisma.user.findUnique({ where: { email: dto.email.toLowerCase() } });
    if (!u || !(await bcrypt.compare(dto.password, u.passwordHash))) throw new UnauthorizedException('Wrong email or password');
    if (u.suspended) throw new ForbiddenException('Your account is suspended. Please contact support.');
    return this.session(u);
  }

  async verifyEmail(token: string) {
    const u = await this.prisma.user.findFirst({ where: { verifyToken: sha(token), verifyTokenExpires: { gt: new Date() } } });
    if (!u) throw new BadRequestException('This verification link is invalid or has expired. Log in and request a new one.');
    await this.prisma.user.update({ where: { id: u.id }, data: { emailVerifiedAt: new Date(), verifyToken: null, verifyTokenExpires: null } });
    return { ok: true };
  }

  async resend(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new UnauthorizedException();
    if (u.emailVerifiedAt) throw new BadRequestException('Your email is already verified');
    await this.sendVerification(u);
    return { ok: true };
  }

  async resubmit(userId: string, dto: ResubmitDto) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.role !== 'SELLER' || u.approvalStatus !== 'REJECTED') throw new BadRequestException('Only rejected applications can be resubmitted');
    const rc = cleanRc(dto.rcNumber);
    const other = await this.prisma.user.findUnique({ where: { rcNumber: rc } });
    if (other && other.id !== userId) throw new ConflictException('This CAC number is already linked to another account');
    const upd = await this.prisma.user.update({ where: { id: userId }, data: { businessName: dto.businessName, rcNumber: rc, approvalStatus: 'PENDING', rejectionReason: null } });
    return this.view(upd);
  }

  async me(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new UnauthorizedException();
    return this.view(u);
  }
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('register') register(@Body() dto: RegisterDto) { return this.auth.register(dto); }
  @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto); }
  @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('verify-email') verify(@Body() dto: VerifyDto) { return this.auth.verifyEmail(dto.token); }
  @UseGuards(AuthGuard) @Throttle({ default: { limit: 3, ttl: 60000 } }) @Post('resend-verification') resend(@CurrentUser() u: any) { return this.auth.resend(u.sub); }
  @UseGuards(AuthGuard) @Post('resubmit') resubmit(@CurrentUser() u: any, @Body() dto: ResubmitDto) { return this.auth.resubmit(u.sub, dto); }
  @UseGuards(AuthGuard) @Get('me') me(@CurrentUser() u: any) { return this.auth.me(u.sub); }
}
