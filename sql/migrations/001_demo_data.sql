INSERT INTO restaurants(name,tagline,phone,email,address,hours)
SELECT 'Ember & Spice','Indian kitchen - Bengaluru','+91 80 0000 0000','hello@emberandspice.example',
       '{"line1":"12 Garden Lane","area":"Indiranagar","city":"Bengaluru","state":"Karnataka","postalCode":"560038","country":"India"}'::jsonb,
       '[{"days":"Every day","opens":"11:00","closes":"22:00"}]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM restaurants);
INSERT INTO stations(restaurant_id,name)
SELECT r.id,n.name FROM restaurants r CROSS JOIN (VALUES('Tandoor'),('Curry'),('Drinks')) AS n(name)
ON CONFLICT (restaurant_id,name) DO NOTHING;
INSERT INTO menu_categories(restaurant_id,name,sort_order)
SELECT r.id,c.name,c.position FROM restaurants r CROSS JOIN (VALUES('Starters',1),('Mains',2),('Breads',3),('Drinks',4)) AS c(name,position)
ON CONFLICT (restaurant_id,name) DO NOTHING;
INSERT INTO restaurant_tables(restaurant_id,number,seats,qr_token)
SELECT r.id,t.number,4,replace(gen_random_uuid()::text,'-','') FROM restaurants r
CROSS JOIN (VALUES('01'),('02'),('03'),('04'),('05'),('06'),('07'),('08')) AS t(number)
ON CONFLICT (restaurant_id,number) DO NOTHING;
INSERT INTO menu_items(restaurant_id,category_id,station_id,name,description,image_url,price,is_vegetarian,is_spicy,prep_minutes,sort_order)
SELECT r.id,c.id,s.id,v.name,v.description,v.image_url,v.price,v.veg,v.spicy,v.prep,v.position
FROM restaurants r
CROSS JOIN (VALUES
 ('Starters','Tandoor','Smoky Paneer Tikka','Tandoor-charred paneer, mint chutney, pickled onion','https://images.unsplash.com/photo-1567188040759-fb8a883dc6d8?auto=format&fit=crop&w=900&q=85',325,true,true,15,1),
 ('Mains','Curry','Old Delhi Butter Chicken','Slow cooked tomato gravy, cultured butter, cream','https://images.unsplash.com/photo-1603894584373-5ac82b2ae398?auto=format&fit=crop&w=900&q=85',425,false,false,22,1),
 ('Breads','Tandoor','Charred Garlic Naan','Clay oven naan brushed with garlic butter','https://images.unsplash.com/photo-1601050690597-df0568f70950?auto=format&fit=crop&w=900&q=85',95,true,false,8,1),
 ('Mains','Curry','Hyderabadi Dum Biryani','Fragrant basmati, saffron, fried onion, raita','https://images.unsplash.com/photo-1563379091339-03246963d96c?auto=format&fit=crop&w=900&q=85',385,false,true,25,2),
 ('Starters','Curry','Crispy Chilli Babycorn','Crunchy babycorn, wok-tossed with chilli and scallion','https://images.unsplash.com/photo-1625944525533-473f1a3d54e7?auto=format&fit=crop&w=900&q=85',285,true,true,12,2),
 ('Drinks','Drinks','Mango Mint Cooler','Fresh mango, garden mint, lime, sparkling water','https://images.unsplash.com/photo-1513558161293-cdaf765edfd7?auto=format&fit=crop&w=900&q=85',145,true,false,4,1)
) AS v(category,station,name,description,image_url,price,veg,spicy,prep,position)
JOIN menu_categories c ON c.restaurant_id=r.id AND c.name=v.category
JOIN stations s ON s.restaurant_id=r.id AND s.name=v.station
WHERE NOT EXISTS(SELECT 1 FROM menu_items m WHERE m.restaurant_id=r.id AND m.name=v.name);
INSERT INTO delivery_zones(restaurant_id,postal_code,delivery_fee,minimum_order,estimated_minutes)
SELECT id,'560038',0,0,45 FROM restaurants ORDER BY id LIMIT 1
ON CONFLICT(restaurant_id,postal_code) DO NOTHING;
INSERT INTO item_options(item_id,type,label,price_delta)
SELECT mi.id,o.type,o.label,o.delta FROM menu_items mi
CROSS JOIN LATERAL (VALUES('SIZE','Regular',0::numeric),('SIZE','Full',120::numeric)) AS o(type,label,delta)
ON CONFLICT(item_id,type,label) DO NOTHING;
INSERT INTO item_options(item_id,type,label,price_delta)
SELECT mi.id,'SPICE',s.label,0 FROM menu_items mi
CROSS JOIN (VALUES('Mild'),('Medium'),('Hot')) AS s(label)
WHERE mi.is_spicy=TRUE
ON CONFLICT(item_id,type,label) DO NOTHING;
