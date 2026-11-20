const { getPool } = require('../config/database');

async function restaurant() {
  const { rows } = await getPool().query(
    `SELECT id,name,tagline,phone,email,address,hours,currency,tax_percent AS "taxPercent",
            delivery_enabled AS "deliveryEnabled",is_open AS "isOpen"
     FROM restaurants ORDER BY id LIMIT 1`
  );
  return rows[0] || null;
}

async function findActiveCategories() {
  const { rows } = await getPool().query(
    `SELECT id,name,sort_order AS "sortOrder" FROM menu_categories WHERE is_active=TRUE ORDER BY sort_order,name`
  );
  return rows;
}

async function findAvailableItems({ category, search, limit = 60 }) {
  const values=[];
  const filters=['mi.is_available=TRUE','c.is_active=TRUE'];
  if(category){values.push(category);filters.push(`c.name=$${values.length}`);}
  if(search){values.push(`%${search}%`);const p=values.length;filters.push(`(mi.name ILIKE $${p} OR mi.description ILIKE $${p})`);}
  values.push(limit);
  const {rows}=await getPool().query(
    `SELECT mi.id,mi.name,mi.description,mi.image_url AS "imageUrl",mi.price,
            mi.is_vegetarian AS "isVegetarian",mi.is_spicy AS "isSpicy",mi.prep_minutes AS "prepMinutes",
            c.name AS "categoryName",c.id AS "categoryId",s.name AS station,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'type',o.type,'label',o.label,'priceDelta',o.price_delta) ORDER BY o.type,o.id)
              FROM item_options o WHERE o.item_id=mi.id AND o.is_active=TRUE),'[]'::jsonb) AS options
     FROM menu_items mi JOIN menu_categories c ON c.id=mi.category_id LEFT JOIN stations s ON s.id=mi.station_id
     WHERE ${filters.join(' AND ')} ORDER BY mi.sort_order,mi.name LIMIT $${values.length}`,
    values
  );
  return rows;
}

module.exports={restaurant,findActiveCategories,findAvailableItems};
