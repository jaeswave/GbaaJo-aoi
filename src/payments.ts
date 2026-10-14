import { BadRequestException, Body, Controller, ForbiddenException, Get, Injectable, Post, Query, UnauthorizedException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsString, Length, Matches } from 'class-validator';
import * as bcrypt from 'bcryptjs';
import { PrismaService } from './prisma.service';
import { AuthGuard, CurrentUser, Roles, RULES } from './common';

/** Thin wrapper around the Paystack API. If PAYSTACK_SECRET_KEY is missing we run in local test mode (no real payments). */
@Injectable()
export class PaystackService {
  private banksCache: { at: number; list: any[] } | null = null;
  get enabled() { return !!process.env.PAYSTACK_SECRET_KEY; }
  // TEST BOX ONLY: skip seller subaccounts and splitting, so test payments work without real seller bank details
  get noSplit() { return process.env.PAYSTACK_NO_SPLIT === 'true'; }

  private async call(path: string, method = 'GET', body?: any) {
    const res = await fetch('https://api.paystack.co' + path, {
      method,
      headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) throw new BadRequestException(data.message || 'The payment provider returned an error');
    return data.data;
  }

  async banks() {
    if (this.banksCache && Date.now() - this.banksCache.at < 864e5) return this.banksCache.list;
    const list = await this.call('/bank?country=nigeria&currency=NGN&perPage=100');
    this.banksCache = { at: Date.now(), list };
    return list;
  }
  resolve(accountNumber: string, bankCode: string) { return this.call(`/bank/resolve?account_number=${accountNumber}&bank_code=${bankCode}`); }
  createSubaccount(p: { businessName: string; bankCode: string; accountNumber: string }) {
    // The percentage is only a default. Every payment overrides it with the exact fee (transaction_charge).
    return this.call('/subaccount', 'POST', { business_name: p.businessName, settlement_bank: p.bankCode, account_number: p.accountNumber, percentage_charge: RULES.PLATFORM_FEE_PERCENT });
  }
  initialize(p: { email: string; amountKobo: number; feeKobo: number; reference: string; subaccount: string; callbackUrl: string; metadata: any }) {
    const body: any = { email: p.email, amount: p.amountKobo, reference: p.reference, callback_url: p.callbackUrl, metadata: p.metadata };
    if (!this.noSplit) {
      body.subaccount = p.subaccount;
      body.transaction_charge = p.feeKobo;                       // flat amount that stays with the platform
      body.bearer = process.env.PAYSTACK_BEARER || 'account';    // 'account' = the platform pays Paystack's processing fee
    }
    return this.call('/transaction/initialize', 'POST', body);
  }
  verify(reference: string) { return this.call('/transaction/verify/' + encodeURIComponent(reference)); }
}

export class PayoutDto {
  @IsString() @Length(2, 10) bankCode: string;
  @Matches(/^\d{10}$/, { message: 'Account number must be 10 digits' }) accountNumber: string;
  @IsString() @Length(1, 100) password: string;
}

@Controller('payouts')
@UseGuards(AuthGuard)
@Roles('SELLER')
export class PayoutsController {
  constructor(private ps: PaystackService, private prisma: PrismaService) {}
  private get fake() { return !this.ps.enabled || this.ps.noSplit; }

  @Get('banks') async banks() {
    if (this.fake) return [{ name: 'Test Bank (test version)', code: '000' }];
    return (await this.ps.banks()).map((b: any) => ({ name: b.name, code: b.code }));
  }

  @Get('resolve') async resolve(@Query('account_number') a: string, @Query('bank_code') b: string) {
    if (!/^\d{10}$/.test(a || '') || !b) throw new BadRequestException('Enter a valid 10-digit account number');
    if (this.fake) return { accountName: 'Test Account' };
    return { accountName: (await this.ps.resolve(a, b)).account_name };
  }

  @Get('me') async me(@CurrentUser() u: any) {
    const x = await this.prisma.user.findUnique({ where: { id: u.sub } });
    return { hasPayout: !!x.subaccountCode, bankName: x.bankName, accountName: x.accountName, last4: x.accountNumber ? x.accountNumber.slice(-4) : null };
  }

  // Changing where money goes is sensitive, so we ask for the password again.
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @Post('setup') async setup(@CurrentUser() u: any, @Body() dto: PayoutDto) {
    const user = await this.prisma.user.findUnique({ where: { id: u.sub } });
    if (!(await bcrypt.compare(dto.password, user.passwordHash))) throw new UnauthorizedException('Wrong password');
    if (user.approvalStatus !== 'APPROVED') throw new ForbiddenException('Your seller application must be approved before you can add payout details');
    let accountName = 'Test Account', code = 'TEST_NO_SPLIT', bankName = 'Test Bank';
    if (!this.fake) {
      accountName = (await this.ps.resolve(dto.accountNumber, dto.bankCode)).account_name;
      code = (await this.ps.createSubaccount({ businessName: user.businessName, bankCode: dto.bankCode, accountNumber: dto.accountNumber })).subaccount_code;
      bankName = ((await this.ps.banks()).find((b: any) => b.code === dto.bankCode) || {}).name || dto.bankCode;
    }
    await this.prisma.user.update({ where: { id: u.sub }, data: { bankCode: dto.bankCode, bankName, accountNumber: dto.accountNumber, accountName, subaccountCode: code } });
    return { ok: true, accountName };
  }
}
