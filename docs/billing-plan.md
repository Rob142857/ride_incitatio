# Billing Plan: 3-Month Trial → $20/year (Stripe)

## Product & Pricing
- Product: Ride annual subscription
- Price: $20/year (charge annually; show monthly equivalent ~$1.67/mo for clarity)
- Trial: 3 months free (start immediately on signup/first checkout)
- Grace: optional 7-day grace after trial end (decide later; defaults to none)

## Stripe Objects
- Product: `ride_annual`
- Price: recurring, interval `year`, amount `2000`, currency `USD`, trial_period_days `90` (if handled at Stripe side)
- Customer: created per authenticated user (keyed by `user.id`)
- Subscription: 1 line (price above), status drives entitlement
- Webhooks: `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`, `checkout.session.completed`
- Portal: Stripe Billing customer portal for self-serve card updates/cancel

## Entitlement States
- `trialing`: access allowed; show “Trial ends DATE” banner
- `active`: paid/current; normal access
- `past_due` / `incomplete`: warn, retry; access allowed during grace (configurable)
- `canceled` / `unpaid`: disable cloud features; keep read-only or block; show paywall CTA

## Data Model (D1)
- `users`: add `stripe_customer_id`, `subscription_status`, `subscription_current_period_end`, `trial_end`, `entitlement` (derived), `last_receipt_url`
- `audit_logs`: record billing events (source: webhook/user actions)

## Backend (Cloudflare Worker/API)
- Endpoint: `POST /billing/create-checkout` → returns Stripe Checkout URL
  - requires auth; creates/gets customer; attaches price; trial if new
- Endpoint: `POST /billing/create-portal` → returns customer portal URL
- Middleware: enrich request context with `entitlement` for feature gating
- Webhook handler: validate signature; update user subscription fields; log events
- Feature gating: block cloud sync/share/export when entitlement not active/trial

## Frontend (App)
- Settings/Billing modal: show status (trial end, renew date), CTA to subscribe/manage billing
- Paywall states: when blocked, show overlay with CTA → Checkout
- Surface trial countdown in header/user menu; link to portal/manage

## Trial Logic
- If new user has no subscription: create customer; set `trial_end = now + 90d`
- If using Stripe trial on subscription: rely on `subscription.trial_end`
- Enforce on server: allow access when `now < trial_end` OR `subscription_status in {active, trialing}`

## Flows
1) **Start trial & checkout**
   - User authenticated → click “Start free 3-month trial”
   - Call `/billing/create-checkout`; Checkout uses trial; upon completion webhook sets active
2) **Manage billing**
   - User clicks “Manage billing” → `/billing/create-portal` → portal URL
3) **Trial ending**
   - Background job (cron/worker) emails/alerts at T-7, T-1 days; UI banner shows countdown
4) **Failure**
   - On `invoice.payment_failed`, mark `subscription_status = past_due`; show banner; retry per Stripe settings
5) **Cancellation**
   - On cancel, set status; allow through period end; after end, downgrade

## Security & Compliance
- Webhook secret validation; idempotency keys
- Do not expose Stripe secret key to client
- PII minimization: store only `customer_id`, status, dates; no card data
- Logging: redact sensitive fields

## Email/Notifications (future)
- Trial ending soon, payment failed, receipt links

## Ops Checklist
- Create Stripe Product/Price with trial
- Configure webhook endpoint + secrets
- Add env vars: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ANNUAL`
- Add D1 migration for new columns
- Add scheduled job for trial reminders (optional)

## Copy Suggestions
- CTA: “Start free 3-month trial” → “Then $20/year (~$1.67/mo). Cancel anytime.”
- Banner during trial: “Trial ends on DATE. Keep your trips synced by subscribing.”
- Lapse state: “Sync paused. Renew to keep cloud backups and sharing.”
