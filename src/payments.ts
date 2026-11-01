import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Logger, Post, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length, Matches } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer';
import { AuthGuard, CurrentUser, Roles } from './common';

/** What OPay tells us about one payment. */
export type OpayStatus = { status: 'INITIAL' | 'PENDING' | 'SUCCESS' | 'FAIL' | 'CLOSE'; amountKobo: number; orderNo: string; reference: string };

/**
 * Thin wrapper around the OPay Cashier (Express Checkout) API for Nigeria.
 * Docs: https://documentation.opaycheckout.com
 *
 * Needs OPAY_MERCHANT_ID, OPAY_PUBLIC_KEY and OPAY_SECRET_KEY. OPAY_ENV=live uses real money, anything else uses the sandbox.
 * With no keys we run in LOCAL TEST MODE (payments are simulated). main.ts refuses that in production unless you explicitly allow it.
 *
 * Amounts: OPay wants kobo (100 kobo = 1 naira). The rest of GbaanJo works in naira, so we convert only here and in orders.ts.
 */
@Injectable()
export class OpayService {
  private log = new Logger('Opay');
  get enabled() { return !!(process.env.OPAY_MERCHANT_ID && process.env.OPAY_PUBLIC_KEY && process.env.OPAY_SECRET_KEY); }
  private get base() { return (process.env.OPAY_ENV === 'live' ? 'https://liveapi.opaycheckout.com' : 'https://testapi.opaycheckout.com') + '/api/v1/international'; }

  /** auth "public": create-payment calls send the public key. auth "signature": every other call signs the exact JSON body with the secret key. */
  private async post(path: string, body: any, auth: 'public' | 'signature') {
    const json = JSON.stringify(body); // sign and send the SAME string, so the signature always matches
    const token = auth === 'public' ? process.env.OPAY_PUBLIC_KEY : createHmac('sha512', process.env.OPAY_SECRET_KEY).update(json).digest('hex');
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, MerchantId: process.env.OPAY_MERCHANT_ID },
        body: json,
        signal: AbortSignal.timeout(20000),
      });
    } catch (e: any) {
      this.log.error(`OPay ${path} unreachable: ${e?.message || e}`);
      throw new BadRequestException('The payment service is not responding. Please try again in a moment.');
    }
    const data: any = await res.json().catch(() => ({}));
    return data;
  }

  /** Step 1 of a payment: ask OPay for a checkout page. Send the buyer to cashierUrl. */
  async createCashier(p: { reference: string; amountKobo: number; returnUrl: string; cancelUrl: string; callbackUrl: string; expireMinutes: number; user: { id: string; name: string; email: string; phone: string }; product: { name: string; description: string } }) {
    const data = await this.post('/cashier/create', {
      country: 'NG',
      reference: p.reference,
      amount: { total: p.amountKobo, currency: 'NGN' },
      returnUrl: p.returnUrl,
      cancelUrl: p.cancelUrl,
      callbackUrl: p.callbackUrl,
      expireAt: p.expireMinutes,
      userInfo: { userId: p.user.id, userName: p.user.name, userEmail: p.user.email, userMobile: p.user.phone },
      product: p.product,
    }, 'public');
    if (data.code !== '00000' || !data.data?.cashierUrl) {
      this.log.error(`OPay create failed: ${data.code} ${data.message}`);
      throw new BadRequestException('We could not start the payment. Please try again in a moment.');
    }
    return { cashierUrl: data.data.cashierUrl as string, orderNo: data.data.orderNo as string };
  }

  /** Ask OPay directly what happened to a payment. This is the truth: we never trust the browser or a notification on its own. Returns null if OPay has no record yet. */
  async status(reference: string): Promise<OpayStatus | null> {
    const data = await this.post('/cashier/status', { country: 'NG', reference }, 'signature');
    if (data.code === '00000' && data.data) {
      return { status: data.data.status, amountKobo: Number(data.data.amount?.total), orderNo: data.data.orderNo, reference: data.data.reference };
    }
    if (['02006', '00012', '02812'].includes(String(data.code))) return null; // payment not found (yet)
    this.log.error(`OPay status failed for ${reference}: ${data.code} ${data.message}`);
    throw new BadRequestException('Could not check the payment right now.');
  }

  /**
   * OPay signs every notification with HMAC-SHA3-512 over a fixed string built from the payload, using the secret key.
   * https://documentation.opaycheckout.com/callback-signature.html
   */
  verifyCallback(body: any): boolean {
    const p = body?.payload;
    const given = String(body?.sha512 || '').toLowerCase();
    if (!p || !given || !process.env.OPAY_SECRET_KEY) return false;
    const refunded = p.refunded === true || p.refunded === 'true';
    const signed = `{Amount:"${p.amount}",Currency:"${p.currency}",Reference:"${p.reference}",Refunded:${refunded ? 't' : 'f'},Status:"${p.status}",Timestamp:"${p.timestamp}",Token:"${p.token ?? ''}",TransactionID:"${p.transactionId}"}`;
    const expected = createHmac('sha3-512', process.env.OPAY_SECRET_KEY).update(signed).digest('hex');
    return expected.length === given.length && timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  }
}

export class PayoutDto {
  @IsString() @Length(2, 60) bankName: string;
  @IsString() @Length(2, 100) accountName: string;
  @Matches(/^\d{10}$/, { message: 'Account number must be 10 digits' }) accountNumber: string;
  @IsString() @Length(1, 100) password: string;
}

/**
 * OPay collects the money into GbaanJo's merchant account and has no "split to seller" feature. So sellers give their bank
 * details here, and the admin pays them by bank transfer after each handover (admin page, "Seller payouts").
 */
@Controller('payouts')
@UseGuards(AuthGuard)
@Roles('SELLER')
export class PayoutsController {
  constructor(private prisma: PrismaService, private mail: MailerService) {}

  @Get('mode') mode() { return { manual: true }; }

  @Get('me') async me(@CurrentUser() u: any) {
    const x = await this.prisma.user.findUnique({ where: { id: u.sub } });
    return { hasPayout: !!x.accountNumber, bankName: x.bankName, accountName: x.accountName, last4: x.accountNumber ? x.accountNumber.slice(-4) : null };
  }

  // Changing where money goes is sensitive, so we ask for the password again and email the seller about it.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('setup') async setup(@CurrentUser() u: any, @Body() dto: PayoutDto) {
    const user = await this.prisma.user.findUnique({ where: { id: u.sub } });
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Wrong password');
    if (user.approvalStatus !== 'APPROVED') throw new ForbiddenException('Your seller application must be approved before you can add payout details');
    await this.prisma.user.update({ where: { id: u.sub }, data: { bankName: dto.bankName.trim(), accountName: dto.accountName.trim(), accountNumber: dto.accountNumber } });
    void this.mail.payoutAccountChanged(user.email, user.businessName || user.name, dto.bankName.trim(), dto.accountNumber.slice(-4));
    return { ok: true, accountName: dto.accountName.trim() };
  }
}
