import 'dotenv/config'; // load .env first, so settings such as ACTIVE_CITIES are read before the rest of the app starts
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bcrypt from 'bcryptjs';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PrismaService } from './prisma.service';
import { refreshDemoData } from './demo-data';
import { CITIES } from './common';

function checkEnvironment() {
  const prod = process.env.NODE_ENV === 'production';
  const need = (name: string, why: string) => { if (!process.env[name]) throw new Error(`Set ${name}: ${why}`); };
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET (32+ characters) in your environment');
  need('DATABASE_URL', 'the Supabase connection string');
  const opayKeys = ['OPAY_MERCHANT_ID', 'OPAY_PUBLIC_KEY', 'OPAY_SECRET_KEY'].filter((k) => process.env[k]);
  if (opayKeys.length > 0 && opayKeys.length < 3) throw new Error('OPay is half set up. You need all of OPAY_MERCHANT_ID, OPAY_PUBLIC_KEY and OPAY_SECRET_KEY');
  if (opayKeys.length === 0) {
    if (prod && process.env.ALLOW_SIMULATED_PAYMENTS !== 'true') throw new Error('Set the OPAY_* keys before running in production, or buyers could reserve without paying. For a test version only, set ALLOW_SIMULATED_PAYMENTS=true');
    console.warn('OPay keys not set: running in LOCAL TEST MODE, payments are simulated.');
  } else if (process.env.OPAY_ENV !== 'live') {
    console.warn('OPAY_ENV is not "live": payments go to the OPay SANDBOX (no real money). Set OPAY_ENV=live when you are ready.');
  }
  if (prod) {
    need('FRONTEND_URL', 'your Vercel address, used for CORS and for links in emails');
    if (!process.env.BACKEND_URL && !process.env.RENDER_EXTERNAL_URL) throw new Error('Set BACKEND_URL to this server\'s public address (OPay sends payment notifications there)');
    if (!process.env.RESEND_API_KEY && process.env.SKIP_EMAIL_VERIFICATION !== 'true') throw new Error('Set RESEND_API_KEY, or nobody can verify their email. (For a private test only, SKIP_EMAIL_VERIFICATION=true)');
    if (process.env.RESEND_API_KEY && !process.env.MAIL_FROM) console.warn('MAIL_FROM is not set. Emails will come from onboarding@resend.dev, which only delivers to YOUR OWN address. Verify your domain in Resend and set MAIL_FROM="GbaanJo <hello@yourdomain.com>".');
  }
}

async function bootstrap() {
  checkEnvironment();

  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  app.set('trust proxy', 1); // correct client IPs for rate limiting behind Render. Check /health shows your own IP.
  app.use(helmet());
  app.enableShutdownHooks();

  // Ignore stray quotes, spaces and trailing slashes in FRONTEND_URL, and print what we allow so it shows in the log
  const origins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map((s) => s.trim().replace(/^["']|["']$/g, '').replace(/\/+$/, ''))
    .filter(Boolean);
  // An entry containing * is a pattern, so https://chop-*-jaeswaves-projects.vercel.app allows every deployment link of your project
  const exact = origins.filter((o) => !o.includes('*'));
  const patterns = origins
    .filter((o) => o.includes('*'))
    .map((o) => new RegExp('^' + o.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+') + '$', 'i'));
  console.log('CORS allowed origins:', origins, '| live cities:', CITIES);
  app.enableCors({ origin: (origin, cb) => cb(null, !origin || exact.includes(origin) || patterns.some((p) => p.test(origin))) });

  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  // Creates (or promotes) the admin from environment variables. Remove ADMIN_PASSWORD after the first successful start.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    try {
      if (process.env.ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
      const prisma = app.get(PrismaService);
      const email = process.env.ADMIN_EMAIL.trim().toLowerCase();
      const passwordHash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 10);
      await prisma.user.upsert({
        where: { email },
        update: { role: 'ADMIN', passwordHash, suspended: false, emailVerifiedAt: new Date(), approvalStatus: 'APPROVED' },
        create: { email, name: 'Admin', phone: '08000000000', role: 'ADMIN', passwordHash, emailVerifiedAt: new Date(), approvalStatus: 'APPROVED' },
      });
      console.log('Admin account ready for', email, '(now delete ADMIN_PASSWORD from your environment)');
    } catch (e: any) { console.error('Admin setup failed:', e.message); }
  }

  // Test version only: adds demo sellers and listings so testers have something to browse. Set SEED_DEMO=true to turn it on.
  if (process.env.SEED_DEMO === 'true') {
    if (process.env.OPAY_SECRET_KEY && process.env.OPAY_ENV === 'live') console.warn('SEED_DEMO ignored: demo listings cannot be paid for with real OPay and would confuse real buyers.');
    else {
      try { await refreshDemoData(app.get(PrismaService)); console.log('Demo listings are ready'); }
      catch (e: any) { console.error('Demo data failed:', e.message); }
    }
  }

  await app.listen(process.env.PORT || 3000, '0.0.0.0');
}
bootstrap();
