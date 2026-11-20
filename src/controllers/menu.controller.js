const menuModel = require('../models/menu.model');

async function getCategories(_request, response) {
  const categories = await menuModel.findActiveCategories();
  response.json({ success: true, data: categories });
}

async function getRestaurant(_request, response) {
  const restaurant = await menuModel.restaurant();
  if (!restaurant) return response.status(404).json({ success: false, message: 'Restaurant details are not configured.' });
  response.json({ success: true, data: restaurant });
}

async function getMenuItems(request, response) {
  const search = typeof request.query.search === 'string' ? request.query.search.trim().slice(0, 80) : '';
  const category = typeof request.query.category === 'string' ? request.query.category.trim().slice(0, 80) : '';
  const requestedLimit = Number.parseInt(request.query.limit, 10);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 60) : 24;

  const items = await menuModel.findAvailableItems({ category, search, limit });
  response.json({ success: true, data: items, meta: { count: items.length, limit } });
}

module.exports = { getRestaurant, getCategories, getMenuItems };
