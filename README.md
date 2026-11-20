# Restro server

Express and PostgreSQL API shared by the customer website and manager app. The code is organized into separate customer, staff, and manager route modules; common order creation, OTP delivery, authentication, and realtime publishing live in services/middleware.

## Database reset and migrations

The compact schema is defined in `sql/schema.sql` and migrations are in `sql/migrations/`. **The first migration intentionally drops the previous Restro application tables and their data**, then creates the compact schema. PostgreSQL's system tables and `schema_migrations` are retained. This implements the requested reset; back up anything you still need before applying it.

Configure `DATABASE_URL`, then run from the workspace root:

```powershell
npm run db:migrate --prefix server
```

The runner records each migration and can resume if a later migration fails. It seeds a demo restaurant, menu, delivery postal code, stations, and eight uniquely QR-mapped tables.

## Configuration and startup

Copy `server/.env.example` to `server/.env`, set `DATABASE_URL`, and generate unique `JWT_SECRET` and `OTP_SECRET` values. Customer OTP returns `123456` in development. In production, set `SMS_API_URL` and `SMS_API_KEY` for an SMS endpoint that accepts `{to,message}` JSON; production OTP is not returned in the API response.

Create the first manager account after migration by setting `ADMIN_PHONE`, `ADMIN_PASSWORD` (8+ characters), and optional `ADMIN_NAME` in the environment and running:

```powershell
npm run db:create-admin --prefix server
```

Start the API with `npm run dev --prefix server`. The HTTP server also hosts authenticated Socket.IO connections on the same port. Set `CLIENT_URL` to the customer/admin origins, for example `http://localhost:3000,http://localhost:3001`.

## API overview

- Public restaurant and menu: `GET /api/menu/restaurant`, `/api/menu/categories`, `/api/menu/items`
- Customer OTP: `POST /api/auth/customer/otp`, `POST /api/auth/customer/verify`
- Table QR: `GET /api/tables/resolve/:token`, `POST /api/sessions`
- Dine-in: `POST /api/sessions/:id/orders`, `GET /api/sessions/:id`, `/bill`, `/dummy-payment`
- Home delivery: `POST /api/delivery/quote`, `POST /api/orders`; both require a verified customer token to place an order
- Customer order state and simulated payment: `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/dummy-payment`
- Manager APIs: `/api/admin/*` (manager token required)
- Floor, kitchen, waiter, and delivery staff APIs: `/api/staff/*` (role-scoped token required)
- Health: `GET /api/health`

Dummy payment records are marked simulated; no gateway is connected and no real money is charged.
