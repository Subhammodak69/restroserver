const express=require('express');
const crypto=require('node:crypto');
const asyncHandler=require('../utils/asyncHandler');
const {getPool}=require('../config/database');
const {authenticate}=require('../middleware/auth');
const {placeOrder}=require('../services/orders');
const realtime=require('../realtime');
const router=express.Router();
router.use(authenticate);

router.post('/',asyncHandler(async(req,res)=>{
 if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer sign-in is required.'});
 const order=await placeOrder({customerId:req.identity.sub,orderType:'DELIVERY',address:req.body.address,items:req.body.items,idempotencyKey:req.get('Idempotency-Key')||null});
 res.status(order.idempotent?200:201).json({success:true,data:order});
}));

router.get('/',asyncHandler(async(req,res)=>{
 if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer account required.'});
 const {rows}=await getPool().query(`SELECT id,order_number AS "orderNumber",order_type AS "orderType",status,payment_status AS "paymentStatus",total,placed_at AS "placedAt" FROM orders WHERE customer_id=$1 ORDER BY placed_at DESC LIMIT 100`,[req.identity.sub]);
 res.json({success:true,data:rows});
}));

router.get('/:id',asyncHandler(async(req,res)=>{
 if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer account required.'});
 const {rows}=await getPool().query(
  `SELECT o.id,o.order_number AS "orderNumber",o.order_type AS "orderType",o.status,o.payment_status AS "paymentStatus",o.address,o.subtotal,o.tax,o.service_charge AS "serviceCharge",o.delivery_fee AS "deliveryFee",o.total,o.placed_at AS "placedAt",
          COALESCE(jsonb_agg(jsonb_build_object('name',oi.item_name,'quantity',oi.quantity,'unitPrice',oi.unit_price,'lineTotal',oi.line_total,'status',oi.status,'options',oi.options)) FILTER(WHERE oi.id IS NOT NULL),'[]'::jsonb) AS items,
          dj.status AS "deliveryStatus",dj.estimated_minutes AS "estimatedMinutes",s.name AS "deliveryStaffName"
   FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN delivery_jobs dj ON dj.order_id=o.id
   LEFT JOIN staff s ON s.id=dj.staff_id
   WHERE o.id=$1 AND o.customer_id=$2 GROUP BY o.id,dj.id,s.id`,[req.params.id,req.identity.sub]
 );
 if(!rows.length)return res.status(404).json({success:false,message:'Order not found.'});
 res.json({success:true,data:rows[0]});
}));

router.post('/:id/cancel',asyncHandler(async(req,res)=>{
 if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer account required.'});
 const {rows}=await getPool().query(`UPDATE orders SET status='CANCELLED',updated_at=NOW() WHERE id=$1 AND customer_id=$2 AND status='NEW' RETURNING id,order_number AS "orderNumber",status,session_id AS "sessionId"`,[req.params.id,req.identity.sub]);
 if(!rows.length)return res.status(409).json({success:false,message:'This order can no longer be cancelled.'});
 const shop=await getPool().query('SELECT id FROM restaurants ORDER BY id LIMIT 1');
 realtime.publish(`restaurant:${shop.rows[0]?.id}:staff`,'order.updated',rows[0]);
 res.json({success:true,data:rows[0]});
}));

router.post('/:id/dummy-payment',asyncHandler(async(req,res)=>{
 if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer account required.'});
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  const order=await client.query(`SELECT id,total,payment_status FROM orders WHERE id=$1 AND customer_id=$2 FOR UPDATE`,[req.params.id,req.identity.sub]);
  if(!order.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Order not found.'});}
  if(order.rows[0].payment_status==='PAID'){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'This order is already paid.'});}
  const reference=`DEMO-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  const payment=await client.query(`INSERT INTO payments(order_id,method,amount,status,is_simulated,reference) VALUES($1,'DEMO',$2,'CONFIRMED',TRUE,$3) RETURNING id,status,is_simulated AS "isSimulated",reference,created_at AS "createdAt"`,[req.params.id,order.rows[0].total,reference]);
  await client.query(`UPDATE orders SET payment_status='PAID',updated_at=NOW() WHERE id=$1`,[req.params.id]);
  await client.query('COMMIT');
  const shop=await getPool().query('SELECT id FROM restaurants ORDER BY id LIMIT 1');
  realtime.publish(`restaurant:${shop.rows[0]?.id}:staff`,'payment.updated',{orderId:Number(req.params.id),status:'CONFIRMED',isSimulated:true});
  res.status(201).json({success:true,data:payment.rows[0],message:'Demo payment recorded. No real money was charged.'});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));

router.post('/:id/review',asyncHandler(async(req,res)=>{
 if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer account required.'});
 const rating=Number(req.body.rating),comment=String(req.body.comment||'').slice(0,1000);
 if(!Number.isInteger(rating)||rating<1||rating>5)return res.status(400).json({success:false,message:'Rating must be from 1 to 5.'});
 const result=await getPool().query(`INSERT INTO reviews(customer_id,order_id,rating,comment) SELECT $2,id,$3,$4 FROM orders WHERE id=$1 AND customer_id=$2 AND payment_status='PAID' RETURNING id,rating,comment,created_at AS "createdAt"`,[req.params.id,req.identity.sub,rating,comment]);
 if(!result.rowCount)return res.status(409).json({success:false,message:'Review requires a paid order.'});
 res.status(201).json({success:true,data:result.rows[0]});
}));

module.exports=router;
