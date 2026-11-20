const crypto = require('node:crypto');
const realtime = require('../realtime');
const { getPool } = require('../config/database');

const moneyCents = (value) => Math.round(Number(value) * 100);
const amount = (cents) => (cents / 100).toFixed(2);

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function placeOrder({ customerId, orderType, sessionId = null, tableToken = null, address = null, items, idempotencyKey = null }) {
  if (!Array.isArray(items) || items.length < 1 || items.length > 30) throw fail(400, 'Add between 1 and 30 menu items.');
  if (orderType === 'DELIVERY' && (!address || !/^\d{5,10}$/.test(String(address.postalCode || '')) || !address.line1)) {
    throw fail(400, 'A complete delivery address and postal code are required.');
  }
  if (orderType === 'DINE_IN' && (!sessionId || !tableToken)) throw fail(400, 'Open the table QR before placing a dine-in order.');

  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const customer=await client.query(`SELECT is_blocked FROM customers WHERE id=$1 FOR SHARE`,[customerId]);
    if(!customer.rowCount||customer.rows[0].is_blocked)throw fail(403,'This customer account cannot place orders.');
    if (idempotencyKey) {
      const existing = await client.query(`SELECT id,order_number,status,total FROM orders WHERE customer_id=$1 AND idempotency_key=$2`, [customerId,idempotencyKey]);
      if (existing.rowCount) {
        await client.query('COMMIT');
        return { ...existing.rows[0], idempotent: true };
      }
    }

    const restaurant = await client.query(`SELECT id,tax_percent,service_charge_percent,delivery_fee,min_delivery_order,delivery_enabled,is_open FROM restaurants ORDER BY id LIMIT 1`);
    if (!restaurant.rowCount || !restaurant.rows[0].is_open) throw fail(409,'The restaurant is not accepting orders right now.');
    const shop = restaurant.rows[0];
    let zone = null;
    if (orderType === 'DELIVERY') {
      if (!shop.delivery_enabled) throw fail(409,'Home delivery is currently unavailable.');
      const z = await client.query(`SELECT delivery_fee,minimum_order,estimated_minutes FROM delivery_zones WHERE restaurant_id=$1 AND postal_code=$2 AND is_active=TRUE`,[shop.id,String(address.postalCode)]);
      if (!z.rowCount) throw fail(400,'We do not deliver to that postal code yet.');
      zone=z.rows[0];
    } else {
      const session = await client.query(
        `SELECT ts.id,ts.status,t.id AS table_id,t.qr_token FROM table_sessions ts JOIN restaurant_tables t ON t.id=ts.table_id
         WHERE ts.id=$1 AND t.qr_token=$2 AND t.is_active=TRUE AND ts.status IN ('OPEN','BILL_REQUESTED') FOR UPDATE`,[sessionId,tableToken]
      );
      if (!session.rowCount) throw fail(403,'This table session is no longer active. Scan the table QR again.');
      await client.query(`UPDATE table_sessions SET customer_id=COALESCE(customer_id,$2) WHERE id=$1`,[sessionId,customerId]);
    }

    let subtotalCents=0;
    const normalized=[];
    for(const line of items){
      const menuId=Number(line.menuItemId), qty=Number(line.quantity);
      if(!Number.isInteger(menuId)||!Number.isInteger(qty)||qty<1||qty>20) throw fail(400,'Each item needs a valid menu item and quantity.');
      const menu=await client.query(`SELECT mi.id,mi.name,mi.price,mi.station_id,mi.prep_minutes,mi.is_available,mi.restaurant_id FROM menu_items mi WHERE mi.id=$1 FOR SHARE`,[menuId]);
      if(!menu.rowCount||!menu.rows[0].is_available||Number(menu.rows[0].restaurant_id)!==Number(shop.id)) throw fail(409,'An item in this order is no longer available.');
      const m=menu.rows[0], input=line.options&&typeof line.options==='object'?line.options:{};
      const options=[];
      for(const type of ['SIZE','SPICE','ADDON']){
        const raw=type==='ADDON'?(Array.isArray(input.addons)?input.addons:[]):[input[type.toLowerCase()]].filter(Boolean);
        for(const label of raw){
          const option=await client.query(`SELECT label,price_delta FROM item_options WHERE item_id=$1 AND type=$2 AND lower(label)=lower($3) AND is_active=TRUE`,[m.id,type,String(label)]);
          if(!option.rowCount) throw fail(400,`The selected ${type.toLowerCase()} option is unavailable for ${m.name}.`);
          options.push({type,label:option.rows[0].label,delta:moneyCents(option.rows[0].price_delta)});
        }
      }
      const unitCents=moneyCents(m.price)+options.reduce((sum,opt)=>sum+opt.delta,0);
      const lineCents=unitCents*qty;
      subtotalCents+=lineCents;
      normalized.push({menu:m,qty,unitCents,lineCents,options:input,note:String(line.note||'').slice(0,300)});
    }
    if(orderType==='DELIVERY'&&subtotalCents<moneyCents(zone.minimum_order)) throw fail(400,`Minimum delivery order is ₹${Number(zone.minimum_order).toFixed(2)}.`);
    const taxCents=Math.round(subtotalCents*Number(shop.tax_percent)/100);
    const serviceCents=orderType==='DINE_IN'?Math.round(subtotalCents*Number(shop.service_charge_percent)/100):0;
    const feeCents=orderType==='DELIVERY'?moneyCents(zone.delivery_fee):0;
    const totalCents=subtotalCents+taxCents+serviceCents+feeCents;
    let kotNumber=1;
    if(sessionId){const kot=await client.query(`SELECT COALESCE(MAX(kot_number),0)+1 AS next FROM orders WHERE session_id=$1`,[sessionId]);kotNumber=Number(kot.rows[0].next);}
    const orderNo=`R-${new Date().toISOString().slice(0,10).replaceAll('-','')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const created=await client.query(
      `INSERT INTO orders(order_number,customer_id,session_id,kot_number,order_type,status,address,subtotal,tax,service_charge,delivery_fee,total,idempotency_key)
       VALUES($1,$2,$3,$4,$5,'NEW',$6::jsonb,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(customer_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING id,order_number AS "orderNumber",session_id AS "sessionId",order_type AS "orderType",status,subtotal,tax,service_charge AS "serviceCharge",delivery_fee AS "deliveryFee",total,placed_at AS "placedAt"`,
      [orderNo,customerId,sessionId,kotNumber,orderType,address?JSON.stringify(address):null,amount(subtotalCents),amount(taxCents),amount(serviceCents),amount(feeCents),amount(totalCents),idempotencyKey]
    );
    if(!created.rowCount&&idempotencyKey){
      const existing=await client.query(`SELECT id,order_number AS "orderNumber",session_id AS "sessionId",order_type AS "orderType",status,subtotal,tax,service_charge AS "serviceCharge",delivery_fee AS "deliveryFee",total,placed_at AS "placedAt" FROM orders WHERE customer_id=$1 AND idempotency_key=$2`,[customerId,idempotencyKey]);
      await client.query('COMMIT');return {...existing.rows[0],idempotent:true};
    }
    const order=created.rows[0];
    for(const line of normalized){
      await client.query(
        `INSERT INTO order_items(order_id,menu_item_id,item_name,quantity,unit_price,line_total,options,note,station_id)
         VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`,
        [order.id,line.menu.id,line.menu.name,line.qty,amount(line.unitCents),amount(line.lineCents),JSON.stringify(line.options),line.note,line.menu.station_id]
      );
    }
    if(orderType==='DELIVERY') await client.query(`INSERT INTO delivery_jobs(order_id,estimated_minutes) VALUES($1,$2)`,[order.id,zone.estimated_minutes]);
    await client.query('COMMIT');
    const event={orderId:order.id,orderNumber:order.orderNumber,orderType:order.orderType,status:order.status,sessionId:order.sessionId,placedAt:order.placedAt};
    realtime.publish(`restaurant:${shop.id}:staff`,'order.created',event);
    if(sessionId) realtime.publish(`session:${sessionId}`,'order.created',event);
    realtime.publish(`customer:${customerId}`,'order.created',event);
    for(const line of normalized) if(line.menu.station_id) realtime.publish(`restaurant:${shop.id}:station:${line.menu.station_id}`,'order.created',event);
    return {...order,items:normalized.map(line=>({name:line.menu.name,quantity:line.qty,unitPrice:amount(line.unitCents),lineTotal:amount(line.lineCents),status:'NEW',note:line.note}))};
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
}

module.exports={placeOrder};
