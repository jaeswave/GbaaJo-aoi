// End-to-end test of the GbaanJo backend with OPay and Resend mocked and an in-memory database.
const MODE = process.env.MODE || 'opay';
Object.assign(process.env, {
  JWT_SECRET: 'x'.repeat(40), NODE_ENV: 'test', FRONTEND_URL: 'https://gbaanjo.com', BACKEND_URL: 'https://api.gbaanjo.test',
  SKIP_EMAIL_VERIFICATION: 'true', RESEND_API_KEY: 're_test', MAIL_FROM: 'GbaanJo <hello@gbaanjo.com>', ADMIN_ALERT_EMAIL: 'admin@gbaanjo.com', CLOUDINARY_CLOUD_NAME: 'demo',
});
if (MODE === 'opay') Object.assign(process.env, { OPAY_MERCHANT_ID: '281821110129700', OPAY_PUBLIC_KEY: 'OPAYPUB123', OPAY_SECRET_KEY: 'OPAYPRVsecret', OPAY_ENV: 'sandbox' });
const crypto = require('crypto'); const bcrypt = require('bcryptjs');
require('reflect-metadata');
const { Test } = require('@nestjs/testing'); const { ValidationPipe } = require('@nestjs/common');
const { AppModule } = require('../dist/app.module'); const { PrismaService } = require('../dist/prisma.service'); const { ExpiryService } = require('../dist/expiry');
const db = require('./fakeprisma')();
const realFetch = globalThis.fetch;
const emails = []; const opayState = {}; const opayCalls = []; let badStatusSig = 0;
globalThis.fetch = async (url, init = {}) => {
  url = String(url);
  if (url.startsWith('https://api.resend.com')) { const b = JSON.parse(init.body); emails.push({ to: b.to[0], subject: b.subject, html: b.html }); return new Response('{"id":"1"}', { status: 200 }); }
  if (url.includes('opaycheckout.com')) {
    const body = JSON.parse(init.body); const h = init.headers;
    if (h.MerchantId !== '281821110129700') return Response.json({ code: '02000', message: 'authentication failed.' });
    if (url.endsWith('/cashier/create')) {
      opayCalls.push({ body, auth: h.Authorization });
      if (h.Authorization !== 'Bearer OPAYPUB123') return Response.json({ code: '02000', message: 'authentication failed.' });
      return Response.json({ code: '00000', message: 'SUCCESSFUL', data: { reference: body.reference, orderNo: 'OP' + body.reference.slice(-6), cashierUrl: 'https://sandboxcashier.opaycheckout.com/pay?t=' + body.reference, status: 'INITIAL', amount: body.amount } });
    }
    if (url.endsWith('/cashier/status')) {
      const want = 'Bearer ' + crypto.createHmac('sha512', 'OPAYPRVsecret').update(init.body).digest('hex');
      if (h.Authorization !== want) { badStatusSig++; return Response.json({ code: '02000', message: 'authentication failed.' }); }
      const s = opayState[body.reference]; if (!s) return Response.json({ code: '02006', message: 'payment not found.' });
      return Response.json({ code: '00000', message: 'SUCCESSFUL', data: { reference: body.reference, orderNo: s.orderNo || 'OPX', status: s.status, amount: { total: s.amount, currency: 'NGN' } } });
    }
  }
  return realFetch(url, init);
};
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  PASS', m); } else { failed++; console.log('  FAIL', m); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const to = (addr) => emails.filter((e) => e.to === addr);
const signed = (reference, amount, status = 'SUCCESS', refunded = false) => {
  const p = { amount: String(amount), channel: 'Web', country: 'NG', currency: 'NGN', displayedFailure: '', fee: '0', feeCurrency: 'NGN', instrumentType: 'BankCard', reference, refunded, status, timestamp: '2026-10-31T10:00:00Z', token: 'tok' + reference, transactionId: 'tx' + reference, updated_at: '2026-10-31T10:00:00Z' };
  const s = `{Amount:"${p.amount}",Currency:"NGN",Reference:"${reference}",Refunded:${refunded ? 't' : 'f'},Status:"${status}",Timestamp:"${p.timestamp}",Token:"${p.token}",TransactionID:"${p.transactionId}"}`;
  return { payload: p, sha512: crypto.createHmac('sha3-512', 'OPAYPRVsecret').update(s).digest('hex'), type: 'transaction-status' };
};

(async () => {
  const mod = await Test.createTestingModule({ imports: [AppModule] }).overrideProvider(PrismaService).useValue(db).compile();
  const app = mod.createNestApplication(); app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(0); const base = await app.getUrl();
  const call = async (method, path, body, token) => { const r = await realFetch(base.replace('[::1]', 'localhost') + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch {} return { s: r.status, j }; };
  const sweep = () => app.get(ExpiryService).sweep();
  const hour = 3600000, min = 60000;

  console.log(`\n== Mode: ${MODE} ==\n== Setup: city rules, accounts, approval, payouts, listing`);
  let r = await call('GET', '/listings/meta'); ok(r.j.cities.length === 1 && r.j.cities[0] === 'Lagos' && r.j.paymentProvider === 'opay', 'meta: Lagos only, provider opay');
  r = await call('POST', '/auth/register', { email: 'a@x.com', password: 'password1', name: 'Abu', phone: '08031234567', role: 'BUYER', city: 'Abuja' }); ok(r.s === 400 && /only live in Lagos/.test(JSON.stringify(r.j)), 'register outside Lagos is refused with a clear message');
  r = await call('POST', '/auth/register', { email: 'a@x.com', password: 'password1', name: 'Abu', phone: '08031234567', role: 'BUYER' }); ok(r.s === 400, 'register without a city is refused');
  const reg = async (e, role, extra = {}) => (await call('POST', '/auth/register', { email: e, password: 'password1', name: 'Test ' + role, phone: '08031234567', role, city: 'Lagos', ...extra })).j;
  const buyer = await reg('buyer@x.com', 'BUYER'); const buyer2 = await reg('buyer2@x.com', 'BUYER');
  const seller = await reg('seller@x.com', 'SELLER', { businessName: 'Mama Tee', rcNumber: 'RC1234567' });
  ok(buyer.token && buyer.user.city === 'Lagos' && seller.user.approvalStatus === 'PENDING', 'buyer and pending seller registered');
  await db.user.create({ data: { email: 'admin@x.com', name: 'Admin', phone: '08000000000', role: 'ADMIN', passwordHash: await bcrypt.hash('adminpassword1', 4), emailVerifiedAt: new Date() } });
  const admin = (await call('POST', '/auth/login', { email: 'admin@x.com', password: 'adminpassword1' })).j.token;
  r = await call('PATCH', '/admin/applications/' + seller.user.id, { approve: true }, admin); await sleep(60);
  ok(r.s === 200 && to('seller@x.com').some((e) => /approved/.test(e.subject)), 'admin approves seller; seller gets the approval email');
  r = await call('GET', '/payouts/mode', null, seller.token); ok(r.j.manual === true, 'payout mode is manual (OPay has no split)');
  r = await call('POST', '/payouts/setup', { bankName: 'GTBank', accountName: 'Tolani Adeyemi', accountNumber: '0123456789', password: 'wrong' }, seller.token); ok(r.s === 401, 'payout setup needs the right password');
  r = await call('POST', '/payouts/setup', { bankName: 'GTBank', accountName: 'Tolani Adeyemi', accountNumber: '0123456789', password: 'password1' }, seller.token); await sleep(60);
  ok(r.s === 201 && to('seller@x.com').some((e) => /payout account was changed/.test(e.subject)), 'payout saved; seller is emailed about the change');
  const lst = { title: 'Jollof rice packs', category: 'Cooked meals', city: 'Lagos', area: 'Lekki', address: '12 Admiralty Way, Lekki', originalPrice: 4000, price: 2000, quantity: 10, saleEndsAt: new Date(Date.now() + 3 * hour).toISOString(), pickupBy: new Date(Date.now() + 5 * hour).toISOString() };
  r = await call('POST', '/listings', { ...lst, city: 'Abuja' }, seller.token); ok(r.s === 400, 'listing in a non-live city is refused');
  r = await call('POST', '/listings', { ...lst, price: 3500 }, seller.token); ok(r.s === 400, 'listing under 30% off is refused');
  r = await call('POST', '/listings', lst, seller.token); const listing = r.j; ok(r.s === 201 && listing.id, 'valid Lagos listing created');
  r = await call('GET', '/listings'); ok(r.j.length === 1 && !('address' in r.j[0]), 'public list shows the deal without the street address');

  console.log('\n== Order 1: pay, confirm, pick up');
  r = await call('POST', '/orders', { listingId: listing.id, quantity: 2 }, buyer.token);
  const o1 = r.j.order; const ref1 = db._t.order.find((o) => o.id === o1.id).paymentRef;
  if (MODE === 'sim') {
    ok(o1.status === 'RESERVED' && o1.pickupCode, 'simulated mode: paid straight away');
    await app.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
  }
  ok(r.s === 201 && o1.status === 'PENDING_PAYMENT' && /sandboxcashier/.test(r.j.authorizationUrl), 'reserve returns the OPay checkout link');
  ok(o1.pickupCode === null && o1.listing.address === null && o1.listing.seller.phone === null, 'unpaid order hides pickup code, street address and seller phone');
  const c = opayCalls[0]; ok(c.body.amount.total === 410000 && c.body.amount.currency === 'NGN' && c.body.country === 'NG', 'OPay asked for ₦4,100 in kobo (2 x ₦2,000 + ₦100 fee)');
  ok(c.body.expireAt === 10 && c.body.userInfo.userMobile.startsWith('+234') && c.body.returnUrl.includes(ref1) && c.body.callbackUrl === 'https://api.gbaanjo.test/payments/opay/callback', 'expiry, +234 phone, return URL and callback URL are right');
  ok(db._t.listing[0].quantityLeft === 8, 'two units are held while the buyer pays');
  r = await call('POST', '/payments/opay/callback', { payload: { reference: ref1, status: 'SUCCESS', amount: '410000' } }); ok(r.s === 403, 'unsigned callback rejected');
  const forged = signed(ref1, 410000); forged.payload.amount = '1'; r = await call('POST', '/payments/opay/callback', forged); ok(r.s === 403, 'callback with tampered amount rejected');
  r = await call('POST', '/payments/opay/callback', signed(ref1, 410000)); ok(r.s === 200 && db._t.order[0].status === 'PENDING_PAYMENT', 'validly signed callback for a payment OPay does not know about changes nothing');
  opayState[ref1] = { status: 'SUCCESS', amount: 410000, orderNo: 'OPAY001' };
  r = await call('POST', '/payments/opay/callback', signed(ref1, 410000)); await sleep(80);
  ok(r.s === 200 && db._t.order[0].status === 'RESERVED' && db._t.order[0].opayOrderNo === 'OPAY001', 'signed callback + OPay status SUCCESS marks the order paid');
  ok(badStatusSig === 0, 'status requests were signed correctly (HMAC-SHA512 of the body)');
  const code1 = db._t.order[0].pickupCode;
  ok(to('buyer@x.com').some((e) => e.html.includes(code1) && /Your code/.test(e.subject)), 'buyer is emailed the pickup code');
  ok(to('seller@x.com').some((e) => /New order/.test(e.subject)), 'seller is emailed about the new order');
  const before = emails.length; await call('POST', '/payments/opay/callback', signed(ref1, 410000)); await sleep(60); ok(emails.length === before, 'repeated callback does not send duplicate emails');
  r = await call('GET', '/orders/mine', null, buyer.token); const m1 = r.j[0]; ok(m1.pickupCode === code1 && /Admiralty/.test(m1.listing.address) && m1.listing.seller.phone && !('platformFee' in m1) && !('sellerAmount' in m1), 'paid order shows code, address and phone; internal money fields are not exposed');
  r = await call('POST', '/orders/lookup', { code: '000000' }, seller.token); ok(r.s === 400, 'wrong code is not found');
  r = await call('POST', '/orders/lookup', { code: code1 }, seller.token); ok(r.s === 201 && r.j.buyerName, 'right code finds the order');
  r = await call('POST', `/orders/${o1.id}/complete`, { code: code1 }, seller.token); await sleep(60); ok(r.j.ok && db._t.order[0].status === 'PICKED_UP', 'handover completes the order');
  ok(to('buyer@x.com').some((e) => /Enjoy your food/.test(e.subject)), 'buyer is thanked and asked for feedback');

  console.log('\n== Seller payouts');
  r = await call('GET', '/admin/payouts', null, admin); ok(r.j.length === 1 && r.j[0].owed === 3600 && r.j[0].accountNumber === '0123456789' && r.j[0].orderIds.length === 1, 'seller is owed ₦3,600 (₦4,000 minus 10% fee) with bank details shown');
  r = await call('POST', '/admin/payouts/mark-paid', { orderIds: r.j[0].orderIds }, admin); await sleep(60); ok(r.j.ok && to('seller@x.com').some((e) => /payout sent/.test(e.subject)), 'mark paid emails the seller');
  r = await call('GET', '/admin/payouts', null, admin); ok(r.j.length === 0, 'paid-out orders leave the list');
  r = await call('POST', '/admin/payouts/mark-paid', { orderIds: [o1.id] }, admin); ok(r.s === 400, 'cannot pay out the same order twice');

  console.log('\n== Wrong amount, cancel before paying, refund, late payment');
  r = await call('POST', '/orders', { listingId: listing.id, quantity: 1 }, buyer.token); const o2 = r.j.order; const ref2 = db._t.order.find((o) => o.id === o2.id).paymentRef;
  r = await call('POST', '/orders', { listingId: listing.id, quantity: 1 }, buyer.token); ok(r.s === 409, 'a second open order on the same listing is refused');
  opayState[ref2] = { status: 'SUCCESS', amount: 100, orderNo: 'OPAY002' };
  await call('POST', '/payments/opay/callback', signed(ref2, 100)); await sleep(60);
  ok(db._t.order.find((o) => o.id === o2.id).status === 'PENDING_PAYMENT' && to('admin@gbaanjo.com').some((e) => /mismatch/.test(e.subject)), 'a payment with the wrong amount is NOT accepted and the admin is alerted');
  const left = db._t.listing[0].quantityLeft; r = await call('PATCH', `/orders/${o2.id}/cancel`, null, buyer.token); ok(r.j.refund === false && db._t.listing[0].quantityLeft === left + 1, 'cancelling an unpaid order frees the food');
  delete opayState[ref2];
  r = await call('POST', '/orders', { listingId: listing.id, quantity: 1 }, buyer.token); const o3 = r.j.order; const ref3 = db._t.order.find((x) => x.id === o3.id).paymentRef;
  opayState[ref3] = { status: 'SUCCESS', amount: 210000, orderNo: 'OPAY003' };
  r = await call('GET', '/orders/verify/' + ref3, null, buyer.token); ok(r.j.status === 'RESERVED', 'return page: asking OPay directly confirms the payment');
  r = await call('PATCH', `/orders/${o3.id}/cancel`, null, buyer.token); await sleep(60); ok(r.j.refund === true && db._t.order.find((x) => x.id === o3.id).refundDue, 'cancelling a paid order flags a refund');
  ok(to('buyer@x.com').some((e) => /Order .* cancelled/.test(e.subject) && /Refund/.test(e.html)) && to('seller@x.com').some((e) => /was cancelled/.test(e.subject)) && to('admin@gbaanjo.com').some((e) => /Refund to process/.test(e.subject)), 'buyer, seller and admin are all told');
  r = await call('GET', '/admin/refunds', null, admin); ok(r.j.length === 1 && r.j[0].paymentRef === ref3, 'refund appears on the admin list with the OPay reference');
  r = await call('PATCH', `/admin/orders/${o3.id}/refunded`, null, admin); await sleep(60); ok(r.j.ok && to('buyer@x.com').some((e) => /refund .* on its way/.test(e.subject)), 'marking refunded emails the buyer');
  r = await call('POST', '/orders', { listingId: listing.id, quantity: 1 }, buyer.token); const o4 = r.j.order; const ref4 = db._t.order.find((x) => x.id === o4.id).paymentRef;
  await call('PATCH', `/orders/${o4.id}/cancel`, null, buyer.token);
  opayState[ref4] = { status: 'SUCCESS', amount: 210000, orderNo: 'OPAY004' };
  await call('POST', '/payments/opay/callback', signed(ref4, 210000)); await sleep(80);
  const x4 = db._t.order.find((x) => x.id === o4.id); ok(x4.status === 'CANCELLED' && x4.refundDue && x4.paidAt, 'money that arrives after the order was cancelled is flagged for refund, not lost');
  ok(to('buyer@x.com').filter((e) => /cancelled/.test(e.subject)).length >= 2, 'buyer is told about the late payment');

  console.log('\n== The background sweep');
  r = await call('POST', '/orders', { listingId: listing.id, quantity: 3 }, buyer2.token); const o5 = r.j.order; const q5 = db._t.listing[0].quantityLeft;
  db._t.order.find((x) => x.id === o5.id).createdAt = new Date(Date.now() - 15 * min); await sweep();
  ok(db._t.order.find((x) => x.id === o5.id).status === 'CANCELLED' && db._t.listing[0].quantityLeft === q5 + 3, 'unpaid hold older than 12 minutes is released and the food goes back on sale');
  r = await call('POST', '/orders', { listingId: listing.id, quantity: 1 }, buyer2.token); const o6 = r.j.order; const ref6 = db._t.order.find((x) => x.id === o6.id).paymentRef;
  opayState[ref6] = { status: 'SUCCESS', amount: 210000, orderNo: 'OPAY006' }; // paid, but we never heard about it
  db._t.order.find((x) => x.id === o6.id).createdAt = new Date(Date.now() - 3 * min); await sweep();
  ok(db._t.order.find((x) => x.id === o6.id).status === 'RESERVED', 'a payment whose notification was lost is found by asking OPay');
  const row6 = db._t.order.find((x) => x.id === o6.id); db._t.listing[0].pickupBy = new Date(Date.now() + 30 * min); await sweep(); await sleep(60);
  ok(row6.reminderSentAt && to('buyer2@x.com').some((e) => /Reminder/.test(e.subject)), 'pickup reminder sent about an hour before the deadline');
  const n = emails.length; await sweep(); await sleep(40); ok(emails.length === n, 'the reminder is only sent once');
  db._t.listing[0].pickupBy = new Date(Date.now() - min); await sweep(); await sleep(60);
  ok(row6.status === 'EXPIRED' && db._t.user.find((u) => u.email === 'buyer2@x.com').noShows === 1, 'missed pickup: order closed, no-show counted');
  ok(to('buyer2@x.com').some((e) => /missed/.test(e.subject)) && to('seller@x.com').some((e) => /did not collect/.test(e.subject)), 'buyer and seller are told about the missed pickup');
  r = await call('GET', '/admin/payouts', null, admin); ok(r.j.length === 1 && r.j[0].owed === 1800, 'a missed pickup counts toward the seller payout (seller keeps the money)');

  console.log('\n== Seller cancels a listing with a paid order');
  const lst2 = { ...lst, title: 'Bread', category: 'Bakery', originalPrice: 2000, price: 1000, quantity: 5 }; r = await call('POST', '/listings', lst2, seller.token); const l2 = r.j;
  r = await call('POST', '/orders', { listingId: l2.id, quantity: 1 }, buyer.token); const o7 = r.j.order; const ref7 = db._t.order.find((x) => x.id === o7.id).paymentRef;
  opayState[ref7] = { status: 'SUCCESS', amount: 110000, orderNo: 'OPAY007' }; await call('GET', '/orders/verify/' + ref7, null, buyer.token);
  r = await call('PATCH', `/listings/${l2.id}/cancel`, null, seller.token); await sleep(80);
  ok(db._t.order.find((x) => x.id === o7.id).status === 'CANCELLED' && db._t.order.find((x) => x.id === o7.id).refundDue && to('buyer@x.com').some((e) => /Order .* cancelled/.test(e.subject) && /seller cancelled/.test(e.html)), 'paid buyer is refunded-flagged and emailed when the seller cancels');

  console.log('\n== Accounts, city, feedback');
  r = await call('POST', '/auth/forgot-password', { email: 'nobody@x.com' }); ok(r.j.ok && to('nobody@x.com').length === 0, 'forgot password gives the same answer for unknown emails');
  r = await call('POST', '/auth/forgot-password', { email: 'buyer@x.com' }); await sleep(60);
  const link = to('buyer@x.com').find((e) => /Reset your/.test(e.subject)).html.match(/reset-password\?token=([a-f0-9]+)/); ok(!!link, 'reset email contains a link to the site');
  r = await call('POST', '/auth/reset-password', { token: link[1], password: 'newpassword9' }); ok(r.j.ok, 'password reset works');
  r = await call('POST', '/auth/reset-password', { token: link[1], password: 'another12345' }); ok(r.s === 400, 'reset link cannot be used twice');
  r = await call('POST', '/auth/login', { email: 'buyer@x.com', password: 'password1' }); ok(r.s === 401, 'old password no longer works');
  r = await call('POST', '/auth/login', { email: 'buyer@x.com', password: 'newpassword9' }); ok(r.j.token, 'new password works');
  r = await call('PATCH', '/auth/city', { city: 'Abuja' }, buyer.token); ok(r.s === 400, 'cannot set a non-live city');
  r = await call('PATCH', '/auth/city', { city: 'Lagos' }, buyer.token); ok(r.j.city === 'Lagos', 'user can confirm their city');
  r = await call('POST', '/feedback', { category: 'BUG', message: 'The page froze when I paid' }); await sleep(60); ok(r.j.ok && to('admin@gbaanjo.com').some((e) => /feedback/.test(e.subject)), 'anonymous bug feedback saved; admin alerted');
  r = await call('POST', '/feedback', { message: 'ok' }); ok(r.s === 400, 'too-short feedback refused');
  r = await call('GET', '/admin/feedback', null, admin); ok(r.j.length === 1, 'admin can list feedback'); r = await call('PATCH', '/admin/feedback/' + r.j[0].id, { status: 'DONE' }, admin); ok(r.j.ok, 'admin can mark feedback done');
  r = await call('POST', '/waitlist', { email: 'abuja@x.com', city: 'Abuja' }); ok(r.j.ok, 'waitlist signup works');
  r = await call('GET', '/admin/overview', null, buyer.token); ok(r.s === 403, 'buyers cannot open admin pages');
  r = await call('GET', '/health'); ok(r.j.ok && r.j.db, 'health check works');
  r = await call('GET', '/admin/overview', null, admin); ok(r.j.waitlist === 1 && r.j.refundsPending >= 1, 'admin overview shows waitlist and pending refunds');

  await app.close(); console.log(`\n${passed} passed, ${failed} failed`); process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(2); });
