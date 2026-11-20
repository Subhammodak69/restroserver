require('dotenv').config();
const { getPool } = require('../src/config/database');
const { hashPassword } = require('../src/utils/security');
const { normalizePhone } = require('../src/utils/phone');

async function createSuperadmin() {
  const phone = normalizePhone(process.env.SUPERADMIN_PHONE);
  const password = String(process.env.SUPERADMIN_PASSWORD || '');
  const name = String(process.env.SUPERADMIN_NAME || 'Super Admin').trim();
  if (!phone || password.length < 8) {
    throw new Error('Set SUPERADMIN_PHONE and SUPERADMIN_PASSWORD (at least 8 characters) for this command.');
  }

  const pool = getPool();
  try {
    const restaurant = await pool.query('SELECT id FROM restaurants ORDER BY id LIMIT 1');
    if (!restaurant.rowCount) throw new Error('Run database migrations first to create the restaurant.');
    const passwordHash = await hashPassword(password);
    await pool.query(
      `INSERT INTO staff(restaurant_id,name,phone,password_hash,role,is_active)
       VALUES($1,$2,$3,$4,'SUPERADMIN',TRUE)
       ON CONFLICT(restaurant_id,phone) DO UPDATE
       SET name=EXCLUDED.name,password_hash=EXCLUDED.password_hash,role='SUPERADMIN',is_active=TRUE`,
      [restaurant.rows[0].id, name, phone, passwordHash]
    );
    console.log(`Superadmin account is ready for ${phone}.`);
  } finally {
    await pool.end();
  }
}

createSuperadmin().catch((error) => {
  console.error('Could not create superadmin:', error.message);
  process.exitCode = 1;
});
