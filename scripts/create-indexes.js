// ─────────────────────────────────────────────────────────────
// npm run db:indexes
//
// Creates the partial unique indexes listed in server/mongo-indexes.js —
// the uniqueness rules Prisma's schema language cannot express.
// Run it after `npx prisma db push` (which creates every other index).
// Safe to run again: an index that already exists is left alone.
// ─────────────────────────────────────────────────────────────
require('./load-env');
const { base: prisma } = require('../server/prisma');
const INDEXES = require('../server/mongo-indexes');

(async () => {
  for (const ix of INDEXES) {
    try {
      // $runCommandRaw sends a raw MongoDB command — here "createIndexes"
      await prisma.$runCommandRaw({
        createIndexes: ix.collection,
        indexes: [{ key: ix.key, name: ix.name, unique: true, partialFilterExpression: ix.partialFilterExpression }],
      });
      console.log(`✔ ${ix.collection}.${ix.name}`);
    } catch (e) {
      // 85/86 = an index with this name/key already exists with other options
      if (/already exists|IndexOptionsConflict|IndexKeySpecsConflict/i.test(e.message)) console.log(`• ${ix.collection}.${ix.name} already exists`);
      else { console.error(`✖ ${ix.collection}.${ix.name}: ${e.message}`); process.exitCode = 1; }
    }
  }
  await prisma.$disconnect();
})();
