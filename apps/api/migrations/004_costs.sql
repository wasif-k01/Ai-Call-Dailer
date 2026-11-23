-- Phase 8: cost tracking, spending limits
ALTER TABLE calls ADD COLUMN telephony_cost_usd numeric(12,5);   -- billed by Twilio (actual)
ALTER TABLE calls ADD COLUMN ai_cost_usd numeric(12,5);          -- OpenAI, estimated from token usage
ALTER TABLE calls ADD COLUMN cost_status text NOT NULL DEFAULT 'pending'
  CHECK (cost_status IN ('pending','final','partial','unavailable'));
CREATE INDEX calls_org_cost_idx ON calls (org_id, cost_status) WHERE cost_status <> 'final';

ALTER TABLE org_settings ADD COLUMN spend_limit_action text NOT NULL DEFAULT 'alert'
  CHECK (spend_limit_action IN ('alert','block'));

-- Owner-editable price overrides (defaults live in code with their source and date).
CREATE TABLE pricing_overrides (
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  key         text NOT NULL,
  usd_per_unit numeric(14,6) NOT NULL CHECK (usd_per_unit >= 0),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, key)
);

-- One alert per org, month and level, so nobody gets spammed.
CREATE TABLE spend_alerts (
  org_id   uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  month    date NOT NULL,
  level    text NOT NULL CHECK (level IN ('threshold','limit')),
  spent_usd numeric(12,5) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, month, level)
);

ALTER TABLE pricing_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE spend_alerts ENABLE ROW LEVEL SECURITY;
