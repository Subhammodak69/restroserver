require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { getPool } = require('../src/config/database');

async function migrate() {
  const pool = getPool();
  const client = await pool.connect();
  const directory = path.join(__dirname, '..', 'sql', 'migrations');
  try {
    await client.query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const files = fs.readdirSync(directory).filter((file) => file.endsWith('.sql')).sort();
    for (const name of files) {
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name]);
      if (already.rowCount) continue;
      const sql = fs.readFileSync(path.join(directory, name), 'utf8');
      console.log(`Applying ${name}`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    console.log('Database migrations are current.');
  } finally {
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error('Migration failed:', error.message);
  process.exitCode = 1;
});
