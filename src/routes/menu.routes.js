const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const menuController = require('../controllers/menu.controller');

const router = express.Router();

router.get('/restaurant', asyncHandler(menuController.getRestaurant));
router.get('/categories', asyncHandler(menuController.getCategories));
router.get('/items', asyncHandler(menuController.getMenuItems));

module.exports = router;
