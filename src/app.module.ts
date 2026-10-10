import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaService } from './prisma.service';
import { MailerService } from './mailer';
import { AuthController, AuthService } from './auth';
import { ListingsController, ListingsService } from './listings';
import { OrdersController, OrdersService, PaymentsController } from './orders';
import { PaystackService, PayoutsController } from './payments';
import { UploadsController } from './uploads';
import { AdminController, AdminService } from './admin';
import { ExpiryService } from './expiry';

@Controller() class HealthController { @Get() ok() { return { ok: true }; } }

@Module({
  imports: [
    ConfigModule.forRoot(),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }]),
    JwtModule.register({ global: true, secret: process.env.JWT_SECRET, signOptions: { expiresIn: '7d' } }),
  ],
  controllers: [HealthController, AuthController, ListingsController, OrdersController, PaymentsController, PayoutsController, UploadsController, AdminController],
  providers: [PrismaService, MailerService, PaystackService, AuthService, ListingsService, OrdersService, AdminService, ExpiryService, { provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
