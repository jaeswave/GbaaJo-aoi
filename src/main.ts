import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { NestExpressApplication } from "@nestjs/platform-express";
import helmet from "helmet";
import { AppModule } from "./app.module";

async function bootstrap() {
  if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)
    throw new Error("Set JWT_SECRET (32+ characters) in your environment");
  if (
    process.env.NODE_ENV === "production" &&
    !process.env.PAYSTACK_SECRET_KEY &&
    process.env.ALLOW_SIMULATED_PAYMENTS !== "true"
  )
    throw new Error(
      "Set PAYSTACK_SECRET_KEY before running in production, or buyers could reserve without paying. For a test version only, set ALLOW_SIMULATED_PAYMENTS=true",
    );
  if (!process.env.PAYSTACK_SECRET_KEY)
    console.warn(
      "PAYSTACK_SECRET_KEY not set: running in LOCAL TEST MODE, payments are simulated.",
    );

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  }); // rawBody is needed to verify Paystack webhooks
  app.set("trust proxy", 1); // correct client IPs for rate limiting behind Render/Railway
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
  console.log("CORS allowed origins:", origins);
  app.enableCors({ origin: origins });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.listen(process.env.PORT || 3000);
}
bootstrap();
