// Demo logins for all three apps — created (or repaired) on every start-up,
// so they work on a fresh database AND on one that already holds real data.
// Only these dedicated demo accounts are touched; real users are never changed.
// Turn off with DEMO_LOGINS=0 in .env (recommended once you go live).
const bcrypt = require('bcryptjs');
const { prisma } = require('./prisma');

const DEMO = {
  crm: { username: 'demo', password: 'demo123', name: 'Demo Owner' },
  driver: { pin: '0000', name: 'Demo Driver' },
  customer: { phone: '+971500009999', code: '9999', name: 'Demo Supermarket', branch: 'Demo Branch' },
};

async function ensureDemoLogins() {
  if (process.env.DEMO_LOGINS === '0') return;
  try {
    // CRM (owner/admin)
    const admin = await prisma.user.findFirst({ where: { role: 'admin', username: DEMO.crm.username } });
    const adminData = { password_hash: bcrypt.hashSync(DEMO.crm.password, 10), is_active: 1, crm_role: 'owner' };
    if (admin) await prisma.user.update({ where: { id: admin.id }, data: adminData });
    else await prisma.user.create({ data: { full_name: DEMO.crm.name, role: 'admin', username: DEMO.crm.username, phone: '+971500009990', ...adminData } });

    // Driver (PIN login) — gets the first truck so the app has a vehicle
    const driver = await prisma.user.findFirst({ where: { role: 'driver', full_name: DEMO.driver.name } });
    const truck = await prisma.vehicle.findFirst({ orderBy: { id: 'asc' }, select: { id: true } });
    const driverData = { pin_hash: bcrypt.hashSync(DEMO.driver.pin, 10), is_active: 1 };
    if (driver) await prisma.user.update({ where: { id: driver.id }, data: { ...driverData, vehicle_id: driver.vehicle_id ?? (truck && truck.id) } });
    else await prisma.user.create({ data: { full_name: DEMO.driver.name, role: 'driver', phone: '+971500009991', vehicle_id: truck ? truck.id : null, ...driverData } });

    // Customer (mobile + 4-digit code)
    const cust = await prisma.customer.findFirst({ where: { name: DEMO.customer.name, contact_phone: DEMO.customer.phone } });
    const custData = { portal_code_hash: bcrypt.hashSync(DEMO.customer.code, 10), is_active: 1 };
    if (cust) await prisma.customer.update({ where: { id: cust.id }, data: custData });
    else await prisma.customer.create({
      data: {
        name: DEMO.customer.name, branch: DEMO.customer.branch, zone: 'Deira', frequency: 2,
        lat: 25.2697, lng: 55.3094, address: 'Deira, Demo Street, Dubai', contact_phone: DEMO.customer.phone, ...custData,
      },
    });

    console.log(`✔ Demo logins ready — CRM: ${DEMO.crm.username} / ${DEMO.crm.password} · Driver PIN: ${DEMO.driver.pin} · Customer: 050 000 9999 / code ${DEMO.customer.code}`);
  } catch (e) { console.warn('Demo logins:', e.message); }
}

module.exports = { ensureDemoLogins, DEMO };
