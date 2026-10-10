// Run ONCE on your local test database so old test accounts are not locked out by email verification.
// Never run this on a live database with real users.
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
prisma.user.updateMany({ where: { emailVerifiedAt: null }, data: { emailVerifiedAt: new Date() } })
  .then((r) => console.log('Marked', r.count, 'existing users as verified'))
  .finally(() => prisma.$disconnect());
