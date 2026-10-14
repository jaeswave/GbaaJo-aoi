import * as bcrypt from 'bcryptjs';
import { randomBytes } from 'crypto';
import { PrismaService } from './prisma.service';

export const DEMO_DOMAIN = '@demo.gbaanjo.local';
const H = 3600000;

// [title, description, category, originalPrice, price, quantity, quantityLeft, hoursLeft]
const DEMO = [
  { slug: 'mamatee', name: 'Tolani Adeyemi', phone: '08031234501', businessName: 'Mama Tee Kitchen', city: 'Lagos', area: 'Lekki Phase 1', address: '12 Admiralty Way, Lekki Phase 1', items: [
    ['Party jollof rice and chicken, 10 packs', 'Cooked this afternoon and kept warm. Rice, chicken and fried plantain in each pack.', 'Cooked meals', 6000, 2500, 10, 6, 5],
    ['Fried rice and turkey packs', 'Made today at 1pm. Comes with coleslaw.', 'Cooked meals', 5500, 2200, 8, 3, 4],
  ] },
  { slug: 'sweetcrust', name: 'Bisi Alabi', phone: '08031234502', businessName: 'Sweet Crust Bakery', city: 'Lagos', area: 'Yaba', address: '45 Herbert Macaulay Way, Yaba', items: [
    ['Fresh sliced bread, 12 loaves', 'Baked this morning. Soft sandwich loaf.', 'Bakery', 1500, 700, 12, 12, 8],
    ['Meat pies, box of 6', 'Baked today with beef filling. Best eaten today.', 'Bakery', 3000, 1400, 10, 4, 6],
    ['Doughnuts, box of 12', 'Baked this morning.', 'Bakery', 4000, 1800, 6, 6, 7],
  ] },
  { slug: 'musa', name: 'Musa Ibrahim', phone: '08031234503', businessName: 'Mallam Musa Fresh Produce', city: 'Abuja', area: 'Garki', address: 'Shop 14, Garki Model Market, Area 10', items: [
    ['Basket of fresh tomatoes and pepper', 'Ripe, best used within 1 to 2 days. Tomatoes and tatashe mixed.', 'Fresh produce', 8000, 3500, 15, 9, 12],
    ['Ugu and waterleaf, 20 bunches', 'Picked this morning.', 'Fresh produce', 4000, 1600, 20, 20, 9],
    ['Very ripe plantain, 2 big bunches', 'Perfect for dodo.', 'Fresh produce', 3500, 1500, 10, 3, 20],
  ] },
  { slug: 'freshmart', name: 'Ngozi Eze', phone: '08031234504', businessName: 'FreshMart Supermarket', city: 'Abuja', area: 'Wuse 2', address: '8 Ademola Adetokunbo Crescent, Wuse 2', items: [
    ['Frozen chicken, 10 packs of 2kg', 'Kept frozen. Best before this weekend.', 'Frozen foods', 14000, 8500, 10, 8, 26],
    ['Instant noodles, 10 cartons', 'Cartons slightly dented, contents fine. Best before is 3 months away.', 'Groceries', 7500, 4500, 10, 10, 30],
  ] },
  { slug: 'deltafish', name: 'Ebiere Peters', phone: '08031234505', businessName: 'Delta Fish Hub', city: 'Port Harcourt', area: 'GRA Phase 2', address: '21 Tombia Street, GRA Phase 2', items: [
    ['Fresh tilapia, 5kg', 'Iced this morning. Cleaned on request.', 'Meat & fish', 12000, 6500, 6, 4, 10],
    ['Fresh catfish, 3kg', 'Gutted and iced. Good for pepper soup.', 'Meat & fish', 9000, 4800, 5, 5, 8],
  ] },
  { slug: 'ibadandairy', name: 'Funmi Ogunleye', phone: '08031234506', businessName: 'Ibadan Dairy Corner', city: 'Ibadan', area: 'Bodija', address: '7 Bodija Market Road, Bodija', items: [
    ['Fura da nono, 20 bottles', 'Made today. Keep chilled.', 'Dairy & drinks', 6000, 2800, 20, 14, 7],
    ['Plain yoghurt tubs, 15 tubs', 'Keep refrigerated. Two days to best before.', 'Dairy & drinks', 4500, 2000, 15, 15, 22],
  ] },
  { slug: 'kanosuya', name: 'Abubakar Sani', phone: '08031234507', businessName: 'Kano Suya Spot', city: 'Kano', area: 'Nassarawa GRA', address: '3 Zoo Road, Nassarawa GRA', items: [
    ['Beef suya packs, 12 packs', 'Grilled this evening, wrapped with onions and yaji.', 'Snacks & small chops', 3000, 1300, 12, 7, 5],
    ['Small chops party tray', 'Puff puff, spring rolls, samosa and wings. Left over from an event.', 'Snacks & small chops', 25000, 11000, 3, 3, 6],
  ] },
  { slug: 'mamaput', name: 'Joy Okeke', phone: '08031234508', businessName: 'Mama Put Joy', city: 'Enugu', area: 'Independence Layout', address: '19 Okpara Avenue, Independence Layout', items: [
    ['Egusi soup with pounded yam, 8 plates', 'Cooked at noon with assorted meat.', 'Cooked meals', 3500, 1500, 8, 5, 5],
    ['Ofe onugbu and fufu, 6 plates', 'Bitterleaf soup, fresh today.', 'Cooked meals', 3200, 1400, 6, 6, 6],
  ] },
] as const;

/**
 * Test version only (SEED_DEMO=true). Adds demo sellers and fresh demo listings.
 * Demo sellers have a random password nobody knows, so they cannot be logged into.
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
        email: s.slug + DEMO_DOMAIN, name: s.name, phone: s.phone, role: 'SELLER', businessName: s.businessName, passwordHash,
        emailVerifiedAt: new Date(), approvalStatus: 'APPROVED', verified: true, rcNumber: 'RC91000' + String(i).padStart(2, '0'),
        subaccountCode: 'TEST_NO_SPLIT', bankName: 'Demo Bank', accountName: s.name,
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
