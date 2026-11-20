const express=require('express');
const asyncHandler=require('../utils/asyncHandler');
const {getPool}=require('../config/database');
const {authenticate,requireRole}=require('../middleware/auth');
const realtime=require('../realtime');
const router=express.Router();
router.use(authenticate);
const rid=req=>req.identity.restaurantId;

router.get('/floor',requireRole('MANAGER','WAITER'),asyncHandler(async(req,res)=>{
 const {rows}=await getPool().query(`SELECT t.id,t.number,t.seats,t.status,t.pos_x AS x,t.pos_y AS y,ts.id AS "sessionId",ts.started_at AS "startedAt",COUNT(DISTINCT o.id)::int AS "orderCount",COALESCE(SUM(o.total),0) AS "runningTotal",COUNT(DISTINCT sr.id) FILTER(WHERE sr.status='OPEN')::int AS "openRequests"
 FROM restaurant_tables t LEFT JOIN table_sessions ts ON ts.table_id=t.id AND ts.status IN ('OPEN','BILL_REQUESTED') LEFT JOIN orders o ON o.session_id=ts.id AND o.status NOT IN ('CANCELLED') LEFT JOIN service_requests sr ON sr.session_id=ts.id WHERE t.restaurant_id=$1 AND t.is_active=TRUE GROUP BY t.id,ts.id ORDER BY t.number`,[rid(req)]);
 res.json({success:true,data:rows});
}));

router.get('/orders',requireRole('MANAGER','WAITER','KITCHEN'),asyncHandler(async(req,res)=>{
 const station=req.identity.role==='KITCHEN'?req.identity.stationId:null;
 const {rows}=await getPool().query(`SELECT o.id,o.order_number AS "orderNumber",o.order_type AS "orderType",o.status,o.session_id AS "sessionId",o.placed_at AS "placedAt",t.number AS "tableNumber",c.name AS customer,c.phone,
 COALESCE(jsonb_agg(jsonb_build_object('id',oi.id,'name',oi.item_name,'quantity',oi.quantity,'status',oi.status,'note',oi.note,'options',oi.options,'stationId',oi.station_id)) FILTER(WHERE oi.id IS NOT NULL),'[]'::jsonb) AS items
 FROM orders o JOIN customers c ON c.id=o.customer_id LEFT JOIN table_sessions ts ON ts.id=o.session_id LEFT JOIN restaurant_tables t ON t.id=ts.table_id LEFT JOIN order_items oi ON oi.order_id=o.id
 WHERE ($1::bigint IS NULL OR EXISTS(SELECT 1 FROM order_items f WHERE f.order_id=o.id AND f.station_id=$1 AND f.status IN ('NEW','PREPARING')))
 GROUP BY o.id,c.id,t.number ORDER BY o.placed_at ASC LIMIT 250`,[station]);
 res.json({success:true,data:rows});
}));

router.get('/stations/:stationId/queue',requireRole('MANAGER','KITCHEN'),asyncHandler(async(req,res)=>{
 if(req.identity.role==='KITCHEN'&&Number(req.params.stationId)!==Number(req.identity.stationId))return res.status(403).json({success:false,message:'This account is assigned to another kitchen station.'});
 const {rows}=await getPool().query(`SELECT oi.id,oi.item_name AS name,oi.quantity,oi.status,oi.note,oi.options,o.id AS "orderId",o.order_number AS "orderNumber",o.placed_at AS "placedAt",t.number AS "tableNumber" FROM order_items oi JOIN orders o ON o.id=oi.order_id LEFT JOIN table_sessions ts ON ts.id=o.session_id LEFT JOIN restaurant_tables t ON t.id=ts.table_id WHERE oi.station_id=$1 AND oi.status IN ('NEW','PREPARING','READY') ORDER BY o.placed_at`,[req.params.stationId]);
 res.json({success:true,data:rows});
}));

router.patch('/order-items/:id/status',requireRole('MANAGER','KITCHEN','WAITER'),asyncHandler(async(req,res)=>{
 const next=String(req.body.status||'').toUpperCase();
 if(!['PREPARING','READY','SERVED','CANCELLED'].includes(next))return res.status(400).json({success:false,message:'Invalid item status.'});
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  const item=await client.query(`SELECT oi.id,oi.order_id,oi.station_id,oi.status,o.session_id FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.id=$1 FOR UPDATE`,[req.params.id]);
  if(!item.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Order item not found.'});}
  if(req.identity.role==='KITCHEN'&&Number(item.rows[0].station_id)!==Number(req.identity.stationId)){await client.query('ROLLBACK');return res.status(403).json({success:false,message:'This item belongs to another station.'});}
  const allowed={NEW:['PREPARING','CANCELLED'],PREPARING:['READY','CANCELLED'],READY:['SERVED'],SERVED:[],CANCELLED:[]};
  if(!allowed[item.rows[0].status]?.includes(next)){await client.query('ROLLBACK');return res.status(409).json({success:false,message:`Cannot move item from ${item.rows[0].status} to ${next}.`});}
  const {rows}=await client.query(`UPDATE order_items SET status=$2 WHERE id=$1 RETURNING id,status,order_id AS "orderId"`,[req.params.id,next]);
  const ready=await client.query(`SELECT COUNT(*) FILTER(WHERE status NOT IN ('READY','SERVED','CANCELLED'))::int AS remaining,COUNT(*) FILTER(WHERE status='CANCELLED')::int AS cancelled FROM order_items WHERE order_id=$1`,[item.rows[0].order_id]);
  if(ready.rows[0].remaining===0&&ready.rows[0].cancelled===0)await client.query(`UPDATE orders SET status='READY',updated_at=NOW() WHERE id=$1 AND status IN ('NEW','ACCEPTED','PREPARING')`,[item.rows[0].order_id]);
  else if(next==='PREPARING')await client.query(`UPDATE orders SET status='PREPARING',updated_at=NOW() WHERE id=$1 AND status IN ('NEW','ACCEPTED')`,[item.rows[0].order_id]);
  await client.query('COMMIT');
  const event={...rows[0],sessionId:item.rows[0].session_id};
  realtime.publish(`restaurant:${rid(req)}:staff`,'orderItem.updated',event);
  if(item.rows[0].station_id)realtime.publish(`restaurant:${rid(req)}:station:${item.rows[0].station_id}`,'orderItem.updated',event);
  if(event.sessionId)realtime.publish(`session:${event.sessionId}`,'orderItem.updated',event);
  res.json({success:true,data:event});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));

router.patch('/requests/:id/done',requireRole('MANAGER','WAITER'),asyncHandler(async(req,res)=>{
 const {rows}=await getPool().query(`UPDATE service_requests sr SET status='DONE',resolved_at=NOW() FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id WHERE sr.id=$1 AND sr.session_id=ts.id AND t.restaurant_id=$2 RETURNING sr.id,sr.session_id AS "sessionId",sr.type,sr.status`,[req.params.id,rid(req)]);
 if(!rows.length)return res.status(404).json({success:false,message:'Open request not found.'});
 await getPool().query(`UPDATE restaurant_tables SET status=CASE WHEN status='NEEDS_HELP' THEN 'OCCUPIED' ELSE status END WHERE id=(SELECT table_id FROM table_sessions WHERE id=$1)`,[rows[0].sessionId]);
 realtime.publish(`restaurant:${rid(req)}:staff`,'serviceRequest.resolved',rows[0]);realtime.publish(`session:${rows[0].sessionId}`,'serviceRequest.resolved',rows[0]);res.json({success:true,data:rows[0]});
}));

router.patch('/delivery/:orderId/status',requireRole('MANAGER','DELIVERY'),asyncHandler(async(req,res)=>{
 const next=String(req.body.status||'').toUpperCase(),allowed=['ASSIGNED','PICKED_UP','ON_THE_WAY','DELIVERED','FAILED'];
 if(!allowed.includes(next))return res.status(400).json({success:false,message:'Invalid delivery status.'});
 const {rows}=await getPool().query(`UPDATE delivery_jobs dj SET status=$2,staff_id=CASE WHEN $2='ASSIGNED' THEN $3 ELSE dj.staff_id END,updated_at=NOW() FROM orders o WHERE dj.order_id=o.id AND o.id=$1 AND ($4::boolean OR dj.staff_id=$3) RETURNING dj.order_id AS "orderId",dj.status,o.customer_id AS "customerId",o.order_type AS "orderType"`,[req.params.orderId,next,req.identity.sub,req.identity.role==='MANAGER']);
 if(!rows.length)return res.status(404).json({success:false,message:'Delivery job not found or not assigned to this account.'});
 await getPool().query(`UPDATE orders SET status=CASE WHEN $2='DELIVERED' THEN 'DELIVERED' WHEN $2='PICKED_UP' THEN 'OUT_FOR_DELIVERY' ELSE status END,updated_at=NOW() WHERE id=$1`,[req.params.orderId,next]);
 realtime.publish(`customer:${rows[0].customerId}`,'delivery.statusChanged',{orderId:Number(req.params.orderId),status:next});realtime.publish(`restaurant:${rid(req)}:staff`,'delivery.statusChanged',rows[0]);res.json({success:true,data:rows[0]});
}));

module.exports=router;
