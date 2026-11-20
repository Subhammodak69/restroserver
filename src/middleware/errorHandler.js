module.exports = function errorHandler(error, _request, response, _next) {
  if (error.code === 'DB_NOT_CONFIGURED') {
    return response.status(503).json({ success: false, message: error.message });
  }

  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) console.error(error);

  return response.status(status).json({
    success: false,
    message: status >= 500 ? 'Something went wrong. Please try again.' : error.message
  });
};
