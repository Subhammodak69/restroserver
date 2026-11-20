const express=require('express');
const asyncHandler=require('../utils/asyncHandler');
const {getPool}=require('../config/database');
const router=express.Router();

router.get('/resolve/:token',asyncHandler(async(req,res)=>{
 const {rows}=await getPool().query(`SELECT t.id,t.number AS "tableNumber",r.id AS "restaurantId",r.name AS "restaurantName",r.is_open AS "isOpen" FROM restaurant_tables t JOIN restaurants r ON r.id=t.restaurant_id WHERE t.qr_token=$1 AND t.is_active=TRUE`,[req.params.token]);
 if(!rows.length)return res.status(404).json({success:false,message:'This QR code is invalid or inactive.'});
 res.json({success:true,data:{...rows[0],qrToken:req.params.token}});
}));

module.exports=router;
