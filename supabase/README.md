# Supabase setup

Two roles: **customer** (buys with their balance) and **admin** (sets prices,
works the order queue, credits balances). Everything is enforced in the
database: the app only decides what to *show*.

## 1. Apply the schema (once)

Dashboard → **SQL Editor** → New query. Run these files **in order**:

1. `migrations/20260920120000_roles_wallet_catalog.sql`: tables, roles,
   wallets, row level security, purchase/admin functions.
2. `migrations/20260921090000_orders_vault_admin.sql`: the *Processing* order
   step, the code vault, game IDs, language, admin delivery.
3. `migrations/20260922100000_catalog_curation.sql`: artwork, regions, old prices, admin-only
   supplier data. New products/packages now start OFF.
4. `migrations/20260922140000_multifield_purchase_and_guards.sql`: multi-field buyer IDs
   (e.g. Mobile Legends), and guards that block game-password categories and
   one-time "first purchase only" offers.
5. `migrations/20260923090000_region_matching.sql`: per-package region lock (a locked
   package with no known account regions cannot go live) and the password-category
   block on each package's own supplier category.
6. `migrations/20260924090000_id_validation.sql`: server-enforced ID validation and region lock.
   The purchase refuses a validated region without a matching, unexpired (15 minute) record
   for the exact ID fields, and every order stores what was checked.
7. `migrations/20260925090000_supplier_catalog_cache.sql`: the saved supplier catalog (admin-only).
8. `migrations/20260925100000_admin_import.sql`: `admin_import_product`, the atomic import.
9. `migrations/20260925110000_remove_placeholder_products.sql`: removes the old placeholder products and the
   Free Fire test product. Refuses to run (deleting nothing) if any order points at them.

`seed.sql` is intentionally empty: the shop starts with no products, and everything in it is imported from
the supplier catalog. The tests use their own fixture, `tests/fixtures/placeholder-catalog.sql`.

All of them are safe to re-run. With the CLI (this project is linked):
`npx supabase db push --dry-run`, then `npx supabase db push`.

Tests: `npm run test:db` checks every rule against a real in-process Postgres.

## 2. Make yourself the first admin

Sign up in the app with your admin email, then run:

```sql
update public.profiles set role = 'admin' where email = 'YOUR_EMAIL_HERE';
```

Sign out and back in. Admins land on the **Queue** tab. Everyone else is a
customer: role is never read from sign-up data, and customers can't change it.

## 3. Give a customer balance

Customers can't add money themselves. Until a payment provider is connected,
an admin credits the wallet after receiving payment. In the app:
**Customers → tap the customer → Change balance**.

(In the SQL Editor, which has no signed-in user, act *as* the admin for one
transaction:)

```sql
begin;
select set_config('request.jwt.claim.sub', 'ADMIN_USER_ID', true);
select public.admin_adjust_balance('CUSTOMER_USER_ID', 500, 'cash deposit');
commit;
```

## How an order flows

| Product type | Customer gives | Admin does | Customer gets |
| --- | --- | --- | --- |
| **Games** (diamonds, UC…) | their game ID | copies the ID, tops it up, taps *Mark delivered* | the order turns *Completed* |
| **Gift cards, game keys, subscriptions** | nothing | pastes the code, taps *Mark delivered* | the code in their **Vault** |

Statuses: Pending → Processing → Completed. *Mark failed and refund* returns
the money at any point before delivery. Diamonds/UC never appear in the Vault:
no code exists for them. Vault codes can be marked used/unused but never
deleted.

| Action | Who | Database function |
| --- | --- | --- |
| Buy a product | customer | `purchase_product_option(option_id, delivery, id_checked)` |
| Start / fail / refund an order | admin | `admin_set_order_status(order_id, status)` |
| Deliver an order (+ code) | admin | `admin_deliver_order(order_id, code)` |
| Add / remove balance | admin | `admin_adjust_balance(user_id, amount, note)` |
| Promote / demote a user | admin | `admin_set_user_role(user_id, role)` |

The price charged is read from `product_options` on the server, so a modified
app can't pay less. A game top-up without a game ID is refused by the database.
A delivered gift-card order can't be refunded (the customer holds the code).

## Things to fill in

- **`src/lib/config.ts`**: your support link (e.g. your Telegram) for the
  Top up and Profile screens. Left empty, those buttons are hidden.
- **Authentication → Providers → Email → Confirm email.** On: new customers
  must click an emailed link first (the app shows a "check your email"
  screen). Off: they're signed in immediately.
- **Amharic text** lives in `src/lib/strings.ts`. Have a native speaker review
  it before launch.
- Never put the `service_role` key in the app or `.env`. Only the public anon
  key belongs there.
