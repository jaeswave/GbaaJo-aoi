import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Patch, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';
import { MailerService, esc } from './mailer';
import { AuthGuard, CITIES, CurrentUser, frontendUrl } from './common';

const RC_PATTERN = /^(RC|BN)\s?-?\s?\d{4,9}$/i;
const RC_MESSAGE = 'Enter your CAC number, like RC1234567 or BN1234567';
const cleanRc = (s: string) => s.toUpperCase().replace(/[\s-]/g, '');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const CITY_MESSAGE = `GbaanJo is only live in ${CITIES.join(', ')} for now. Leave your email on the waitlist and we will tell you when we reach your city.`;

export class RegisterDto {
  @IsEmail() email: string;
  @IsString() @MinLength(8, { message: 'Password must be at least 8 characters' }) @MaxLength(72) password: string;
  @IsString() @Length(2, 60) name: string;
  @Matches(/^(\+234|0)[789][01]\d{8}$/, { message: 'Enter a valid Nigerian phone number' }) phone: string;
  @IsIn(['BUYER', 'SELLER']) role: 'BUYER' | 'SELLER';
  @IsIn(CITIES, { message: CITY_MESSAGE }) city: string;
  @IsOptional() @IsString() @Length(2, 80) businessName?: string;
  @IsOptional() @Matches(RC_PATTERN, { message: RC_MESSAGE }) rcNumber?: string;
}
export class LoginDto { @IsEmail() email: string; @IsString() @MaxLength(100) password: string; }
export class VerifyDto { @IsString() @Length(20, 200) token: string; }
export class ResubmitDto {
  @IsString() @Length(2, 80) businessName: string;
  @Matches(RC_PATTERN, { message: RC_MESSAGE }) rcNumber: string;
}
export class CityDto { @IsIn(CITIES, { message: CITY_MESSAGE }) city: string; }
export class ForgotDto { @IsEmail() email: string; }
export class ResetDto {
  @IsString() @Length(20, 200) token: string;
  @IsString() @MinLength(8, { message: 'Password must be at least 8 characters' }) @MaxLength(72) password: string;
}

@Injectable()
export class AuthService {
  constructor(private prisma: PrismaService, private jwt: JwtService, private mail: MailerService) {}

  view(u: any) {
    return { id: u.id, name: u.name, role: u.role, city: u.city, businessName: u.businessName, emailVerified: !!u.emailVerifiedAt, approvalStatus: u.approvalStatus, rejectionReason: u.rejectionReason };
  }
  private session(u: any) { return {
    token: this.jwt.sign({
      sub: u.id,
      role: u.role,
      name: u.name,
      ph: u.passwordHash.slice(-12),
    }),
    user: this.view(u),
  }; }

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
      data: { email, name: dto.name, phone: dto.phone, role: dto.role, city: dto.city, businessName: seller ? dto.businessName : null, rcNumber: rc, approvalStatus: seller ? 'PENDING' : 'APPROVED', emailVerifiedAt: process.env.SKIP_EMAIL_VERIFICATION === 'true' ? new Date() : null, passwordHash: await bcrypt.hash(dto.password, 10) },
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
    // A seller can only be approved once the email is verified, so this is the moment the application becomes reviewable
    if (u.role === 'SELLER' && u.approvalStatus === 'PENDING') {
      void this.mail.adminAlert('New seller application', `<b>${esc(u.businessName)}</b> (${esc(u.rcNumber)}) verified their email and is waiting for approval.`);
    }
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
    void this.mail.adminAlert('Seller application resubmitted', `<b>${esc(upd.businessName)}</b> (${esc(upd.rcNumber)}) fixed their details and is waiting for approval again.`);
    return this.view(upd);
  }

  async me(userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u) throw new UnauthorizedException();
    return this.view(u);
  }

  // The user confirms the city they will use GbaanJo in (we also guess it from their location on the website, but they always have the last word)
  async setCity(userId: string, city: string) {
    return this.view(await this.prisma.user.update({ where: { id: userId }, data: { city } }));
  }

  // Always answers "ok", so nobody can use this form to find out which emails have accounts
  async forgot(emailRaw: string) {
    const u = await this.prisma.user.findUnique({ where: { email: emailRaw.toLowerCase() } });
    if (u && !u.suspended) {
      const token = randomBytes(32).toString('hex');
      await this.prisma.user.update({ where: { id: u.id }, data: { resetToken: sha(token), resetTokenExpires: new Date(Date.now() + 3600 * 1000) } });
      await this.mail.sendPasswordReset(u.email, u.name, `${frontendUrl()}/reset-password?token=${token}`);
    }
    return { ok: true };
  }

  async reset(token: string, password: string) {
    const u = await this.prisma.user.findFirst({ where: { resetToken: sha(token), resetTokenExpires: { gt: new Date() } } });
    if (!u) throw new BadRequestException('This reset link is invalid or has expired. Please request a new one.');
    await this.prisma.user.update({
      where: { id: u.id },
      // Receiving the email proves the address is theirs, so it also counts as verification
      data: { passwordHash: await bcrypt.hash(password, 10), resetToken: null, resetTokenExpires: null, emailVerifiedAt: u.emailVerifiedAt ?? new Date() },
    });
    return { ok: true };
  }
}

@Controller('auth')
export class AuthController {
  constructor(private auth: AuthService) {}
  @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('register') register(@Body() dto: RegisterDto) { return this.auth.register(dto); }
  @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('login') login(@Body() dto: LoginDto) { return this.auth.login(dto); }
  @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('verify-email') verify(@Body() dto: VerifyDto) { return this.auth.verifyEmail(dto.token); }
  @Throttle({ default: { limit: 5, ttl: 60000 } }) @Post('forgot-password') forgot(@Body() dto: ForgotDto) { return this.auth.forgot(dto.email); }
  @Throttle({ default: { limit: 10, ttl: 60000 } }) @Post('reset-password') reset(@Body() dto: ResetDto) { return this.auth.reset(dto.token, dto.password); }
  @UseGuards(AuthGuard) @Throttle({ default: { limit: 3, ttl: 60000 } }) @Post('resend-verification') resend(@CurrentUser() u: any) { return this.auth.resend(u.sub); }
  @UseGuards(AuthGuard) @Post('resubmit') resubmit(@CurrentUser() u: any, @Body() dto: ResubmitDto) { return this.auth.resubmit(u.sub, dto); }
  @UseGuards(AuthGuard) @Patch('city') city(@CurrentUser() u: any, @Body() dto: CityDto) { return this.auth.setCity(u.sub, dto.city); }
  @UseGuards(AuthGuard) @Get('me') me(@CurrentUser() u: any) { return this.auth.me(u.sub); }
}
