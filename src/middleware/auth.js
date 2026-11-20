const { verifyToken } = require('../utils/security');

function optionalAuthenticate(request, _response, next) {
  const token = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : '';
  request.identity = verifyToken(token) || null;
  next();
}

function authenticate(request, response, next) {
  const token = request.headers.authorization?.startsWith('Bearer ')
    ? request.headers.authorization.slice(7)
    : '';
  const identity = verifyToken(token);
  if (!identity?.sub || !identity?.role) return response.status(401).json({ success: false, message: 'Please sign in to continue.' });
  request.identity = identity;
  next();
}

function requireRole(...roles) {
  return (request, response, next) => {
    if (!request.identity || !roles.includes(request.identity.role)) {
      return response.status(403).json({ success: false, message: 'You do not have access to this action.' });
    }
    next();
  };
}

module.exports = { authenticate, optionalAuthenticate, requireRole };
