const express=require('express');
const crypto=require('node:crypto');
const QRCode=require('qrcode');
const asyncHandler=require('../utils/asyncHandler');
const {getPool}=require('../config/database');
const {authenticate,requireRole}=require('../middleware/auth');
const {hashPassword}=require('../utils/security');
const {normalizePhone}=require('../utils/phone');
const realtime=require('../realtime');
const router=express.Router();
router.use(authenticate,requireRole('MANAGER','SUPERADMIN'));

const restaurantId=req=>req.identity.restaurantId;
async function audit(req,action,type,id,details={}){
 await getPool().query(`INSERT INTO audit_log(staff_id,action,entity_type,entity_id,details) VALUES($1,$2,$3,$4,$5::jsonb)`,[req.identity.sub,action,type,id||null,JSON.stringify(details)]);
}
function validId(id){return /^\d+$/.test(String(id))&&Number(id)>0;}

router.get('/dashboard',asyncHandler(async(req,res)=>{
 const from=String(req.query.from||new Date(Date.now()-6*864e5).toISOString().slice(0,10));
 const to=String(req.query.to||new Date().toISOString().slice(0,10));
 if(!/^\d{4}-\d{2}-\d{2}$/.test(from)||!/^\d{4}-\d{2}-\d{2}$/.test(to))return res.status(400).json({success:false,message:'Use YYYY-MM-DD for report dates.'});
 const rid=restaurantId(req);
 const [totals,series,recent,topItems,counts]=await Promise.all([
  getPool().query(`SELECT COUNT(*) FILTER(WHERE status<>'CANCELLED')::int AS orders,COALESCE(SUM(total) FILTER(WHERE payment_status='PAID'),0) AS revenue,COALESCE(AVG(total) FILTER(WHERE payment_status='PAID'),0) AS average_order FROM orders WHERE placed_at >= $1::date AND placed_at < ($2::date+INTERVAL '1 day')`,[from,to]),
  getPool().query(`SELECT DATE(placed_at) AS day,COUNT(*)::int AS orders,COALESCE(SUM(total) FILTER(WHERE payment_status='PAID'),0) AS revenue FROM orders WHERE placed_at >= $1::date AND placed_at < ($2::date+INTERVAL '1 day') GROUP BY DATE(placed_at) ORDER BY day`,[from,to]),
  getPool().query(`SELECT o.id,o.order_number AS "orderNumber",o.order_type AS "orderType",o.status,o.total,o.placed_at AS "placedAt",c.name AS customer,c.phone FROM orders o JOIN customers c ON c.id=o.customer_id ORDER BY o.placed_at DESC LIMIT 10`),
  getPool().query(`SELECT oi.item_name AS name,SUM(oi.quantity)::int AS quantity,SUM(oi.line_total) AS revenue FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status<>'CANCELLED' AND o.placed_at >= $1::date AND o.placed_at < ($2::date+INTERVAL '1 day') GROUP BY oi.item_name ORDER BY quantity DESC LIMIT 5`,[from,to]),
  getPool().query(`SELECT status,COUNT(*)::int AS count FROM restaurant_tables WHERE restaurant_id=$1 GROUP BY status`,[rid])
 ]);
 res.json({success:true,data:{period:{from,to},summary:totals.rows[0],series:series.rows,recentOrders:recent.rows,topItems:topItems.rows,tables:counts.rows}});
}));

router.get('/orders',asyncHandler(async(req,res)=>{
 const status=String(req.query.status||'').toUpperCase(),type=String(req.query.type||'').toUpperCase();
 const values=[],where=[];
 if(status){values.push(status);where.push(`o.status=$${values.length}`);}
 if(type){values.push(type);where.push(`o.order_type=$${values.length}`);}
 const {rows}=await getPool().query(`SELECT o.id,o.order_number AS "orderNumber",o.order_type AS "orderType",o.status,o.payment_status AS "paymentStatus",o.subtotal,o.tax,o.delivery_fee AS "deliveryFee",o.total,o.placed_at AS "placedAt",c.name AS customer,c.phone,
  COALESCE(jsonb_agg(jsonb_build_object('id',oi.id,'name',oi.item_name,'quantity',oi.quantity,'status',oi.status,'stationId',oi.station_id,'note',oi.note,'options',oi.options)) FILTER(WHERE oi.id IS NOT NULL),'[]'::jsonb) AS items
  FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN order_items oi ON oi.order_id=o.id ${where.length?`WHERE ${where.join(' AND ')}`:''} GROUP BY o.id,c.id ORDER BY o.placed_at DESC LIMIT 250`,values);
 res.json({success:true,data:rows});
}));

const transitions={NEW:['ACCEPTED','CANCELLED'],ACCEPTED:['PREPARING','CANCELLED'],PREPARING:['READY'],READY:['SERVED','OUT_FOR_DELIVERY'],OUT_FOR_DELIVERY:['DELIVERED'],SERVED:[],DELIVERED:[],CANCELLED:[]};
router.patch('/orders/:id/status',asyncHandler(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({success:false,message:'Invalid order id.'});
 const next=String(req.body.status||'').toUpperCase();
 const current=await getPool().query(`SELECT id,status,order_type,session_id FROM orders WHERE id=$1`,[req.params.id]);
 if(!current.rowCount)return res.status(404).json({success:false,message:'Order not found.'});
 if(!transitions[current.rows[0].status]?.includes(next))return res.status(409).json({success:false,message:`Cannot move order from ${current.rows[0].status} to ${next}.`});
 const {rows}=await getPool().query(`UPDATE orders SET status=$2,updated_at=NOW() WHERE id=$1 RETURNING id,order_number AS "orderNumber",status,order_type AS "orderType",session_id AS "sessionId"`,[req.params.id,next]);
 if(next==='SERVED')await getPool().query(`UPDATE order_items SET status='SERVED' WHERE order_id=$1 AND status='READY'`,[req.params.id]);
 await audit(req,'ORDER_STATUS_CHANGED','order',req.params.id,{status:next});
 realtime.publish(`restaurant:${restaurantId(req)}:staff`,'order.updated',rows[0]);
 if(rows[0].sessionId)realtime.publish(`session:${rows[0].sessionId}`,'order.updated',rows[0]);
 const order=await getPool().query(`SELECT customer_id FROM orders WHERE id=$1`,[req.params.id]);
 realtime.publish(`customer:${order.rows[0].customer_id}`,'order.updated',rows[0]);
 res.json({success:true,data:rows[0]});
}));

router.get('/customers',asyncHandler(async(req,res)=>{
 const search=`%${String(req.query.search||'').slice(0,80)}%`;
 const {rows}=await getPool().query(`SELECT c.id,c.name,c.phone,c.points_balance AS points,c.is_blocked AS "isBlocked",c.created_at AS "createdAt",COUNT(o.id)::int AS "orderCount",COALESCE(SUM(o.total) FILTER(WHERE o.payment_status='PAID'),0) AS "totalSpent",MAX(o.placed_at) AS "lastOrder"
 FROM customers c LEFT JOIN orders o ON o.customer_id=c.id WHERE c.phone ILIKE $1 OR c.name ILIKE $1 GROUP BY c.id ORDER BY "lastOrder" DESC NULLS LAST LIMIT 250`,[search]);
 res.json({success:true,data:rows});
}));
router.patch('/customers/:id/block',asyncHandler(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({success:false,message:'Invalid customer id.'});
 const blocked=Boolean(req.body.blocked);const {rows}=await getPool().query(`UPDATE customers SET is_blocked=$2 WHERE id=$1 RETURNING id,is_blocked AS blocked`,[req.params.id,blocked]);
 if(!rows.length)return res.status(404).json({success:false,message:'Customer not found.'});
 await audit(req,blocked?'CUSTOMER_BLOCKED':'CUSTOMER_UNBLOCKED','customer',req.params.id);res.json({success:true,data:rows[0]});
}));

router.get('/menu',asyncHandler(async(req,res)=>{
 const {rows}=await getPool().query(`SELECT mi.id,mi.name,mi.description,mi.image_url AS "imageUrl",mi.price,mi.is_available AS "isAvailable",mi.is_vegetarian AS "isVegetarian",mi.is_spicy AS "isSpicy",mi.prep_minutes AS "prepMinutes",mi.sort_order AS "sortOrder",c.id AS "categoryId",c.name AS "categoryName",s.id AS "stationId",s.name AS station,COALESCE((SELECT jsonb_agg(jsonb_build_object('id',o.id,'type',o.type,'label',o.label,'priceDelta',o.price_delta,'isActive',o.is_active) ORDER BY o.type,o.id) FROM item_options o WHERE o.item_id=mi.id),'[]'::jsonb) AS options FROM menu_items mi JOIN menu_categories c ON c.id=mi.category_id LEFT JOIN stations s ON s.id=mi.station_id WHERE mi.restaurant_id=$1 ORDER BY c.sort_order,mi.sort_order,mi.name`,[restaurantId(req)]);
 res.json({success:true,data:rows});
}));
router.post('/menu',asyncHandler(async(req,res)=>{
 const {name,categoryId,price}=req.body;
 if(!String(name||'').trim()||!validId(categoryId)||!Number.isFinite(Number(price))||Number(price)<0)return res.status(400).json({success:false,message:'Name, category, and a non-negative price are required.'});
 const {rows}=await getPool().query(`INSERT INTO menu_items(restaurant_id,category_id,station_id,name,description,image_url,price,is_vegetarian,is_spicy,is_available,prep_minutes,sort_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id,name`,[restaurantId(req),categoryId,req.body.stationId||null,String(name).trim(),String(req.body.description||'').slice(0,500),String(req.body.imageUrl||'').slice(0,500),price,req.body.isVegetarian!==false,Boolean(req.body.isSpicy),req.body.isAvailable!==false,Math.max(1,Number(req.body.prepMinutes)||15),Math.max(0,Number(req.body.sortOrder)||0)]);
 await audit(req,'MENU_ITEM_CREATED','menu_item',rows[0].id);realtime.publish(`restaurant:${restaurantId(req)}:staff`,'menu.updated',{id:rows[0].id});res.status(201).json({success:true,data:rows[0]});
}));
router.patch('/menu/:id',asyncHandler(async(req,res)=>{
 if(!validId(req.params.id))return res.status(400).json({success:false,message:'Invalid menu item id.'});
 const {rows}=await getPool().query(`UPDATE menu_items SET name=COALESCE($3,name),description=COALESCE($4,description),image_url=COALESCE($5,image_url),price=COALESCE($6,price),is_available=COALESCE($7,is_available),is_vegetarian=COALESCE($8,is_vegetarian),is_spicy=COALESCE($9,is_spicy),prep_minutes=COALESCE($10,prep_minutes),category_id=COALESCE($11,category_id),station_id=$12,sort_order=COALESCE($13,sort_order) WHERE id=$1 AND restaurant_id=$2 RETURNING id,name,price,is_available AS "isAvailable"`,[req.params.id,restaurantId(req),req.body.name??null,req.body.description??null,req.body.imageUrl??null,req.body.price??null,req.body.isAvailable??null,req.body.isVegetarian??null,req.body.isSpicy??null,req.body.prepMinutes??null,req.body.categoryId??null,req.body.stationId??null,req.body.sortOrder??null]);
 if(!rows.length)return res.status(404).json({success:false,message:'Menu item not found.'});await audit(req,'MENU_ITEM_UPDATED','menu_item',req.params.id,req.body);realtime.publish(`restaurant:${restaurantId(req)}:staff`,'menu.updated',{id:Number(req.params.id)});res.json({success:true,data:rows[0]});
}));
router.put('/menu/:id/options',asyncHandler(async(req,res)=>{
 if(!validId(req.params.id)||!Array.isArray(req.body.options)||req.body.options.length>30)return res.status(400).json({success:false,message:'Provide a valid item id and up to 30 options.'});
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  const item=await client.query(`SELECT id FROM menu_items WHERE id=$1 AND restaurant_id=$2 FOR UPDATE`,[req.params.id,restaurantId(req)]);
  if(!item.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Menu item not found.'});}
  await client.query(`DELETE FROM item_options WHERE item_id=$1`,[req.params.id]);
  const result=[];
  for(const option of req.body.options){
   const type=String(option.type||'').toUpperCase(),label=String(option.label||'').trim(),delta=Number(option.priceDelta||0),isActive=option.isActive!==false;
   if(!['SIZE','SPICE','ADDON'].includes(type)||!label||label.length>80||!Number.isFinite(delta)||Math.abs(delta)>100000)throw Object.assign(new Error('Each option needs a valid type, label, and price change.'),{status:400});
   const row=await client.query(`INSERT INTO item_options(item_id,type,label,price_delta,is_active) VALUES($1,$2,$3,$4,$5) RETURNING id,type,label,price_delta AS "priceDelta",is_active AS "isActive"`,[req.params.id,type,label,delta,isActive]);result.push(row.rows[0]);
  }
  await client.query('COMMIT');await audit(req,'MENU_OPTIONS_UPDATED','menu_item',req.params.id);realtime.publish(`restaurant:${restaurantId(req)}:staff`,'menu.updated',{id:Number(req.params.id)});res.json({success:true,data:result});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));

router.get('/categories',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT id,name,sort_order AS "sortOrder",is_active AS "isActive" FROM menu_categories WHERE restaurant_id=$1 ORDER BY sort_order,name`,[restaurantId(req)]);res.json({success:true,data:rows});}));
router.post('/categories',asyncHandler(async(req,res)=>{const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({success:false,message:'Category name is required.'});const {rows}=await getPool().query(`INSERT INTO menu_categories(restaurant_id,name,sort_order) VALUES($1,$2,$3) RETURNING id,name,sort_order AS "sortOrder"`,[restaurantId(req),name,Number(req.body.sortOrder)||0]);res.status(201).json({success:true,data:rows[0]});}));
router.patch('/categories/:id',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`UPDATE menu_categories SET name=COALESCE($3,name),sort_order=COALESCE($4,sort_order),is_active=COALESCE($5,is_active) WHERE id=$1 AND restaurant_id=$2 RETURNING id,name,sort_order AS "sortOrder",is_active AS "isActive"`,[req.params.id,restaurantId(req),req.body.name??null,req.body.sortOrder??null,req.body.isActive??null]);if(!rows.length)return res.status(404).json({success:false,message:'Category not found.'});res.json({success:true,data:rows[0]});}));

router.get('/stations',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT id,name,is_active AS "isActive" FROM stations WHERE restaurant_id=$1 ORDER BY name`,[restaurantId(req)]);res.json({success:true,data:rows});}));
router.post('/stations',asyncHandler(async(req,res)=>{const name=String(req.body.name||'').trim();if(!name)return res.status(400).json({success:false,message:'Station name is required.'});const {rows}=await getPool().query(`INSERT INTO stations(restaurant_id,name) VALUES($1,$2) RETURNING id,name`,[restaurantId(req),name]);res.status(201).json({success:true,data:rows[0]});}));

router.get('/tables',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT id,number,seats,status,qr_token AS "qrToken",pos_x AS x,pos_y AS y,is_active AS "isActive" FROM restaurant_tables WHERE restaurant_id=$1 ORDER BY number`,[restaurantId(req)]);res.json({success:true,data:rows.map(t=>({...t,qrUrl:`${process.env.PUBLIC_SITE_URL||'http://localhost:3000'}/t/${t.qrToken}`}))});}));
router.post('/tables',asyncHandler(async(req,res)=>{const number=String(req.body.number||'').trim();if(!number)return res.status(400).json({success:false,message:'Table number is required.'});const token=crypto.randomBytes(24).toString('hex');const {rows}=await getPool().query(`INSERT INTO restaurant_tables(restaurant_id,number,seats,qr_token,pos_x,pos_y) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,number,seats,status,qr_token AS "qrToken"`,[restaurantId(req),number,Math.max(1,Number(req.body.seats)||4),token,Number(req.body.x)||0,Number(req.body.y)||0]);await audit(req,'TABLE_CREATED','table',rows[0].id);res.status(201).json({success:true,data:{...rows[0],qrUrl:`${process.env.PUBLIC_SITE_URL||'http://localhost:3000'}/t/${token}`}});}));
router.patch('/tables/:id',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`UPDATE restaurant_tables SET number=COALESCE($3,number),seats=COALESCE($4,seats),pos_x=COALESCE($5,pos_x),pos_y=COALESCE($6,pos_y),is_active=COALESCE($7,is_active) WHERE id=$1 AND restaurant_id=$2 RETURNING id,number,seats,status,qr_token AS "qrToken",pos_x AS x,pos_y AS y,is_active AS "isActive"`,[req.params.id,restaurantId(req),req.body.number??null,req.body.seats??null,req.body.x??null,req.body.y??null,req.body.isActive??null]);if(!rows.length)return res.status(404).json({success:false,message:'Table not found.'});await audit(req,'TABLE_UPDATED','table',req.params.id,req.body);res.json({success:true,data:rows[0]});}));
router.post('/tables/:id/rotate-qr',asyncHandler(async(req,res)=>{const token=crypto.randomBytes(24).toString('hex');const {rows}=await getPool().query(`UPDATE restaurant_tables SET qr_token=$3 WHERE id=$1 AND restaurant_id=$2 RETURNING id,number,qr_token AS "qrToken"`,[req.params.id,restaurantId(req),token]);if(!rows.length)return res.status(404).json({success:false,message:'Table not found.'});await audit(req,'TABLE_QR_ROTATED','table',req.params.id);res.json({success:true,data:{...rows[0],qrUrl:`${process.env.PUBLIC_SITE_URL||'http://localhost:3000'}/t/${token}`}});}));
router.get('/tables/:id/qr.png',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT number,qr_token FROM restaurant_tables WHERE id=$1 AND restaurant_id=$2`,[req.params.id,restaurantId(req)]);if(!rows.length)return res.status(404).json({success:false,message:'Table not found.'});const url=`${process.env.PUBLIC_SITE_URL||'http://localhost:3000'}/t/${rows[0].qr_token}`;res.type('png');res.send(await QRCode.toBuffer(url,{width:500,margin:2}));}));
router.get('/tables/:id/qr',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT number,qr_token FROM restaurant_tables WHERE id=$1 AND restaurant_id=$2`,[req.params.id,restaurantId(req)]);if(!rows.length)return res.status(404).json({success:false,message:'Table not found.'});const url=`${process.env.PUBLIC_SITE_URL||'http://localhost:3000'}/t/${rows[0].qr_token}`;res.json({success:true,data:{tableNumber:rows[0].number,url,image:await QRCode.toDataURL(url,{width:500,margin:2})}});}));

router.get('/requests',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT sr.id,sr.type,sr.status,sr.created_at AS "createdAt",t.id AS "tableId",t.number AS "tableNumber" FROM service_requests sr JOIN table_sessions ts ON ts.id=sr.session_id JOIN restaurant_tables t ON t.id=ts.table_id WHERE t.restaurant_id=$1 AND sr.status='OPEN' ORDER BY sr.created_at`,[restaurantId(req)]);res.json({success:true,data:rows});}));
router.patch('/requests/:id/resolve',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`UPDATE service_requests sr SET status='DONE',resolved_at=NOW() FROM table_sessions ts,restaurant_tables t WHERE sr.id=$1 AND sr.session_id=ts.id AND ts.table_id=t.id AND t.restaurant_id=$2 RETURNING sr.id,sr.session_id AS "sessionId",sr.type,sr.status`,[req.params.id,restaurantId(req)]);if(!rows.length)return res.status(404).json({success:false,message:'Request not found.'});await getPool().query(`UPDATE restaurant_tables SET status=CASE WHEN status='NEEDS_HELP' THEN 'OCCUPIED' ELSE status END WHERE id=(SELECT table_id FROM table_sessions WHERE id=$1)`,[rows[0].sessionId]);await audit(req,'SERVICE_REQUEST_RESOLVED','service_request',req.params.id);realtime.publish(`session:${rows[0].sessionId}`,'serviceRequest.resolved',rows[0]);realtime.publish(`restaurant:${restaurantId(req)}:staff`,'serviceRequest.resolved',rows[0]);res.json({success:true,data:rows[0]});}));

router.get('/delivery',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT o.id,o.order_number AS "orderNumber",o.status,o.address,o.total,o.placed_at AS "placedAt",dj.status AS "deliveryStatus",dj.estimated_minutes AS "estimatedMinutes",s.id AS "staffId",s.name AS "staffName" FROM orders o JOIN delivery_jobs dj ON dj.order_id=o.id LEFT JOIN staff s ON s.id=dj.staff_id ORDER BY o.placed_at DESC LIMIT 200`);res.json({success:true,data:rows});}));
router.patch('/delivery/:orderId',asyncHandler(async(req,res)=>{const status=String(req.body.status||'').toUpperCase();const allowed=['UNASSIGNED','ASSIGNED','PICKED_UP','ON_THE_WAY','DELIVERED','FAILED'];if(!allowed.includes(status))return res.status(400).json({success:false,message:'Invalid delivery status.'});const staffId=req.body.staffId||null;const result=await getPool().query(`UPDATE delivery_jobs dj SET status=$2,staff_id=COALESCE($3,dj.staff_id),updated_at=NOW() FROM orders o WHERE dj.order_id=o.id AND o.id=$1 RETURNING dj.order_id AS "orderId",dj.status,dj.staff_id AS "staffId",o.customer_id AS "customerId"`,[req.params.orderId,status,staffId]);if(!result.rowCount)return res.status(404).json({success:false,message:'Delivery order not found.'});const d=result.rows[0];if(status==='DELIVERED')await getPool().query(`UPDATE orders SET status='DELIVERED',updated_at=NOW() WHERE id=$1`,[d.orderId]);await audit(req,'DELIVERY_STATUS_CHANGED','delivery',d.orderId,{status,staffId});realtime.publish(`customer:${d.customerId}`,'delivery.statusChanged',{orderId:d.orderId,status});res.json({success:true,data:d});}));

router.get('/staff',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT id,name,phone,role,station_id AS "stationId",is_active AS "isActive",created_at AS "createdAt" FROM staff WHERE restaurant_id=$1 ORDER BY name`,[restaurantId(req)]);res.json({success:true,data:rows});}));
router.post('/staff',asyncHandler(async(req,res)=>{const {name,password,role}=req.body;const phone=normalizePhone(req.body.phone);const allowed=['WAITER','KITCHEN','DELIVERY','MANAGER'];if(!String(name||'').trim()||!phone||String(password||'').length<8||!allowed.includes(role))return res.status(400).json({success:false,message:'Provide name, valid phone, password (8+ chars), and a valid role.'});const hash=await hashPassword(password);const {rows}=await getPool().query(`INSERT INTO staff(restaurant_id,name,phone,password_hash,role,station_id) VALUES($1,$2,$3,$4,$5,$6) RETURNING id,name,phone,role,station_id AS "stationId"`,[restaurantId(req),name,phone,hash,role,req.body.stationId||null]);await audit(req,'STAFF_CREATED','staff',rows[0].id,{role});res.status(201).json({success:true,data:rows[0]});}));
router.patch('/staff/:id',asyncHandler(async(req,res)=>{const isActive=req.body.isActive==null?null:Boolean(req.body.isActive),role=req.body.role||null;const allowed=['MANAGER','WAITER','KITCHEN','DELIVERY'];if(role&&!allowed.includes(role))return res.status(400).json({success:false,message:'Invalid staff role.'});let passwordHash=null;if(req.body.password){if(String(req.body.password).length<8)return res.status(400).json({success:false,message:'Password must be at least 8 characters.'});passwordHash=await hashPassword(req.body.password);}const {rows}=await getPool().query(`UPDATE staff SET name=COALESCE($3,name),role=COALESCE($4,role),is_active=COALESCE($5,is_active),station_id=COALESCE($6,station_id),password_hash=COALESCE($7,password_hash) WHERE id=$1 AND restaurant_id=$2 RETURNING id,name,phone,role,station_id AS "stationId",is_active AS "isActive"`,[req.params.id,restaurantId(req),req.body.name??null,role,isActive,req.body.stationId??null,passwordHash]);if(!rows.length)return res.status(404).json({success:false,message:'Staff account not found.'});await audit(req,'STAFF_UPDATED','staff',req.params.id,{role,isActive});res.json({success:true,data:rows[0]});}));

router.get('/zones',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT id,postal_code AS "postalCode",delivery_fee AS "deliveryFee",minimum_order AS "minimumOrder",estimated_minutes AS "estimatedMinutes",is_active AS "isActive" FROM delivery_zones WHERE restaurant_id=$1 ORDER BY postal_code`,[restaurantId(req)]);res.json({success:true,data:rows});}));
router.post('/zones',asyncHandler(async(req,res)=>{const postal=String(req.body.postalCode||'').trim();if(!/^\d{5,10}$/.test(postal))return res.status(400).json({success:false,message:'Enter a valid postal code.'});const {rows}=await getPool().query(`INSERT INTO delivery_zones(restaurant_id,postal_code,delivery_fee,minimum_order,estimated_minutes) VALUES($1,$2,$3,$4,$5) RETURNING id,postal_code AS "postalCode",delivery_fee AS "deliveryFee",minimum_order AS "minimumOrder",estimated_minutes AS "estimatedMinutes"`,[restaurantId(req),postal,Math.max(0,Number(req.body.deliveryFee)||0),Math.max(0,Number(req.body.minimumOrder)||0),Math.max(1,Number(req.body.estimatedMinutes)||45)]);await audit(req,'DELIVERY_ZONE_CREATED','delivery_zone',rows[0].id);res.status(201).json({success:true,data:rows[0]});}));
router.patch('/zones/:id',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`UPDATE delivery_zones SET delivery_fee=COALESCE($3,delivery_fee),minimum_order=COALESCE($4,minimum_order),estimated_minutes=COALESCE($5,estimated_minutes),is_active=COALESCE($6,is_active) WHERE id=$1 AND restaurant_id=$2 RETURNING id,postal_code AS "postalCode",delivery_fee AS "deliveryFee",minimum_order AS "minimumOrder",estimated_minutes AS "estimatedMinutes",is_active AS "isActive"`,[req.params.id,restaurantId(req),req.body.deliveryFee??null,req.body.minimumOrder??null,req.body.estimatedMinutes??null,req.body.isActive??null]);if(!rows.length)return res.status(404).json({success:false,message:'Delivery zone not found.'});res.json({success:true,data:rows[0]});}));

router.patch('/settings',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`UPDATE restaurants SET name=COALESCE($2,name),tagline=COALESCE($3,tagline),phone=COALESCE($4,phone),email=COALESCE($5,email),address=COALESCE($6::jsonb,address),hours=COALESCE($7::jsonb,hours),tax_percent=COALESCE($8,tax_percent),service_charge_percent=COALESCE($9,service_charge_percent),delivery_enabled=COALESCE($10,delivery_enabled),delivery_fee=COALESCE($11,delivery_fee),min_delivery_order=COALESCE($12,min_delivery_order),is_open=COALESCE($13,is_open) WHERE id=$1 RETURNING id,name,tagline,phone,email,address,hours,tax_percent AS "taxPercent",service_charge_percent AS "serviceChargePercent",delivery_enabled AS "deliveryEnabled",delivery_fee AS "deliveryFee",min_delivery_order AS "minDeliveryOrder",is_open AS "isOpen"`,[restaurantId(req),req.body.name??null,req.body.tagline??null,req.body.phone??null,req.body.email??null,req.body.address==null?null:JSON.stringify(req.body.address),req.body.hours==null?null:JSON.stringify(req.body.hours),req.body.taxPercent??null,req.body.serviceChargePercent??null,req.body.deliveryEnabled??null,req.body.deliveryFee??null,req.body.minDeliveryOrder??null,req.body.isOpen??null]);if(!rows.length)return res.status(404).json({success:false,message:'Restaurant not found.'});await audit(req,'SETTINGS_UPDATED','restaurant',restaurantId(req));res.json({success:true,data:rows[0]});}));
router.get('/settings',asyncHandler(async(req,res)=>{const {rows}=await getPool().query(`SELECT id,name,tagline,phone,email,address,hours,tax_percent AS "taxPercent",service_charge_percent AS "serviceChargePercent",delivery_enabled AS "deliveryEnabled",delivery_fee AS "deliveryFee",min_delivery_order AS "minDeliveryOrder",is_open AS "isOpen" FROM restaurants WHERE id=$1`,[restaurantId(req)]);res.json({success:true,data:rows[0]||null});}));

module.exports=router;
