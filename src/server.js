require('dotenv').config();
const app = require('./app');
const realtime = require('./realtime');
const { getPool } = require('./config/database');

const port = Number(process.env.PORT) || 5000;
const server = app.listen(port, () => {
  console.log(`Restro API listening on port ${port}`);
});
realtime.attach(server);

function shutdown(signal) {
  console.log(`${signal} received; closing API server`);
  server.close(async () => {
    try { await getPool().end(); } catch { /* pool may not have connected */ }
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
