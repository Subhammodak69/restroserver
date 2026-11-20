# Server and Realtime API Plan

## Goal

The Express/PostgreSQL server is the source of truth for all three applications. It handles mobile OTP login, QR/table sessions, both home-delivery and dine-in orders, delivery workflow, dummy payments, admin data, analytics, and authenticated realtime events.

## Foundation and security

1. Use the versioned reset migration in `sql/migrations/` to replace the prior app schema with the compact business-flow schema. This reset drops prior application data by explicit request; `schema_migrations` remains so later migrations are tracked.
2. Add request validation, consistent API errors, rate limits, request IDs, structured logging, and health checks that report database/realtime readiness without exposing secrets.
3. Add customer OTP request/verify endpoints. Store only OTP hashes, enforce expiration and attempt/rate limits, and make SMS provider configurable. In development use a documented test OTP; never log production OTPs.
4. Add staff auth and role middleware. Store password/PIN hashes; authorize every staff/admin endpoint and scope every query and socket room by restaurant.
5. Validate signed QR tokens on server and map token to exactly one active restaurant table. Never trust restaurant/table ownership supplied in request bodies.

## Core data and business rules

- Restaurants, business settings, stations, categories, menu items/options, availability, and restaurant delivery zones.
- Staff, customers/verified phone numbers, saved delivery addresses, and customer consent/contact preferences.
- Restaurant tables, QR token mapping, table sessions, orders, KOTs, order item snapshots, service requests, and audit events.
- Delivery assignment/status timeline, dummy payment records, bills, reviews, and optional loyalty ledger.
- All prices, tax, discounts, fees, and order totals are recalculated from database values inside transactions.
- Dine-in and home delivery share order/item records but have explicit order type, address/table context, status rules, and event rooms.
- Dummy payments are recorded as simulated and never marked as real gateway settlement.

## API groups

### Public/customer

- `GET /api/public/restaurant` and `/menu` for website configuration and public menu.
- `POST /api/auth/otp/request`, `POST /api/auth/otp/verify`, `GET /api/auth/me`.
- `POST /api/tables/resolve/:qrToken`, `POST /api/sessions`, `GET /api/sessions/:id`.
- `POST /api/sessions/:id/orders` and `POST /api/orders` for dine-in/home delivery.
- `GET /api/orders`, `GET /api/orders/:id`, `POST /api/orders/:id/cancel` subject to status rules.
- `POST /api/delivery/quote` and address/coverage endpoints.
- `POST /api/orders/:id/dummy-payment` and payment status lookup.
- `POST /api/sessions/:id/requests`, review endpoints, and customer profile endpoints.

### Staff/admin

- `/api/staff/orders`, order/item transition endpoints, station queues, waiter requests, and table floor/status.
- `/api/admin/menu`, categories, options, stations, tables/QR, staff, customers, settings, and delivery zones.
- `/api/admin/reports` with validated date windows and server-side aggregates for charts and recent orders.
- Billing, split, cash-confirmation, and demo-payment endpoints with role checks and audit logs.

## Realtime contract

Use Socket.IO with authenticated handshakes. Rooms are scoped as `restaurant:{id}:staff`, `restaurant:{id}:station:{id}`, `session:{id}`, `customer:{id}`, and `delivery:{staffId}`. Authorize room joins server-side.

Events include `order.created`, `order.updated`, `orderItem.updated`, `kitchen.ready`, `serviceRequest.created`, `serviceRequest.resolved`, `table.updated`, `delivery.assigned`, `delivery.statusChanged`, and `payment.updated`. Persist state before emitting. Include event/entity IDs and timestamps; clients deduplicate and fetch REST snapshots after reconnect.

## Build order

1. Migrations and seed strategy; validation/error/logging/security foundations.
2. OTP and staff auth, role/restaurant authorization, QR resolve.
3. Transactional session and order placement for dine-in and home delivery; totals and state transitions.
4. Staff/kitchen/table/request APIs and authenticated Socket.IO events.
5. Delivery quote/assignment/status workflow and customer order tracking.
6. Bills and clearly simulated payment records; reviews and loyalty only after payment states are consistent.
7. Admin catalog/settings APIs and date-filtered dashboard/report aggregates.
8. Integration coverage for OTP limits, QR ownership, cross-restaurant isolation, order state transitions, concurrency/idempotency, delivery totals, and dummy payments.

## Acceptance criteria

- A customer must verify a mobile OTP to place either mode of order; dine-in requests remain bound to the QR-resolved table/session.
- Home delivery uses server-validated coverage and server-calculated price/fee/total.
- Duplicate requests/retries cannot create duplicate orders or demo payments; invalid transitions are rejected.
- Authorized customer, staff, kitchen, admin, and delivery clients receive only the relevant realtime events.
- Every app can recover current state from REST after disconnect; no screen depends on a missed socket event.
- Admin analytics use the selected period and match underlying completed/paid order data under the chosen business rules.
