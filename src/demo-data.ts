import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';

export const DEMO_DOMAIN = '@demo.gbaanjo.local';
const H = 3600000;

// [title, description, category, originalPrice, price, quantity, quantityLeft, hoursLeft]
// All demo sellers are in Lagos, because that is the only live city.
const DEMO = [
  { slug: 'mamatee', name: 'Tolani Adeyemi', phone: '08031234501', businessName: 'Mama Tee Kitchen', city: 'Lagos', area: 'Lekki Phase 1', address: '12 Admiralty Way, Lekki Phase 1', items: [
    ['Party jollof rice and chicken, 10 packs', 'Cooked this afternoon and kept warm. Rice, chicken and fried plantain in each pack.', 'Cooked meals', 6000, 2500, 10, 6, 5],
    ['Fried rice and turkey packs', 'Made today at 1pm. Comes with coleslaw.', 'Cooked meals', 5500, 2200, 8, 3, 4],
  ] },
  { slug: 'sweetcrust', name: 'Bisi Alabi', phone: '08031234502', businessName: 'Sweet Crust Bakery', city: 'Lagos', area: 'Yaba', address: '45 Herbert Macaulay Way, Yaba', items: [
    ['Fresh sliced bread, 12 loaves', 'Baked this morning. Soft sandwich loaf.', 'Bakery', 1500, 700, 12, 12, 8],
    ['Meat pies, box of 6', 'Baked today with beef filling. Best eaten today.', 'Bakery', 3000, 1400, 10, 4, 6],
  ] },
  { slug: 'musa', name: 'Musa Ibrahim', phone: '08031234503', businessName: 'Mallam Musa Fresh Produce', city: 'Lagos', area: 'Ketu', address: 'Shop 14, Mile 12 Market, Ketu', items: [
    ['Basket of fresh tomatoes and pepper', 'Ripe, best used within 1 to 2 days. Tomatoes and tatashe mixed.', 'Fresh produce', 8000, 3500, 15, 9, 12],
    ['Very ripe plantain, 2 big bunches', 'Perfect for dodo.', 'Fresh produce', 3500, 1500, 10, 3, 20],
  ] },
  { slug: 'freshmart', name: 'Ngozi Eze', phone: '08031234504', businessName: 'FreshMart Supermarket', city: 'Lagos', area: 'Victoria Island', address: '8 Adeola Odeku Street, Victoria Island', items: [
    ['Frozen chicken, 10 packs of 2kg', 'Kept frozen. Best before this weekend.', 'Frozen foods', 14000, 8500, 10, 8, 26],
    ['Instant noodles, 10 cartons', 'Cartons slightly dented, contents fine. Best before is 3 months away.', 'Groceries', 7500, 4500, 10, 10, 30],
  ] },
  { slug: 'lagosfish', name: 'Ebiere Peters', phone: '08031234505', businessName: 'Lagos Fish Hub', city: 'Lagos', area: 'Ajah', address: '21 Abraham Adesanya Road, Ajah', items: [
    ['Fresh tilapia, 5kg', 'Iced this morning. Cleaned on request.', 'Meat & fish', 12000, 6500, 6, 4, 10],
  ] },
  { slug: 'ikejadairy', name: 'Funmi Ogunleye', phone: '08031234506', businessName: 'Ikeja Dairy Corner', city: 'Lagos', area: 'Ikeja GRA', address: '7 Isaac John Street, Ikeja GRA', items: [
    ['Fura da nono, 20 bottles', 'Made today. Keep chilled.', 'Dairy & drinks', 6000, 2800, 20, 14, 7],
  ] },
  { slug: 'surulerasuya', name: 'Abubakar Sani', phone: '08031234507', businessName: 'Surulere Suya Spot', city: 'Lagos', area: 'Surulere', address: '3 Bode Thomas Street, Surulere', items: [
    ['Beef suya packs, 12 packs', 'Grilled this evening, wrapped with onions and yaji.', 'Snacks & small chops', 3000, 1300, 12, 7, 5],
    ['Small chops party tray', 'Puff puff, spring rolls, samosa and wings. Left over from an event.', 'Snacks & small chops', 25000, 11000, 3, 3, 6],
  ] },
] as const;

/**
 * Test version only (SEED_DEMO=true). Adds demo sellers and fresh demo listings.
 * Demo sellers have a random password nobody knows, so they cannot be logged into, and their orders cannot be paid with real OPay.
 * Listings are only added when a demo seller has no listing with at least 30 minutes left, so it is safe to run on every start.
 */
export async function refreshDemoData(prisma: PrismaService) {
  const passwordHash = await bcrypt.hash(randomBytes(24).toString('hex'), 10);
  const now = Date.now();
  for (let i = 0; i < DEMO.length; i++) {
    const s = DEMO[i];
    const seller = await prisma.user.upsert({
      where: { email: s.slug + DEMO_DOMAIN },
      update: { suspended: false },
      create: {
        email: s.slug + DEMO_DOMAIN, name: s.name, phone: s.phone, role: 'SELLER', city: s.city, businessName: s.businessName, passwordHash,
        emailVerifiedAt: new Date(), approvalStatus: 'APPROVED', verified: true, rcNumber: 'RC91000' + String(i).padStart(2, '0'),
        bankName: 'Demo Bank', accountName: s.name, accountNumber: '0000000000',
      },
    });
    const live = await prisma.listing.count({ where: { sellerId: seller.id, status: 'ACTIVE', saleEndsAt: { gt: new Date(now + 30 * 60000) } } });
    if (live > 0) continue;
    await prisma.listing.createMany({
      data: s.items.map(([title, description, category, originalPrice, price, quantity, quantityLeft, hours]) => {
        const saleEndsAt = new Date(now + hours * H);
        return { sellerId: seller.id, title, description: description + ' (Demo listing for the test version.)', category, city: s.city, area: s.area, address: s.address, originalPrice, price, quantity, quantityLeft, saleEndsAt, pickupBy: new Date(saleEndsAt.getTime() + 2 * H) };
      }),
    });
  }
}
