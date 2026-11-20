module.exports = function notFound(request, response) {
  response.status(404).json({
    success: false,
    message: `No route for ${request.method} ${request.originalUrl}`
  });
};
