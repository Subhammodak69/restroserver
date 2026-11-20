require('dotenv').config();
const { getPool } = require('../src/config/database');
const { hashPassword } = require('../src/utils/security');
const { normalizePhone } = require('../src/utils/phone');

async function createAdmin() {
  const phone = normalizePhone(process.env.ADMIN_PHONE);
  const password = String(process.env.ADMIN_PASSWORD || '');
  const name = String(process.env.ADMIN_NAME || 'Restaurant Manager').trim();
  if (!phone || password.length < 8) throw new Error('Set ADMIN_PHONE and ADMIN_PASSWORD (at least 8 characters) in the environment.');
  const pool = getPool();
  try {
    const restaurant = await pool.query('SELECT id FROM restaurants ORDER BY id LIMIT 1');
    if (!restaurant.rowCount) throw new Error('Run database migrations first to create the restaurant.');
    const hash = await hashPassword(password);
    await pool.query(
      `INSERT INTO staff(restaurant_id,name,phone,password_hash,role)
       VALUES($1,$2,$3,$4,'MANAGER')
       ON CONFLICT(restaurant_id,phone) DO UPDATE SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,is_active=TRUE`,
      [restaurant.rows[0].id,name,phone,hash]
    );
    console.log(`Manager account is ready for ${phone}.`);
  } finally { await pool.end(); }
}

createAdmin().catch((error) => { console.error('Could not create manager:',error.message); process.exitCode=1; });
