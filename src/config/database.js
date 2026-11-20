const { Pool } = require('pg');

let pool;

function isDatabaseConfigured() {
  return Boolean(process.env.DATABASE_URL);
}

function getPool() {
  if (!isDatabaseConfigured()) {
    const error = new Error('PostgreSQL is not configured. Add DATABASE_URL to server/.env.');
    error.code = 'DB_NOT_CONFIGURED';
    throw error;
  }

  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000
    });
  }

  return pool;
}

module.exports = { getPool, isDatabaseConfigured };
