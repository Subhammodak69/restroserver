const express = require('express');
const crypto = require('node:crypto');
const asyncHandler = require('../utils/asyncHandler');
const { getPool } = require('../config/database');
const { signToken, hashCode, verifyPassword } = require('../utils/security');
const { authenticate } = require('../middleware/auth');
const rateLimit = require('../middleware/rateLimit');
const { sendOtp } = require('../services/sms');
const { normalizePhone } = require('../utils/phone');

const router = express.Router();
const otpLimiter = rateLimit({ windowMs: 15 * 60_000, max: 5, key: (req) => String(req.body?.phone || req.ip) });

router.post('/customer/otp', otpLimiter, asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  if (!phone) return res.status(400).json({ success: false, message: 'Enter a valid mobile number.' });
  const recent = await getPool().query(`SELECT COUNT(*)::int AS count FROM otp_challenges WHERE phone=$1 AND created_at>NOW()-INTERVAL '15 minutes'`, [phone]);
  if (recent.rows[0].count >= 3) return res.status(429).json({ success: false, message: 'OTP limit reached. Try again in 15 minutes.' });
  const code = process.env.NODE_ENV === 'production'
    ? String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
    : (process.env.DEV_OTP || '123456');
  await getPool().query(
    `INSERT INTO otp_challenges(phone,code_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL '5 minutes')`,
    [phone, hashCode(`${phone}:${code}`)]
  );
  const delivery=await sendOtp(phone,code);
  res.json({ success: true, message: 'Verification code sent.', ...(delivery.development ? { devCode: code } : {}) });
}));

router.post('/customer/verify', otpLimiter, asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const code = String(req.body.code || '').trim();
  if (!phone || !/^\d{6}$/.test(code)) return res.status(400).json({ success: false, message: 'Enter your mobile number and six digit code.' });
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const challenge = await client.query(
      `SELECT id,code_hash,attempts FROM otp_challenges WHERE phone=$1 AND used_at IS NULL AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1 FOR UPDATE`, [phone]
    );
    if (!challenge.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ success: false, message: 'Code expired. Request a new one.' });
    }
    const entry = challenge.rows[0];
    const supplied=Buffer.from(hashCode(`${phone}:${code}`),'hex'),expected=Buffer.from(entry.code_hash,'hex');
    const valid = entry.attempts < 5 && supplied.length===expected.length && require('node:crypto').timingSafeEqual(supplied,expected);
    if (!valid) {
      await client.query(`UPDATE otp_challenges SET attempts=attempts+1 WHERE id=$1`, [entry.id]);
      await client.query('COMMIT');
      return res.status(400).json({ success: false, message: 'That code is not correct.' });
    }
    await client.query(`UPDATE otp_challenges SET used_at=NOW() WHERE id=$1`, [entry.id]);
    const customer = await client.query(
      `INSERT INTO customers(phone,last_login_at) VALUES($1,NOW()) ON CONFLICT(phone) DO UPDATE SET last_login_at=NOW() RETURNING id,phone,name,points_balance AS points,is_blocked AS "isBlocked"`, [phone]
    );
    if(customer.rows[0].isBlocked){await client.query('ROLLBACK');return res.status(403).json({success:false,message:'This customer account is unavailable.'});}
    await client.query('COMMIT');
    const person = customer.rows[0];
    const token = signToken({ sub: person.id, role: 'CUSTOMER', phone: person.phone });
    res.json({ success: true, data: { token, customer: person } });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}));

router.post('/staff/login', otpLimiter, asyncHandler(async (req, res) => {
  const phone = normalizePhone(req.body.phone);
  const password = String(req.body.password || '');
  if (!phone || password.length < 4 || password.length > 128) return res.status(400).json({ success: false, message: 'Enter your staff mobile and password/PIN.' });
  const result = await getPool().query(
    `SELECT s.id,s.name,s.phone,s.password_hash,s.role,s.restaurant_id,s.station_id,r.name AS restaurant_name
     FROM staff s JOIN restaurants r ON r.id=s.restaurant_id WHERE s.phone=$1 AND s.is_active=TRUE ORDER BY CASE WHEN s.role='SUPERADMIN' THEN 0 ELSE 1 END,s.id LIMIT 1`, [phone]
  );
  if (!result.rowCount || !(await verifyPassword(password, result.rows[0].password_hash))) {
    return res.status(401).json({ success: false, message: 'Mobile number or password is incorrect.' });
  }
  const staff = result.rows[0];
  const token = signToken({ sub: staff.id, role: staff.role, restaurantId: staff.restaurant_id, stationId: staff.station_id || null });
  res.json({ success: true, data: { token, staff: { id: staff.id, name: staff.name, phone: staff.phone, role: staff.role, restaurantId: staff.restaurant_id, restaurantName: staff.restaurant_name } } });
}));

router.get('/me', authenticate, asyncHandler(async (req, res) => {
  const isCustomer = req.identity.role === 'CUSTOMER';
  const table = isCustomer ? 'customers' : 'staff';
  const select = isCustomer ? 'id,phone,name,points_balance AS points' : 'id,phone,name,role,restaurant_id AS "restaurantId"';
  const { rows } = await getPool().query(`SELECT ${select} FROM ${table} WHERE id=$1`, [req.identity.sub]);
  if (!rows.length) return res.status(401).json({ success: false, message: 'Account is unavailable.' });
  res.json({ success: true, data: rows[0] });
}));

module.exports = router;
