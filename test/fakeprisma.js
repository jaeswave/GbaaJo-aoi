// A tiny in-memory stand-in for Prisma, just enough to run GbaanJo's logic in a test without a database.
function test(val, cond) {
  if (cond === null) return val == null;
  if (cond instanceof Date || typeof cond !== 'object') return (val instanceof Date || cond instanceof Date) ? +val === +cond : (val ?? null) === cond;
  return Object.entries(cond).every(([op, x]) => {
    switch (op) {
      case 'in': return x.includes(val);
      case 'not': return !test(val, x);
      case 'gt': return val > x; case 'gte': return val >= x; case 'lt': return val < x; case 'lte': return val <= x;
      case 'endsWith': return String(val).endsWith(x);
      case 'contains': return String(val).toLowerCase().includes(String(x).toLowerCase());
      case 'mode': return true;
      default: throw new Error('fake prisma: unsupported operator ' + op);
    }
  });
}
module.exports = function makeDb() {
  const t = { user: [], listing: [], order: [], feedback: [], waitlist: [] };
  let n = 1; const newId = () => 'id' + n++;
  const clone = (x) => structuredClone(x);
  const rels = {
    order: { listing: (o) => ['listing', t.listing.find((x) => x.id === o.listingId)], buyer: (o) => ['user', t.user.find((x) => x.id === o.buyerId)] },
    listing: { seller: (l) => ['user', t.user.find((x) => x.id === l.sellerId)] },
    feedback: { user: (f) => ['user', t.user.find((x) => x.id === f.userId)] },
  };
  function match(model, row, where) {
    return Object.entries(where || {}).every(([k, v]) => {
      if (k === 'OR') return v.some((w) => match(model, row, w));
      if (rels[model] && rels[model][k] && v && typeof v === 'object') { const [m, r] = rels[model][k](row); return !!r && match(m, r, v); }
      return test(row[k], v);
    });
  }
  function attach(model, row, args) {
    const r = clone(row);
    const want = { ...(args?.include || {}), ...(args?.select || {}) };
    for (const [k, v] of Object.entries(want)) {
      if (rels[model] && rels[model][k] && v) {
        const [m, rr] = rels[model][k](row);
        r[k] = rr ? attach(m, rr, typeof v === 'object' ? v : undefined) : null;
      }
    }
    if (args?.select) { // like Prisma: with `select`, only the chosen fields come back
      const out = {};
      for (const [k, v] of Object.entries(args.select)) if (v && k in r) out[k] = r[k];
      return out;
    }
    return r;
  }
  const defaults = {
    user: () => ({ role: 'BUYER', city: 'Lagos', approvalStatus: 'APPROVED', verified: false, suspended: false, noShows: 0 }),
    listing: () => ({ status: 'ACTIVE' }),
    order: () => ({ status: 'PENDING_PAYMENT', buyerFee: 0, amountPaid: 0, refundDue: false }),
    feedback: () => ({ category: 'GENERAL', status: 'NEW' }), waitlist: () => ({}),
  };
  const uniques = { user: ['email', 'rcNumber'], order: ['orderNo', 'paymentRef'], waitlist: ['email'] };
  function applyData(row, data) {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && ('increment' in v || 'decrement' in v)) row[k] = (row[k] || 0) + (v.increment || 0) - (v.decrement || 0);
      else row[k] = v === undefined ? row[k] : v;
    }
    row.updatedAt = new Date();
  }
  const model = (name) => ({
    create: async ({ data, ...a }) => {
      for (const u of uniques[name] || []) if (data[u] != null && t[name].some((x) => x[u] === data[u])) throw new Error('Unique constraint failed on ' + u);
      const row = { id: newId(), createdAt: new Date(), updatedAt: new Date(), ...defaults[name](), ...clone(data) };
      for (const k of Object.keys(row)) if (row[k] === undefined) row[k] = null;
      t[name].push(row); return attach(name, row, a);
    },
    findUnique: async ({ where, ...a }) => { const r = t[name].find((x) => match(name, x, where)); return r ? attach(name, r, a) : null; },
    findFirst: async ({ where, ...a }) => { const r = t[name].find((x) => match(name, x, where)); return r ? attach(name, r, a) : null; },
    findMany: async ({ where, orderBy, take, ...a } = {}) => {
      let rows = t[name].filter((x) => match(name, x, where));
      if (orderBy) { const [k, d] = Object.entries(orderBy)[0]; rows = [...rows].sort((p, q) => (p[k] > q[k] ? 1 : p[k] < q[k] ? -1 : 0) * (d === 'desc' ? -1 : 1)); }
      if (take) rows = rows.slice(0, take);
      return rows.map((r) => attach(name, r, a));
    },
    count: async ({ where } = {}) => t[name].filter((x) => match(name, x, where)).length,
    update: async ({ where, data, ...a }) => { const r = t[name].find((x) => match(name, x, where)); if (!r) throw new Error('Record not found'); applyData(r, data); return attach(name, r, a); },
    updateMany: async ({ where, data }) => { const rows = t[name].filter((x) => match(name, x, where)); rows.forEach((r) => applyData(r, data)); return { count: rows.length }; },
    upsert: async ({ where, update, create }) => { const r = t[name].find((x) => match(name, x, where)); if (r) { applyData(r, update); return clone(r); } return model(name).create({ data: create }); },
    createMany: async ({ data }) => { for (const d of data) await model(name).create({ data: d }); return { count: data.length }; },
    aggregate: async ({ where, _sum }) => { const rows = t[name].filter((x) => match(name, x, where)); const o = {}; for (const k of Object.keys(_sum)) o[k] = rows.reduce((s, r) => s + (r[k] || 0), 0); return { _sum: o }; },
  });
  const db = { _t: t, user: model('user'), listing: model('listing'), order: model('order'), feedback: model('feedback'), waitlist: model('waitlist'),
    $transaction: async (fn) => fn(db), $queryRaw: async () => [{ '?column?': 1 }], $connect: async () => {}, $disconnect: async () => {}, onModuleInit: async () => {} };
  return db;
};
