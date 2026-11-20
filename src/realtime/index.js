let io;

function attach(server) {
  const { Server } = require('socket.io');
  const { verifyToken } = require('../utils/security');
  const { getPool } = require('../config/database');
  const origins = (process.env.CLIENT_URL || 'http://localhost:3000,http://localhost:3001')
    .split(',').map((origin) => origin.trim()).filter(Boolean);
  io = new Server(server, { cors: { origin: origins }, transports: ['websocket', 'polling'] });
  io.use((socket, next) => {
    const identity = verifyToken(socket.handshake.auth?.token);
    if (!identity) return next(new Error('Authentication required'));
    socket.identity = identity;
    next();
  });
  io.on('connection', (socket) => {
    const identity = socket.identity;
    if (identity.role === 'CUSTOMER') socket.join(`customer:${identity.sub}`);
    if (['MANAGER', 'WAITER', 'KITCHEN', 'DELIVERY'].includes(identity.role)) {
      socket.join(`restaurant:${identity.restaurantId}:staff`);
      if (identity.role === 'KITCHEN' && identity.stationId) socket.join(`restaurant:${identity.restaurantId}:station:${identity.stationId}`);
      if (identity.role === 'DELIVERY') socket.join(`restaurant:${identity.restaurantId}:delivery`);
    }
    socket.on('session:join', async (payload) => {
      const sessionId = payload?.sessionId;
      const tableToken = payload?.tableToken;
      if (identity.role !== 'CUSTOMER' || !/^\d+$/.test(String(sessionId)) || !tableToken) return;
      try {
        const { rows } = await getPool().query(
          `SELECT 1 FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id
           WHERE ts.id=$1 AND t.qr_token=$2 AND ts.status IN ('OPEN','BILL_REQUESTED')`,
          [sessionId, tableToken]
        );
        if (rows.length) socket.join(`session:${sessionId}`);
      } catch { /* client reconnects and reconciles through REST */ }
    });
  });
  return io;
}

function publish(room, event, payload) {
  if (io) io.to(room).emit(event, payload);
}

module.exports = { attach, publish };
