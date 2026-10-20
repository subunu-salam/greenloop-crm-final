// ─────────────────────────────────────────────────────────────
// Partial unique indexes — rules Prisma's schema language can't express.
//
// Example: "a pickup may earn reward points only once". Only documents with
// kind = 'earn' AND a numeric pickup_id are checked; manual adjustments
// (pickup_id = null) can repeat freely.
//
// Created by `npm run db:indexes` (scripts/create-indexes.js) after
// `npx prisma db push`. The test database double reads this same list, so the
// tests enforce exactly what MongoDB enforces.
// ─────────────────────────────────────────────────────────────
module.exports = [
  {
    collection: 'pickups', model: 'Pickup', name: 'ux_pickups_plan_date',
    key: { plan_id: 1, scheduled_date: 1 },
    partialFilterExpression: { plan_id: { $type: 'number' }, is_revisit: 0 },
  },
  {
    collection: 'reward_points', model: 'RewardPoint', name: 'ux_reward_earn_pickup',
    key: { pickup_id: 1 },
    partialFilterExpression: { kind: 'earn', pickup_id: { $type: 'number' } },
  },
  {
    collection: 'users', model: 'User', name: 'ux_users_username',
    key: { username: 1 },
    partialFilterExpression: { username: { $type: 'string' } },
  },
];
