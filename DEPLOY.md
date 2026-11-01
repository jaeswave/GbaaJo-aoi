# GbaanJo: go-live guide (Vercel + Render + Supabase + OPay + Resend)

Do the steps in this order. Each one ends with a way to check it worked.

## 0. What changed in this version

- Payments now go through **OPay** (Paystack is gone). Amounts are sent in kobo.
- OPay has **no split payments**, so GbaanJo receives all the money and pays sellers by bank transfer after the handover. The admin page has a **Seller payouts** tab for this.
- **Lagos only.** Controlled by `ACTIVE_CITIES`. Other cities can join a waitlist.
- Emails for every stage (see the table at the bottom), plus forgot-password, and a feedback form for pilot testers.
- A 5-minute background sweep frees unpaid holds, finds payments whose notification was lost, closes missed pickups and sends pickup reminders.
- Security fixes: street address and pickup code are hidden until payment; reset and verification tokens are stored hashed; production refuses to start with missing payment, email or URL settings.

## 1. Database: Supabase

1. supabase.com, New project. Save the database password. Choose a region close to your Render region (Frankfurt works well from Nigeria).
2. Click **Connect**, choose **Session pooler** and copy the string. (Render cannot reach the "Direct connection" because that address is IPv6 only.)
3. On your computer, in the backend folder, create `.env` from `.env.example` and paste that string into **both** `DATABASE_URL` and `DIRECT_URL`.
4. Create the tables: `npm install` then `npx prisma db push`.
5. Open **SQL Editor** in Supabase, paste the contents of `prisma/rls.sql`, run it. The last line must show `rowsecurity = true` for all five tables.
   This stops anyone reaching your data through Supabase's public web API.

Check: Table Editor shows User, Listing, Order, Feedback, Waitlist.
The free plan pauses a project after a week with no activity. The keep-awake ping in step 6 prevents this.

## 2. Backend: Render

1. render.com, New, Web Service, connect the GitHub repo. If the backend is in a sub-folder, set **Root Directory**.
2. Runtime Node. Region Frankfurt. Plan Free.
3. Build command: `npm install --include=dev && npx prisma generate && npm run build`
4. Start command: `node dist/main.js`. Health check path: `/`
5. Your `package.json` needs a `build` script that produces `dist/main.js` (see `package.reference.json`; also add `dotenv` to dependencies).
6. Add every variable from `.env.example` under **Environment**. Leave out the "test-only switches".
7. Deploy. Copy the service address (like `https://gbaanjo-api.onrender.com`) and set it as `BACKEND_URL`.

Check: open `https://YOUR-API/health`. You should see `{"ok":true,"db":true,"ip":"..."}`.
The `ip` should be YOUR address (compare with whatismyip.com from your phone). If every visitor shows the same address, tell me, because the rate limiter would then treat all users as one person.

First admin: set `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12+ characters), deploy, log in on the website, then **delete `ADMIN_PASSWORD`** from Render.

## 3. Frontend: Vercel

1. Copy `src/`, `public/`, `api/` and `vercel.json` from the frontend folder into your repo and push.
2. Vercel, Settings, Environment Variables: `VITE_API_URL` = your Render address (no slash at the end). Optional: `VITE_BETA_NOTICE` = `Pilot version, Lagos only. Tell us what you think!`
3. Redeploy (Deployments, three dots, Redeploy, untick "use existing build cache").
4. Settings, Domains: add `www.gbaanjo.com` and `gbaanjo.com`. Put your real domains into `FRONTEND_URL` on Render, then redeploy Render.

Check: the home page loads, Live deals shows the demo or real deals, and a refresh on `/deals` does not 404.

## 4. Payments: OPay

1. Get your OPay merchant account approved. You need three values from the OPay merchant dashboard: **Merchant ID**, **Public key**, **Secret key**. Use the **sandbox** (test) values first.
2. Put them in Render as `OPAY_MERCHANT_ID`, `OPAY_PUBLIC_KEY`, `OPAY_SECRET_KEY`, with `OPAY_ENV=sandbox`.
3. In the OPay dashboard, set the **webhook / callback URL** to `https://YOUR-API/payments/opay/callback`.
4. Make a test order as a buyer and pay with OPay's sandbox test details (their sandbox docs list them).

Check: after paying, the order turns RESERVED, the buyer gets an email with the pickup code and the seller gets a "new order" email. If it stays pending, look at the Render logs for lines starting `OPay` or `OpayCallback`.
Even if the notification never arrives, the return page and the 5-minute sweep ask OPay directly, so a paid order is never lost.

Going live: switch to your live keys and set `OPAY_ENV=live`. Do a real test with a cheap listing (minimum is ₦50 plus the ₦100 service fee) and confirm the money in your OPay dashboard.
The server **refuses to start in production without OPay keys**, so you cannot accidentally open a shop where nobody pays.

## 5. Email: Resend

1. resend.com, Domains, add `gbaanjo.com`, copy the DNS records into your domain provider, wait for "Verified".
2. Create an API key. Set `RESEND_API_KEY` and `MAIL_FROM="GbaanJo <hello@gbaanjo.com>"` on Render.
3. Set `ADMIN_ALERT_EMAIL` to the inbox you check every day.

Without a verified domain, Resend only delivers to your own email, so real users would get nothing. The server prints a warning for this at startup.
The free plan allows **100 emails a day**. A pilot of about 20 orders a day uses roughly 70 to 90. Important emails (verification, codes, refunds) are always sent first; reminders and thank-yous are skipped when the day is nearly full. Upgrade when you pass that.

## 6. Keep it awake

Render's free server sleeps after 15 minutes without visitors, and while asleep it cannot run the sweep or answer OPay quickly.
Create a free monitor at uptimerobot.com: type HTTP(s), URL `https://YOUR-API/health`, interval 5 minutes. This also keeps Supabase from pausing.

## 7. Photos: Cloudinary

Already built into the seller page. Create a free Cloudinary account and set the three `CLOUDINARY_` variables. Real sellers upload their own photos, which is better than stock images.

## 8. Day-to-day admin

- **Applications**: check each CAC number yourself in CAC's public search before approving.
- **Refunds**: Refund the buyer from the OPay dashboard (using the OPay reference shown), then press "Mark refunded". The buyer is emailed.
- **Seller payouts**: transfer the amount to the bank account shown, then press "Mark paid". The seller is emailed. Do this every day or two.
- **Feedback**: read the Feedback tab. Bug reports also email you.

## 9. Go-live test (do it all in sandbox first)

1. Register as a buyer (city Lagos). Verify the email link works.
2. Register as a seller with a CAC number. Verify email. Approve it in Admin.
3. Seller adds a payout account, uploads a photo, creates a listing at 30%+ off.
4. Buyer orders and pays. Check both emails.
5. Seller enters the pickup code. Buyer gets the thank-you email.
6. Admin, Seller payouts: the seller shows the right amount. Mark paid. Seller gets the email.
7. Buyer orders, pays, cancels. Admin sees the refund. Mark refunded. Buyer gets the email.
8. Buyer starts an order and abandons it. After about 12 minutes the food is back on sale.
9. Forgot password works end to end.
10. Send feedback from the pill at the bottom right. It appears in Admin.

## 10. Decisions that are yours to confirm

- The website now says sellers are paid "usually within 1 to 2 working days" after handover. Change it in `Home.jsx` if you cannot keep that.
- Refunds are manual and promised in "1 to 3 working days" in the emails.
- A buyer who misses pickup is not refunded; the seller keeps the money. Three misses pause the account.
- Have the Terms page (`Legal.jsx`) reviewed by a Nigerian lawyer, including data protection (NDPA) wording, before real customers use it.

## Emails the system sends

| When | To |
| --- | --- |
| Sign up / resend | New user: verify link |
| Forgot password | User: reset link |
| Seller approved or rejected | Seller |
| Payout account changed | Seller |
| Payment confirmed | Buyer: pickup code and address. Seller: new order |
| Buyer cancels | Buyer: refund notice. Seller: cancellation. Admin: refund to process |
| Seller cancels listing / admin removes it | Each buyer (with refund notice), seller |
| Payment arrived too late | Buyer: refund notice. Admin |
| About 1 hour before pickup deadline | Buyer: reminder |
| Pickup missed | Buyer and seller |
| Handover done | Buyer: thanks and feedback link |
| Refund marked sent | Buyer |
| Payout marked paid | Seller |
| New seller application, wrong payment amount, bug feedback | Admin |

## Known limits of the free setup

- First request after a long sleep can take up to a minute if the keep-awake monitor is not running.
- Supabase free is 500 MB, enough for a long pilot.
- Refunds and seller payouts are manual by design for the pilot.
- No SMS or push notifications. Email only.
