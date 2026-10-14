import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import * as bcrypt from 'bcryptjs';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { PrismaService } from './prisma.service';
import { refreshDemoData } from './demo-data';

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Set JWT_SECRET (32+ characters) in your environment');
  if (process.env.NODE_ENV === 'production' && !process.env.PAYSTACK_SECRET_KEY && process.env.ALLOW_SIMULATED_PAYMENTS !== 'true') throw new Error('Set PAYSTACK_SECRET_KEY before running in production, or buyers could reserve without paying. For a test version only, set ALLOW_SIMULATED_PAYMENTS=true');
  if (!process.env.PAYSTACK_SECRET_KEY) console.warn('PAYSTACK_SECRET_KEY not set: running in LOCAL TEST MODE, payments are simulated.');

  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true }); // rawBody is needed to verify Paystack webhooks
  app.set('trust proxy', 1); // correct client IPs for rate limiting behind Render
  app.use(helmet());

  // Ignore stray quotes, spaces and trailing slashes in FRONTEND_URL, and print what we allow so it shows in the log
  const origins = (process.env.FRONTEND_URL || "")
    .split(",")
    .map((s) =>
      s
        .trim()
        .replace(/^["']|["']$/g, "")
        .replace(/\/+$/, ""),
    )
    .filter(Boolean);
  // An entry containing * is a pattern, so https://chop-*-jaeswaves-projects.vercel.app allows every deployment link of your project
  const exact = origins.filter((o) => !o.includes("*"));
  const patterns = origins
    .filter((o) => o.includes("*"))
    .map(
      (o) =>
        new RegExp(
          "^" +
            o
              .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
              .replace(/\*/g, "[a-z0-9-]+") +
            "$",
          "i",
        ),
    );
  console.log("CORS allowed origins:", origins);
  app.enableCors({
    origin: (origin, cb) =>
      cb(
        null,
        !origin ||
          exact.includes(origin) ||
          patterns.some((p) => p.test(origin)),
      ),
  });

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
      console.log('Admin account ready for', email);
    } catch (e: any) { console.error('Admin setup failed:', e.message); }
  }

  // Test version only: adds demo sellers and listings so testers have something to browse. Set SEED_DEMO=true to turn it on.
  if (process.env.SEED_DEMO === 'true') {
    try { await refreshDemoData(app.get(PrismaService)); console.log('Demo listings are ready'); }
    catch (e: any) { console.error('Demo data failed:', e.message); }
  }

  await app.listen(process.env.PORT || 3000);
}
bootstrap();
