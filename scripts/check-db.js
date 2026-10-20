// ─────────────────────────────────────────────────────────────
// npm run db:check
//
// "Is my database working?" — connects with DATABASE_URL, checks that
// MongoDB runs as a replica set (Prisma needs that), and prints how many
// documents each GreenLoop collection holds.
// ─────────────────────────────────────────────────────────────
require('./load-env');
const { base: prisma, MODELS } = require('../server/prisma');

(async () => {
  const url = process.env.DATABASE_URL || '';
  console.log('DATABASE_URL:', url ? url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:****@') : '(not set — copy .env.example to .env)');
  try {
    const hello = await prisma.$runCommandRaw({ hello: 1 });
    if (!hello.setName) {
      console.log('\n✖ Connected, but MongoDB is NOT running as a replica set. Prisma needs one.');
      console.log('  Fix: see docs/MONGODB-SETUP.md, step 2 (replication + rs.initiate()).');
      process.exitCode = 1;
    } else {
      console.log(`✔ Connected to replica set "${hello.setName}"\n`);
    }
    for (const m of Object.values(MODELS)) {
      const n = await prisma[m.delegate].count();
      console.log(`  ${m.collection.padEnd(28)} ${String(n).padStart(7)}`);
    }
  } catch (e) {
    console.error('\n✖ Could not connect:', e.message.split('\n').slice(-3).join(' '));
    console.error('  Is MongoDB running? Is DATABASE_URL in .env correct?');
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
