# Restaurant App: Backend Implementation Guide

Stack: **Node.js + Express.js + MySQL** (mysql2), JWT auth, Razorpay payments, Socket.io (live orders).

> **Current project database:** this document is an earlier MySQL planning guide. The implemented API now uses PostgreSQL on Render through `pg`. Treat `src/config/database.js` and `sql/schema.sql` as the current implementation; MySQL-only DDL and `?` query placeholders below must be translated before use.

The backend serves two clients:
- **Part A: Customer (End-User) API**: home delivery orders, dine-in orders via table QR, payments, reviews.
- **Part B: Admin API**: manual order entry (POS), menu management, reports, profit/loss, reviews, tables/QR, expenses.

---

## 0. Shared Foundation

### 0.1 Folder structure
```
backend/
├── src/
│   ├── config/        (db.js, env.js, razorpay.js)
│   ├── middleware/    (auth.js, role.js, validate.js, error.js, upload.js)
│   ├── routes/
│   │   ├── user/      (auth, menu, tables, orders, payments, reviews, profile)
│   │   └── admin/     (auth, menu, categories, orders, pos, tables, reports, finance, reviews, customers, settings)
│   ├── controllers/   (user/*, admin/*)
│   ├── services/      (orderService, paymentService, reportService, qrService)
│   ├── sockets/       (index.js)
│   ├── utils/         (jwt.js, asyncHandler.js, pricing.js)
│   └── app.js
├── sql/schema.sql, sql/seed.sql
├── uploads/           (menu images)
├── .env
└── server.js
```

### 0.2 Install
```bash
npm init -y
npm i express mysql2 dotenv cors helmet morgan bcryptjs jsonwebtoken zod \
      multer razorpay qrcode socket.io express-rate-limit exceljs pdfkit
npm i -D nodemon
```

### 0.3 `.env`
```
PORT=5000
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=
DB_NAME=restaurant
JWT_SECRET=change_me
JWT_EXPIRES=7d
CLIENT_URL=http://localhost:5173
RAZORPAY_KEY_ID=
RAZORPAY_KEY_SECRET=
RAZORPAY_WEBHOOK_SECRET=
DELIVERY_FEE=40
FREE_DELIVERY_ABOVE=500
TAX_PERCENT=5
```

### 0.4 Database schema (`sql/schema.sql`)
```sql
CREATE DATABASE IF NOT EXISTS restaurant;
USE restaurant;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  phone VARCHAR(15) UNIQUE NOT NULL,
  email VARCHAR(120) UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('customer','admin','staff') DEFAULT 'customer',
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE addresses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  label VARCHAR(30),
  line1 VARCHAR(200) NOT NULL,
  landmark VARCHAR(120),
  area VARCHAR(100),
  pincode VARCHAR(10) NOT NULL,
  is_default TINYINT(1) DEFAULT 0,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE categories (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  sort_order INT DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1
);

CREATE TABLE menu_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category_id INT NOT NULL,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  image_url VARCHAR(255),
  price DECIMAL(10,2) NOT NULL,        -- selling price
  cost_price DECIMAL(10,2) DEFAULT 0,  -- for profit calculation
  is_veg TINYINT(1) DEFAULT 1,
  is_available TINYINT(1) DEFAULT 1,
  is_active TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (category_id) REFERENCES categories(id)
);

CREATE TABLE restaurant_tables (
  id INT AUTO_INCREMENT PRIMARY KEY,
  table_number VARCHAR(10) UNIQUE NOT NULL,
  qr_token VARCHAR(64) UNIQUE NOT NULL,   -- random, used in QR url
  seats INT DEFAULT 4,
  is_active TINYINT(1) DEFAULT 1
);

CREATE TABLE orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_no VARCHAR(20) UNIQUE NOT NULL,         -- e.g. ORD-20261105-0001
  user_id INT NULL,                              -- NULL for walk-in manual orders
  customer_name VARCHAR(100),
  customer_phone VARCHAR(15),
  order_type ENUM('DELIVERY','DINE_IN','TAKEAWAY') NOT NULL,
  source ENUM('ONLINE','TABLE_QR','ADMIN_POS') NOT NULL,
  table_id INT NULL,
  address_id INT NULL,
  delivery_address TEXT NULL,                    -- snapshot
  status ENUM('PLACED','ACCEPTED','PREPARING','READY','OUT_FOR_DELIVERY','SERVED','DELIVERED','COMPLETED','CANCELLED') DEFAULT 'PLACED',
  subtotal DECIMAL(10,2) NOT NULL,
  tax DECIMAL(10,2) DEFAULT 0,
  delivery_fee DECIMAL(10,2) DEFAULT 0,
  discount DECIMAL(10,2) DEFAULT 0,
  total DECIMAL(10,2) NOT NULL,
  payment_status ENUM('PENDING','PAID','FAILED','REFUNDED') DEFAULT 'PENDING',
  payment_method ENUM('ONLINE','CASH','UPI_COUNTER','CARD_COUNTER') NULL,
  notes VARCHAR(255),
  created_by INT NULL,                           -- admin/staff id for POS orders
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (table_id) REFERENCES restaurant_tables(id),
  INDEX idx_created (created_at),
  INDEX idx_status (status)
);

CREATE TABLE order_items (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  menu_item_id INT NOT NULL,
  item_name VARCHAR(120) NOT NULL,     -- snapshot
  unit_price DECIMAL(10,2) NOT NULL,   -- snapshot
  unit_cost DECIMAL(10,2) NOT NULL,    -- snapshot (for profit)
  quantity INT NOT NULL,
  line_total DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE,
  FOREIGN KEY (menu_item_id) REFERENCES menu_items(id)
);

CREATE TABLE payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL,
  provider ENUM('RAZORPAY','CASH','COUNTER') NOT NULL,
  provider_order_id VARCHAR(80),
  provider_payment_id VARCHAR(80),
  signature VARCHAR(255),
  amount DECIMAL(10,2) NOT NULL,
  status ENUM('CREATED','PAID','FAILED','REFUNDED') DEFAULT 'CREATED',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id)
);

CREATE TABLE reviews (
  id INT AUTO_INCREMENT PRIMARY KEY,
  order_id INT NOT NULL UNIQUE,
  user_id INT NOT NULL,
  rating TINYINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  admin_reply TEXT,
  is_visible TINYINT(1) DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (order_id) REFERENCES orders(id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  category ENUM('RENT','SALARY','RAW_MATERIAL','UTILITIES','MARKETING','MAINTENANCE','OTHER') NOT NULL,
  description VARCHAR(255),
  amount DECIMAL(10,2) NOT NULL,
  expense_date DATE NOT NULL,
  created_by INT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE settings (
  k VARCHAR(50) PRIMARY KEY,
  v VARCHAR(255)
);
-- keys: delivery_fee, free_delivery_above, tax_percent, delivery_pincodes, accepting_orders, min_order_value
```

### 0.5 Core middleware
- `auth.js`: read `Authorization: Bearer <jwt>`, verify, attach `req.user = {id, role}`.
- `role.js`: `requireRole('admin','staff')` for admin routes.
- `validate.js`: zod schema validation for body, params, query.
- `error.js`: central error handler returning `{ success:false, message }`.
- Apply `helmet`, `cors({origin: CLIENT_URL})`, and `express-rate-limit` on `/auth/*` routes.

### 0.6 Order creation service (shared by user and admin POS)
`orderService.createOrder({ userInfo, type, source, items, tableId, address, paymentMethod, createdBy })`:
1. Start a **transaction**.
2. Load each `menu_items` row by id; reject if `is_available=0` or `is_active=0`.
3. **Never trust prices from the client.** Compute from DB: `subtotal = Σ price × qty`.
4. Compute `tax = subtotal × TAX_PERCENT/100`, delivery fee (only for DELIVERY; free above threshold), discount.
5. Insert into `orders`, then `order_items` with snapshots of `item_name`, `unit_price`, `unit_cost`.
6. Generate `order_no` (date + daily sequence).
7. Commit, then emit socket event `order:new` to the admin room.

### 0.7 Order status flow
- DELIVERY: `PLACED → ACCEPTED → PREPARING → READY → OUT_FOR_DELIVERY → DELIVERED → COMPLETED`
- DINE_IN: `PLACED → ACCEPTED → PREPARING → READY → SERVED → COMPLETED`
- TAKEAWAY: `PLACED → ACCEPTED → PREPARING → READY → COMPLETED`
- `CANCELLED` is allowed only before `PREPARING`.
- Enforce valid transitions in a single `canTransition(type, from, to)` helper.

---

# PART A: End-User (Customer) API

Base path: `/api/user`

## A1. Auth: `/api/user/auth`
| Method | Route | Purpose |
|---|---|---|
| POST | `/register` | name, phone, email?, password → creates `customer` |
| POST | `/login` | phone + password → JWT |
| GET | `/me` | profile (auth) |
| PUT | `/me` | update name/email |
| PUT | `/me/password` | change password |

Notes: hash with bcrypt (10 rounds). Later you can add OTP login (MSG91 or Twilio), which is common in India.

## A2. Addresses: `/api/user/addresses` (auth)
`GET /`, `POST /`, `PUT /:id`, `DELETE /:id`, `PUT /:id/default`

Delivery check: `POST /api/user/delivery/check` with `{ pincode }` returns `{ deliverable, fee }`, using the `delivery_pincodes` setting. This is how the "near the town" rule is enforced.

## A3. Menu (public): `/api/user/menu`
| Method | Route | Purpose |
|---|---|---|
| GET | `/categories` | active categories |
| GET | `/items?category=&veg=&q=` | available items, with filter and search |
| GET | `/items/:id` | item detail with average rating |
| GET | `/settings` | public info: accepting_orders, fees, tax, min order |

## A4. Table QR flow: `/api/user/tables`
- Each table has a unique `qr_token`. The QR encodes: `https://yourdomain.com/t/<qr_token>`
- `GET /api/user/tables/resolve/:qr_token` returns `{ tableId, tableNumber }`, or 404 if invalid or inactive.
- The frontend stores the table in session and the menu is used in **DINE_IN mode**.
- Dine-in customers may order **without login**, using a name and phone only. Create a guest order with `user_id = NULL`. Optionally let them log in to get the order history.
- Dine-in orders can be tracked using `GET /api/user/orders/track/:order_no?phone=` (no auth, phone must match).

## A5. Orders: `/api/user/orders`
| Method | Route | Auth | Purpose |
|---|---|---|---|
| POST | `/` | optional | place order |
| GET | `/` | yes | my orders (paginated) |
| GET | `/:id` | yes | order detail with items and payment |
| GET | `/track/:order_no` | phone check | guest tracking |
| POST | `/:id/cancel` | yes | only while status = PLACED/ACCEPTED |

`POST /` body:
```json
{
  "orderType": "DELIVERY | DINE_IN | TAKEAWAY",
  "tableToken": "required if DINE_IN",
  "addressId": "required if DELIVERY",
  "customer": { "name": "", "phone": "" },
  "items": [{ "menuItemId": 1, "quantity": 2 }],
  "paymentMethod": "ONLINE | CASH",
  "notes": ""
}
```
Rules:
- DELIVERY requires login, a valid address, a deliverable pincode, and `min_order_value`.
- DINE_IN resolves `tableToken` to `table_id` and sets `source = TABLE_QR`.
- Reject if the `accepting_orders` setting is `false`.
- With `ONLINE`, create the order with `payment_status = PENDING` and return the Razorpay order (see A6). With `CASH`, create the order directly (pay on delivery or at the table).

## A6. Payments: `/api/user/payments` (Razorpay)
1. `POST /create` `{ orderId }`: server calls `razorpay.orders.create({ amount: total*100, currency:'INR', receipt: order_no })`, saves a `payments` row with status CREATED, returns `{ razorpayOrderId, amount, keyId }`.
2. Frontend opens Razorpay Checkout (UPI, cards, netbanking, wallets).
3. `POST /verify` `{ razorpay_order_id, razorpay_payment_id, razorpay_signature }`: compute `HMAC_SHA256(order_id + "|" + payment_id, KEY_SECRET)` and compare with the signature. If valid, set payment `PAID` and order `payment_status = PAID`.
4. `POST /webhook` (raw body; verify `X-Razorpay-Signature` with `RAZORPAY_WEBHOOK_SECRET`) handles `payment.captured` and `payment.failed`. This is the safety net if the browser closes before `/verify`.
5. Failed or abandoned payments leave the order `PENDING`. A cron job (node-cron) can cancel unpaid ONLINE orders after 15 minutes.

## A7. Reviews: `/api/user/reviews` (auth)
- `POST /` `{ orderId, rating, comment }`: only if the order belongs to the user and is `COMPLETED` or `DELIVERED`, and no review exists yet.
- `GET /mine`
- `GET /public?limit=` shows visible reviews on the home page.

## A8. Realtime (customer side)
Socket.io: the customer joins room `order:<id>` after placing an order and receives `order:status` events so the tracking screen updates live.

---

# PART B: Admin API

Base path: `/api/admin`. Every route uses `auth` + `requireRole('admin','staff')`. Destructive routes (delete, reports, finance, settings) are **admin only**.

## B1. Auth: `/api/admin/auth`
- `POST /login` (same users table, role must be admin or staff)
- Seed the first admin through `sql/seed.sql` or a CLI script. There is no public admin registration.
- `POST /staff` (admin only) creates staff accounts. `GET /staff`, `PUT /staff/:id/toggle`.

## B2. Dashboard: `/api/admin/dashboard`
`GET /summary` returns today's orders, today's revenue, pending orders, average rating, and top 5 items. This is a few aggregate SQL queries.

## B3. Live orders: `/api/admin/orders`
| Method | Route | Purpose |
|---|---|---|
| GET | `/?status=&type=&source=&from=&to=&page=` | list with filters |
| GET | `/:id` | detail |
| PUT | `/:id/status` | move through the status flow (validated) |
| PUT | `/:id/payment` | mark paid (cash/counter), `{ method }` |
| POST | `/:id/cancel` | cancel with reason, refund flag |
| GET | `/:id/invoice` | PDF bill via pdfkit |

Socket: admin joins room `admins` and receives `order:new` and `order:updated` (play a sound on the admin UI).

## B4. Manual order entry (POS): `/api/admin/pos`
This is the "customer orders manually, admin enters it" flow.
- `POST /orders`: same body as user order but with:
  - `source = 'ADMIN_POS'`, `created_by = req.user.id`
  - the customer is optional (`name`, `phone`), and no login is needed
  - `orderType`: DINE_IN (pick the table), TAKEAWAY, or DELIVERY (phone call; address typed in manually)
  - `paymentMethod`: CASH, UPI_COUNTER, CARD_COUNTER, with `paid: true/false`
  - optional `discount`
- It reuses `orderService.createOrder()` so reports treat all sources identically.
- `GET /tables/status` shows which tables currently have open (not completed) orders.
- `POST /orders/:id/add-items` appends items to an open dine-in order, so a table can order more.

## B5. Menu and categories
`/api/admin/categories`: CRUD plus reorder (`PUT /reorder` with `[ {id, sort_order} ]`)

`/api/admin/menu`:
| Method | Route | Purpose |
|---|---|---|
| GET | `/` | all items (including unavailable) |
| POST | `/` | create (multipart, `image` via multer) |
| PUT | `/:id` | update price, cost_price, description, image |
| PATCH | `/:id/availability` | quick "sold out" toggle |
| DELETE | `/:id` | soft delete (`is_active = 0`), because old orders reference it |

## B6. Tables and QR codes: `/api/admin/tables`
- `GET /`, `POST /` (generates a random `qr_token` with `crypto.randomBytes(16).toString('hex')`), `PUT /:id`, `DELETE /:id`.
- `GET /:id/qr.png` returns a QR image generated by the `qrcode` package for `${CLIENT_URL}/t/${qr_token}`.
- `GET /qr/print-sheet` returns a PDF with every table QR and its table number, ready to print and laminate.
- `POST /:id/regenerate` issues a new token if a QR is misused.

## B7. Reports: `/api/admin/reports` (admin only)
All accept `from`, `to`, and `groupBy=day|week|month`. All support `?format=json|xlsx|pdf`.

| Route | Content |
|---|---|
| `/sales` | revenue, orders, average order value, grouped over time |
| `/sales/by-type` | DELIVERY vs DINE_IN vs TAKEAWAY |
| `/sales/by-source` | ONLINE vs TABLE_QR vs ADMIN_POS |
| `/items` | best and worst sellers (qty, revenue, profit) |
| `/categories` | revenue per category |
| `/payments` | totals per method (online, cash, counter) |
| `/peak-hours` | orders by hour of day and day of week |
| `/customers` | top customers, new vs repeat |
| `/tax` | tax collected (for GST filing) |

Example sales SQL:
```sql
SELECT DATE(created_at) AS day, COUNT(*) AS orders, SUM(total) AS revenue
FROM orders
WHERE status IN ('COMPLETED','DELIVERED','SERVED') AND payment_status='PAID'
  AND created_at BETWEEN ? AND ?
GROUP BY DATE(created_at) ORDER BY day;
```
Only count paid, non-cancelled orders in revenue. Export with `exceljs` (xlsx) and `pdfkit` (pdf).

## B8. Profit and loss: `/api/admin/finance` (admin only)
Expenses CRUD: `GET/POST/PUT/DELETE /expenses` (filter by date and category).

`GET /profit-loss?from=&to=`:
```
Revenue (net of tax)  = Σ (subtotal - discount) of paid completed orders
COGS                  = Σ (order_items.unit_cost × quantity)
Gross Profit          = Revenue - COGS
Operating Expenses    = Σ expenses in the period (rent, salary, utilities, ...)
Net Profit / Loss     = Gross Profit - Operating Expenses
Margin %              = Net Profit / Revenue × 100
```
Return both the totals and a monthly breakdown (for the chart). Also expose `GET /profit-loss/items` for per-item margin (price - cost_price).

Note: if you buy raw materials as `RAW_MATERIAL` expenses *and* also set `cost_price` per item, you would double-count. Choose one: either track item `cost_price` (recommended for simplicity, so exclude RAW_MATERIAL from the operating expenses), or track raw material expenses only and set `cost_price = 0`.

## B9. Reviews: `/api/admin/reviews`
- `GET /?rating=&from=&to=` with an average and a rating distribution (1 to 5).
- `PUT /:id/reply` `{ admin_reply }`
- `PUT /:id/visibility` hides or shows a review on the public site.

## B10. Customers: `/api/admin/customers`
- `GET /` list with total orders and total spent, `GET /:id` order history, `PUT /:id/toggle` block or unblock.

## B11. Settings: `/api/admin/settings` (admin only)
`GET /`, `PUT /`: delivery fee, free-delivery threshold, tax %, deliverable pincodes, min order value, and the **accepting orders** switch (shut off online ordering when the kitchen is overloaded).

---

## Appendix: Sockets (`sockets/index.js`)
```js
io.use(verifyJwtOptional);
io.on('connection', (socket) => {
  if (['admin','staff'].includes(socket.user?.role)) socket.join('admins');
  socket.on('track:order', (orderId) => socket.join(`order:${orderId}`));
});
// in orderService after create:   io.to('admins').emit('order:new', order)
// in status update:               io.to('admins').emit('order:updated', o);
//                                 io.to(`order:${o.id}`).emit('order:status', o.status)
```

## Appendix: Security checklist
- Parameterized queries only (mysql2 `?` placeholders).
- Re-compute all prices on the server.
- Verify the Razorpay signature and webhook.
- Rate-limit auth routes, validate every input with zod.
- Restrict uploads to images under 2 MB.
- Admin routes sit behind role middleware. Hide invalid QR tokens behind 404.
- Take daily MySQL backups (`mysqldump` via cron).

## Appendix: Suggested build order
1. DB schema and seed, auth, middleware
2. Menu and categories (admin CRUD, then public read)
3. Order service, user order API, admin order list and status
4. Table QR (generation, resolve, dine-in ordering)
5. Razorpay payments and webhook
6. Admin POS (manual order entry)
7. Sockets (live orders)
8. Reviews
9. Reports and expenses and profit/loss
10. Settings, invoices, exports, cron jobs, deployment
