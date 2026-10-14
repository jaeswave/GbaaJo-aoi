# GbaanJo backend (NestJS + Prisma + Postgres)

## Run locally
1. Copy `.env.example` to `.env` and fill it in
2. `npm install`
3. `npx prisma db push`
4. `npm run dev`

## Build check (run this before every deploy)
`npm run build` must finish with no errors.

## Deploy on Render
- Build command: `npm install --include=dev && npm run build`
- Start command: `npx prisma db push && npm start`
- Health check path: `/`
- Environment variables: see `.env.example` (plus `NODE_VERSION=20`)
- Paystack webhook URL: `https://YOUR-BACKEND/payments/webhook`

## Useful commands
- `npm run seed` demo data (LOCAL ONLY), `npm run seed:clean` removes it
- `npm run admin -- you@email.com "a-strong-password-12+" "Your Name"` creates an admin
- `node prisma/verify-existing.js` marks old LOCAL test users as verified (never run on a live database)

## Money and rules
Fee rules live in `src/common.ts` (`PLATFORM_FEE_PERCENT`, `MIN_FEE`, `BUYER_SERVICE_FEE`, `HOLD_MINUTES`).
