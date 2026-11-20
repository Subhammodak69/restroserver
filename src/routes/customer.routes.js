const express=require('express');
const authRoutes=require('./auth.routes');
const menuRoutes=require('./menu.routes');
const sessionRoutes=require('./sessions.routes');
const tableRoutes=require('./tables.routes');
const orderRoutes=require('./orders.routes');
const asyncHandler=require('../utils/asyncHandler');
const {getPool}=require('../config/database');

const router=express.Router();
router.use('/auth',authRoutes);
router.use('/menu',menuRoutes);
router.use('/tables',tableRoutes);
router.use('/sessions',sessionRoutes);
router.use('/orders',orderRoutes);

router.post('/delivery/quote',asyncHandler(async(req,res)=>{
 const postalCode=String(req.body.postalCode||'').trim(),subtotal=Number(req.body.subtotal);
 if(!/^\d{5,10}$/.test(postalCode)||!Number.isFinite(subtotal)||subtotal<0)return res.status(400).json({success:false,message:'Enter a valid postal code and subtotal.'});
 const {rows}=await getPool().query(`SELECT z.delivery_fee AS "deliveryFee",z.minimum_order AS "minimumOrder",z.estimated_minutes AS "estimatedMinutes",r.tax_percent AS "taxPercent" FROM delivery_zones z JOIN restaurants r ON r.id=z.restaurant_id WHERE z.postal_code=$1 AND z.is_active=TRUE ORDER BY r.id LIMIT 1`,[postalCode]);
 if(!rows.length)return res.status(404).json({success:false,data:{deliverable:false},message:'We do not deliver to that postal code yet.'});
 const zone=rows[0],deliverable=subtotal>=Number(zone.minimumOrder);
 res.json({success:true,data:{...zone,deliverable,tax:Math.round(subtotal*Number(zone.taxPercent))/100,total:subtotal+(deliverable?Number(zone.deliveryFee):0)+Math.round(subtotal*Number(zone.taxPercent))/100}});
}));
module.exports=router;
