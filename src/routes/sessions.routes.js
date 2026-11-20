const express = require('express');
const crypto = require('node:crypto');
const asyncHandler = require('../utils/asyncHandler');
const { getPool } = require('../config/database');
const { authenticate, optionalAuthenticate } = require('../middleware/auth');
const { placeOrder } = require('../services/orders');
const realtime = require('../realtime');

const router = express.Router();

router.post('/', optionalAuthenticate, asyncHandler(async (req,res) => {
  const qrToken=String(req.body.qrToken||'');
  if(!/^[a-f0-9-]{32,40}$/i.test(qrToken)) return res.status(400).json({success:false,message:'Scan a valid table QR code.'});
  const client=await getPool().connect();
  try{
    await client.query('BEGIN');
    const table=await client.query(`SELECT id,number,restaurant_id FROM restaurant_tables WHERE qr_token=$1 AND is_active=TRUE FOR UPDATE`,[qrToken]);
    if(!table.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'This table QR is invalid or inactive.'});}
    const t=table.rows[0];
    let session=await client.query(`SELECT id,status FROM table_sessions WHERE table_id=$1 AND status IN ('OPEN','BILL_REQUESTED') FOR UPDATE`,[t.id]);
    if(!session.rowCount) session=await client.query(`INSERT INTO table_sessions(table_id,customer_id) VALUES($1,$2) RETURNING id,status`,[t.id,req.identity?.role==='CUSTOMER'?req.identity.sub:null]);
    await client.query(`UPDATE restaurant_tables SET status='OCCUPIED' WHERE id=$1 AND status='FREE'`,[t.id]);
    await client.query('COMMIT');
    res.json({success:true,data:{id:session.rows[0].id,status:session.rows[0].status,tableNumber:t.number,restaurantId:t.restaurant_id,qrToken}});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));

router.get('/:id', asyncHandler(async(req,res)=>{
  const id=Number(req.params.id), qrToken=String(req.query.qrToken||'');
  if(!Number.isInteger(id)||id<1) return res.status(400).json({success:false,message:'Invalid table session.'});
  const session=await getPool().query(`SELECT ts.id,ts.status,t.number AS "tableNumber" FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id WHERE ts.id=$1 AND t.qr_token=$2`,[id,qrToken]);
  if(!session.rowCount)return res.status(404).json({success:false,message:'Table session not found.'});
  const orders=await getPool().query(
   `SELECT o.id,o.order_number AS "orderNumber",o.status,o.order_type AS "orderType",o.placed_at AS "placedAt",
           COALESCE(MAX(mi.prep_minutes),15) AS eta,
           COALESCE(jsonb_agg(jsonb_build_object('name',oi.item_name,'quantity',oi.quantity,'status',oi.status)) FILTER (WHERE oi.id IS NOT NULL),'[]'::jsonb) AS items
    FROM orders o LEFT JOIN order_items oi ON oi.order_id=o.id LEFT JOIN menu_items mi ON mi.id=oi.menu_item_id
    WHERE o.session_id=$1 GROUP BY o.id ORDER BY o.placed_at DESC`,[id]);
  res.json({success:true,data:{...session.rows[0],orders:orders.rows}});
}));

router.get('/:id/bill',asyncHandler(async(req,res)=>{
 const id=Number(req.params.id),token=String(req.query.qrToken||'');
 const result=await getPool().query(`SELECT ts.id,ts.status,t.number AS "tableNumber",COALESCE(SUM(o.subtotal),0) AS subtotal,COALESCE(SUM(o.tax),0) AS tax,COALESCE(SUM(o.service_charge),0) AS "serviceCharge",COALESCE(SUM(o.total),0) AS total,COALESCE(SUM(o.total) FILTER(WHERE o.payment_status='PAID'),0) AS paid,COALESCE(SUM(o.total) FILTER(WHERE o.payment_status<>'PAID'),0) AS due
 FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id LEFT JOIN orders o ON o.session_id=ts.id AND o.status<>'CANCELLED' WHERE ts.id=$1 AND t.qr_token=$2 GROUP BY ts.id,t.number`,[id,token]);
 if(!result.rowCount)return res.status(404).json({success:false,message:'Table session not found.'});
 const items=await getPool().query(`SELECT oi.item_name AS name,SUM(oi.quantity)::int AS quantity,oi.unit_price AS "unitPrice",SUM(oi.line_total) AS total FROM orders o JOIN order_items oi ON oi.order_id=o.id WHERE o.session_id=$1 AND o.status<>'CANCELLED' GROUP BY oi.item_name,oi.unit_price ORDER BY oi.item_name`,[id]);
 res.json({success:true,data:{...result.rows[0],items:items.rows}});
}));

router.post('/:id/dummy-payment',authenticate,asyncHandler(async(req,res)=>{
 if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer sign-in is required.'});
 const client=await getPool().connect();
 try{
  await client.query('BEGIN');
  const session=await client.query(`SELECT ts.id,t.id AS table_id,t.qr_token,t.restaurant_id FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id WHERE ts.id=$1 AND t.qr_token=$2 AND ts.status IN ('OPEN','BILL_REQUESTED') FOR UPDATE`,[req.params.id,req.body.qrToken]);
  if(!session.rowCount){await client.query('ROLLBACK');return res.status(404).json({success:false,message:'Table session not found or already closed.'});}
  const orders=await client.query(`SELECT id,total FROM orders WHERE session_id=$1 AND status<>'CANCELLED' AND payment_status<>'PAID' FOR UPDATE`,[req.params.id]);
  if(!orders.rowCount){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'There is no unpaid balance for this table.'});}
  const paid=[];
  for(const order of orders.rows){
   const reference=`DEMO-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
   const p=await client.query(`INSERT INTO payments(order_id,method,amount,status,is_simulated,reference) VALUES($1,'DEMO',$2,'CONFIRMED',TRUE,$3) RETURNING id,reference`,[order.id,order.total,reference]);
   await client.query(`UPDATE orders SET payment_status='PAID',updated_at=NOW() WHERE id=$1`,[order.id]);paid.push(p.rows[0]);
  }
  await client.query(`UPDATE table_sessions SET status='PAID',ended_at=NOW() WHERE id=$1`,[req.params.id]);
  await client.query(`UPDATE restaurant_tables SET status='FREE' WHERE id=$1`,[session.rows[0].table_id]);
  await client.query('COMMIT');
  realtime.publish(`restaurant:${session.rows[0].restaurant_id}:staff`,'payment.updated',{sessionId:Number(req.params.id),status:'CONFIRMED',isSimulated:true});
  realtime.publish(`session:${req.params.id}`,'payment.updated',{sessionId:Number(req.params.id),status:'CONFIRMED',isSimulated:true});
  realtime.publish(`customer:${req.identity.sub}`,'payment.updated',{sessionId:Number(req.params.id),status:'CONFIRMED',isSimulated:true});
  res.status(201).json({success:true,data:{payments:paid,isSimulated:true},message:'Demo payment recorded. No real money was charged.'});
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));

router.post('/:id/orders',authenticate,asyncHandler(async(req,res)=>{
  if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer sign-in is required.'});
  const order=await placeOrder({customerId:req.identity.sub,orderType:'DINE_IN',sessionId:Number(req.params.id),tableToken:req.body.qrToken,items:req.body.items,idempotencyKey:req.get('Idempotency-Key')||null});
  res.status(order.idempotent?200:201).json({success:true,data:order});
}));

router.post('/:id/requests',authenticate,asyncHandler(async(req,res)=>{
  if(req.identity.role!=='CUSTOMER')return res.status(403).json({success:false,message:'Customer sign-in is required.'});
  const sessionId=Number(req.params.id),type=String(req.body.type||'OTHER').toUpperCase().slice(0,40),qrToken=String(req.body.qrToken||'');
  const client=await getPool().connect();
  try{
    await client.query('BEGIN');
    const result=await client.query(`INSERT INTO service_requests(session_id,type) SELECT ts.id,$3 FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id WHERE ts.id=$1 AND t.qr_token=$2 AND ts.status IN ('OPEN','BILL_REQUESTED') ON CONFLICT DO NOTHING RETURNING id,type,status,created_at AS "createdAt"`,[sessionId,qrToken,type]);
    if(!result.rowCount){await client.query('ROLLBACK');return res.status(409).json({success:false,message:'This request is already open or the table session ended.'});}
    await client.query(`UPDATE restaurant_tables SET status=CASE WHEN $2='BILL' THEN 'BILL_REQUESTED' ELSE 'NEEDS_HELP' END WHERE id=(SELECT table_id FROM table_sessions WHERE id=$1)`,[sessionId,type]);
    if(type==='BILL')await client.query(`UPDATE table_sessions SET status='BILL_REQUESTED' WHERE id=$1`,[sessionId]);
    await client.query('COMMIT');
    const {rows}=await getPool().query(`SELECT ts.table_id,t.restaurant_id FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id WHERE ts.id=$1`,[sessionId]);
    realtime.publish(`restaurant:${rows[0]?.restaurant_id}:staff`,'serviceRequest.created',result.rows[0]);
    realtime.publish(`session:${sessionId}`,'serviceRequest.created',result.rows[0]);
    res.status(201).json({success:true,data:result.rows[0],tableId:rows[0]?.table_id});
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}));

module.exports=router;
