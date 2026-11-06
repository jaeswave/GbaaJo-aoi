import { Controller, Get, Module, Req } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { SkipThrottle, ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer';
import { AuthController, AuthService } from './auth';
import { ListingsController, ListingsService } from './listings';
import { OrdersController, OrdersService, PaymentsController } from './orders';
import { OpayService, PayoutsController } from './payments';
import { UploadsController } from './uploads';
import { AdminController, AdminService } from './admin';
import { FeedbackController } from './feedback';
import { InsightsController, InsightsService } from "./insights";
import { ExpiryService } from './expiry';

// "/" answers instantly (for the free uptime pinger). "/health" also checks the database, which keeps a free Supabase project from pausing.
@Controller()
class HealthController {
  constructor(private prisma: PrismaService) {}
  @SkipThrottle() @Get() ok() { return { ok: true }; }
  @SkipThrottle() @Get('health') async health(@Req() req: any) {
    await this.prisma.$queryRaw`SELECT 1`;
    return { ok: true, db: true, ip: req.ip }; // ip lets you check the rate limiter sees each visitor's own address
  }
}

@Module({
  imports: [
    ConfigModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 200 }]),
    JwtModule.register({
      global: true,
      secret: process.env.JWT_SECRET,
      signOptions: { expiresIn: "7d" },
    }),
  ],
  controllers: [
    HealthController,
    AuthController,
    ListingsController,
    OrdersController,
    PaymentsController,
    PayoutsController,
    UploadsController,
    AdminController,
    FeedbackController,
    InsightsController,
  ],
  providers: [
    PrismaService,
    MailerService,
    OpayService,
    AuthService,
    ListingsService,
    OrdersService,
    AdminService,
    ExpiryService,
    InsightsService,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
