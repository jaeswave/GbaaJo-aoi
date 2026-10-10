const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();
const H = 3600000;

// item = [title, description, category, originalPrice, price, quantity, quantityLeft, hoursLeft]
const sellers = [
  { email: 'mamatee@seed.chopnow.ng', name: 'Tolani Adeyemi', phone: '08031234501', businessName: 'Mama Tee Kitchen', city: 'Lagos', area: 'Lekki Phase 1', address: '12 Admiralty Way, Lekki Phase 1', items: [
    ['Party jollof rice and chicken, 10 packs', 'Cooked this afternoon and kept warm. Rice, chicken and fried plantain in each pack.', 'Cooked meals', 6000, 2500, 10, 6, 3],
    ['Fried rice and turkey packs', 'Made today at 1pm. Comes with coleslaw.', 'Cooked meals', 5500, 2200, 8, 2, 2],
  ] },
  { email: 'sweetcrust@seed.chopnow.ng', name: 'Bisi Alabi', phone: '08031234502', businessName: 'Sweet Crust Bakery', city: 'Lagos', area: 'Yaba', address: '45 Herbert Macaulay Way, Yaba', items: [
    ['Fresh sliced bread, 12 loaves', 'Baked this morning. Soft sandwich loaf.', 'Bakery', 1500, 700, 12, 12, 6],
    ['Meat pies, box of 6', 'Baked today with beef filling. Best eaten today.', 'Bakery', 3000, 1400, 10, 4, 4],
    ['Doughnuts, box of 12', 'Baked this morning.', 'Bakery', 4000, 1800, 6, 6, 5],
  ] },
  { email: 'musa@seed.chopnow.ng', name: 'Musa Ibrahim', phone: '08031234503', businessName: 'Mallam Musa Fresh Produce', city: 'Abuja', area: 'Garki', address: 'Shop 14, Garki Model Market, Area 10', items: [
    ['Basket of fresh tomatoes and pepper', 'Ripe, best used within 1 to 2 days. Tomatoes and tatashe mixed.', 'Fresh produce', 8000, 3500, 15, 9, 10],
    ['Ugu and waterleaf, 20 bunches', 'Picked this morning.', 'Fresh produce', 4000, 1600, 20, 20, 7],
    ['Very ripe plantain, 2 big bunches', 'Perfect for dodo.', 'Fresh produce', 3500, 1500, 10, 3, 18],
  ] },
  { email: 'freshmart@seed.chopnow.ng', name: 'Ngozi Eze', phone: '08031234504', businessName: 'FreshMart Supermarket', city: 'Abuja', area: 'Wuse 2', address: '8 Ademola Adetokunbo Crescent, Wuse 2', items: [
    ['Frozen chicken, 10 packs of 2kg', 'Kept frozen. Best before this weekend.', 'Frozen foods', 14000, 8500, 10, 8, 24],
    ['Instant noodles, 10 cartons', 'Cartons slightly dented, contents fine. Best before is 3 months away.', 'Groceries', 7500, 4500, 10, 10, 30],
  ] },
  { email: 'deltafish@seed.chopnow.ng', name: 'Ebiere Peters', phone: '08031234505', businessName: 'Delta Fish Hub', city: 'Port Harcourt', area: 'GRA Phase 2', address: '21 Tombia Street, GRA Phase 2', items: [
    ['Fresh tilapia, 5kg', 'Iced this morning. Cleaned on request.', 'Meat & fish', 12000, 6500, 6, 4, 8],
    ['Fresh catfish, 3kg', 'Gutted and iced. Good for pepper soup.', 'Meat & fish', 9000, 4800, 5, 5, 6],
  ] },
  { email: 'ibadandairy@seed.chopnow.ng', name: 'Funmi Ogunleye', phone: '08031234506', businessName: 'Ibadan Dairy Corner', city: 'Ibadan', area: 'Bodija', address: '7 Bodija Market Road, Bodija', items: [
    ['Fura da nono, 20 bottles', 'Made today. Keep chilled.', 'Dairy & drinks', 6000, 2800, 20, 14, 5],
    ['Plain yoghurt tubs, 15 tubs', 'Keep refrigerated. Two days to best before.', 'Dairy & drinks', 4500, 2000, 15, 15, 20],
  ] },
  { email: 'kanosuya@seed.chopnow.ng', name: 'Abubakar Sani', phone: '08031234507', businessName: 'Kano Suya Spot', city: 'Kano', area: 'Nassarawa GRA', address: '3 Zoo Road, Nassarawa GRA', items: [
    ['Beef suya packs, 12 packs', 'Grilled this evening, wrapped with onions and yaji.', 'Snacks & small chops', 3000, 1300, 12, 7, 2],
    ['Small chops party tray', 'Puff puff, spring rolls, samosa and wings. Left over from an event.', 'Snacks & small chops', 25000, 11000, 3, 3, 3],
  ] },
  { email: 'mamaput@seed.chopnow.ng', name: 'Joy Okeke', phone: '08031234508', businessName: 'Mama Put Joy', city: 'Enugu', area: 'Independence Layout', address: '19 Okpara Avenue, Independence Layout', items: [
    ['Egusi soup with pounded yam, 8 plates', 'Cooked at noon with assorted meat.', 'Cooked meals', 3500, 1500, 8, 5, 3],
    ['Ofe onugbu and fufu, 6 plates', 'Bitterleaf soup, fresh today.', 'Cooked meals', 3200, 1400, 6, 6, 4],
  ] },
];

async function main() {
  // Remove earlier seed data so this script is safe to run again
  const old = await prisma.user.findMany({ where: { email: { endsWith: '@seed.chopnow.ng' } }, select: { id: true } });
  const ids = old.map((u) => u.id);
  await prisma.order.deleteMany({ where: { OR: [{ buyerId: { in: ids } }, { listing: { sellerId: { in: ids } } }] } });
  await prisma.listing.deleteMany({ where: { sellerId: { in: ids } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  if (process.argv.includes('--clean')) return console.log('Seed data removed.');

  const passwordHash = await bcrypt.hash('Password123!', 10);
  await prisma.user.create({ data: { email: 'buyer@seed.chopnow.ng', name: 'Chidinma Okafor', phone: '08021234567', role: 'BUYER', passwordHash, emailVerifiedAt: new Date() } });

  for (const s of sellers) {
    const u = await prisma.user.create({ data: { email: s.email, name: s.name, phone: s.phone, role: 'SELLER', businessName: s.businessName, passwordHash, subaccountCode: 'DEV_SUBACCOUNT', bankName: 'Demo Bank', accountName: s.name, emailVerifiedAt: new Date(), verified: true, rcNumber: 'RC9000' + String(sellers.indexOf(s)).padStart(2, '0') } });
    await prisma.listing.createMany({
      data: s.items.map(([title, description, category, originalPrice, price, quantity, quantityLeft, hours]) => {
        const saleEndsAt = new Date(Date.now() + hours * H);
        return { sellerId: u.id, title, description, category, city: s.city, area: s.area, address: s.address, originalPrice, price, quantity, quantityLeft, saleEndsAt, pickupBy: new Date(saleEndsAt.getTime() + 2 * H) };
      }),
    });
  }
  console.log('Seeded 8 sellers, 1 buyer and their listings. Password for all: Password123!');
}
main().catch(console.error).finally(() => prisma.$disconnect());
