CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  trial_started_at INTEGER,
  trial_expires_at INTEGER,
  CHECK ((trial_started_at IS NULL) = (trial_expires_at IS NULL))
) STRICT;

CREATE TABLE entitlements (
  device_id TEXT PRIMARY KEY REFERENCES devices(id),
  kind TEXT NOT NULL CHECK (kind IN ('trial', 'pro')),
  plan_id TEXT NOT NULL CHECK (plan_id IN ('trial', 'pro_monthly', 'pro_yearly')),
  valid_until INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  custom_order_id TEXT NOT NULL UNIQUE,
  device_id TEXT NOT NULL REFERENCES devices(id),
  plan_id TEXT NOT NULL CHECK (plan_id IN ('pro_monthly', 'pro_yearly')),
  duration_days INTEGER NOT NULL CHECK (duration_days IN (30, 365)),
  amount_fen INTEGER NOT NULL CHECK (amount_fen > 0),
  status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'expired')),
  poll_token_hash TEXT NOT NULL CHECK (length(poll_token_hash) = 64),
  provider_transaction_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paid_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK ((status = 'paid') = (paid_at IS NOT NULL))
) STRICT;

CREATE TABLE payment_events (
  event_id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE REFERENCES orders(id),
  provider_transaction_id TEXT NOT NULL UNIQUE,
  received_at INTEGER NOT NULL,
  verified_at INTEGER NOT NULL
) STRICT;

CREATE TABLE rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  count INTEGER NOT NULL CHECK (count >= 0),
  expires_at INTEGER NOT NULL
) STRICT;

CREATE INDEX orders_device_id_idx ON orders(device_id, created_at DESC);
CREATE INDEX orders_pending_idx ON orders(status, expires_at);
CREATE INDEX orders_reconcile_idx ON orders(status, created_at);
CREATE INDEX payment_events_received_idx ON payment_events(received_at);
CREATE INDEX rate_limits_expiry_idx ON rate_limits(expires_at);
