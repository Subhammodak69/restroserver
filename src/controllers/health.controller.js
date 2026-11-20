const { getPool, isDatabaseConfigured } = require('../config/database');

async function getHealth(_request, response) {
  let database = 'not_configured';

  if (isDatabaseConfigured()) {
    await getPool().query('SELECT 1');
    database = 'connected';
  }

  response.json({ success: true, service: 'restro-api', database });
}

module.exports = { getHealth };
