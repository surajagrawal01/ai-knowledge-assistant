# Seed Data (ElectroNest, dummy Indian data)

| File | Rows | Load order |
|---|---|---|
| `customers.json` | 20 | 1 |
| `products.json` | 10 | 2 |
| `orders.json` | 50 | 3 |
| `order_items.json` | 63 | 4 |
| `payments.json` | 50 | 5 |
| `tickets.json` | 15 | 6 |

**Delete in the reverse order** (tickets → payments → order_items → orders → products → customers).

## Field conventions

- Money is in **rupees** (₹), stored as `Decimal(10,2)`
- Dates are **relative**: `orderedDaysAgo`, `shippedDaysAgo`, `deliveredDaysAgo`, `paidDaysAgo`, `createdDaysAgo`, `joinedDaysAgo`. Convert them with `new Date(Date.now() - n * 86_400_000)`; `null` stays `null`
- `order_items` has no `id` (Postgres autoincrement generates it)
- Enum values match `schema.prisma` exactly (lowercase: `upi`, `delivered`, `in_progress`...)
- All names, emails and phone numbers are fictional

## How to use

Copy this folder to `backend/prisma/seed-data/` and run `npm run db:seed`.
