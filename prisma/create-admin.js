const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();
const [email, password, name = 'ChopNow Admin'] = process.argv.slice(2);

if (!email || !password || password.length < 12) {
  console.log('Usage: node prisma/create-admin.js you@email.com "a-password-of-12-or-more-characters" "Your Name"');
  process.exit(1);
}
(async () => {
  const e = email.toLowerCase();
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.upsert({
    where: { email: e },
    update: { role: 'ADMIN', passwordHash, suspended: false, emailVerifiedAt: new Date(), approvalStatus: 'APPROVED' },
    create: { email: e, name, phone: '08000000000', role: 'ADMIN', passwordHash, emailVerifiedAt: new Date(), approvalStatus: 'APPROVED' },
  });
  console.log('Admin ready:', e);
})().catch(console.error).finally(() => prisma.$disconnect());
