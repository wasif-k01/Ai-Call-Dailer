-- AI Cloud Calling Platform — initial schema
-- Works on plain PostgreSQL 14+ and on Supabase.
--
-- Security model:
--   * The backend API is the only component that talks to this database (as the
--     table owner), and it scopes every query by org_id.
--   * Row Level Security is ENABLED on every table with NO policies for the
--     Supabase `anon` / `authenticated` roles, so the public Supabase REST API
--     cannot read or write any of this data even if the anon key leaks.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ───────────────────────── Tenancy, users, roles ─────────────────────────
CREATE TABLE organizations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  key          text PRIMARY KEY,
  description  text NOT NULL,
  permissions  text[] NOT NULL DEFAULT '{}'
);

INSERT INTO roles (key, description, permissions) VALUES
  ('owner', 'Full access including billing, integrations and user management',
     ARRAY['*']),
  ('admin', 'Manage integrations, agents, campaigns, numbers and calls',
     ARRAY['integrations:manage','agents:manage','campaigns:manage','numbers:manage','calls:make','calls:view','contacts:manage','usage:view']),
  ('agent', 'Make calls and view call history',
     ARRAY['calls:make','calls:view','contacts:manage']),
  ('viewer', 'Read-only access',
     ARRAY['calls:view','usage:view']);

CREATE TABLE users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email          text NOT NULL,
  password_hash  text NOT NULL,
  full_name      text NOT NULL,
  role           text NOT NULL REFERENCES roles(key),
  is_active      boolean NOT NULL DEFAULT true,
  token_version  integer NOT NULL DEFAULT 0,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_org_idx ON users (org_id);

CREATE TABLE profiles (
  user_id     uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  timezone    text NOT NULL DEFAULT 'UTC',
  phone       text,
  avatar_url  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE org_settings (
  org_id                   uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
  recording_enabled        boolean NOT NULL DEFAULT false,
  transcription_enabled    boolean NOT NULL DEFAULT true,
  max_concurrent_ai_calls  integer NOT NULL DEFAULT 2 CHECK (max_concurrent_ai_calls BETWEEN 1 AND 20),
  monthly_spend_limit_usd  numeric(12,2),
  spend_alert_threshold_pct integer NOT NULL DEFAULT 80 CHECK (spend_alert_threshold_pct BETWEEN 1 AND 100),
  allowed_country_codes    text[] NOT NULL DEFAULT ARRAY['US','CA','GB','AE','PK'],
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- ───────────────────────── Contacts & compliance ─────────────────────────
CREATE TABLE contacts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  first_name      text,
  last_name       text,
  phone_e164      text NOT NULL CHECK (phone_e164 ~ '^\+[1-9][0-9]{6,14}$'),
  email           text,
  company         text,
  tags            text[] NOT NULL DEFAULT '{}',
  consent_status  text NOT NULL DEFAULT 'unknown' CHECK (consent_status IN ('unknown','granted','revoked')),
  consent_source  text,
  consent_at      timestamptz,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone_e164)
);

CREATE TABLE do_not_call_list (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  phone_e164  text NOT NULL,
  reason      text,
  source      text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','opt_out_during_call','import','api')),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, phone_e164)
);

-- ───────────────────────── Integrations & credentials ─────────────────────────
CREATE TABLE integrations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider        text NOT NULL,               -- openai | twilio | supabase | redis | ...
  status          text NOT NULL DEFAULT 'not_connected'
                  CHECK (status IN ('not_connected','testing','connected','error')),
  config          jsonb NOT NULL DEFAULT '{}', -- non-secret settings only
  last_tested_at  timestamptz,
  last_error      text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE TABLE encrypted_credentials (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  key_name        text NOT NULL,               -- e.g. api_key, auth_token
  ciphertext      text NOT NULL,               -- AES-256-GCM
  iv              text NOT NULL,
  auth_tag        text NOT NULL,
  masked          text NOT NULL,               -- e.g. ••••abcd (safe to display)
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, key_name)
);

CREATE TABLE setup_progress (
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  step          text NOT NULL,
  verified_at   timestamptz NOT NULL DEFAULT now(),
  details       jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (org_id, step)
);

-- ───────────────────────── Phone numbers ─────────────────────────
CREATE TABLE phone_numbers (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider       text NOT NULL DEFAULT 'twilio',
  number_type    text NOT NULL CHECK (number_type IN ('provider_owned','verified_caller_id','external','sip_endpoint')),
  e164           text NOT NULL,                -- or SIP URI for sip_endpoint
  friendly_name  text,
  country_iso    text,
  provider_sid   text,                         -- e.g. Twilio PN... / CA... SID
  capabilities   jsonb NOT NULL DEFAULT '{}',  -- {voice:true, sms:true}
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active','unverified','released','error')),
  is_default     boolean NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, e164)
);
CREATE UNIQUE INDEX phone_numbers_one_default ON phone_numbers (org_id) WHERE is_default;

-- ───────────────────────── AI agents ─────────────────────────
CREATE TABLE ai_agents (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                    uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                      text NOT NULL,
  description               text,
  system_instructions       text NOT NULL,
  voice                     text NOT NULL DEFAULT 'marin',
  language                  text NOT NULL DEFAULT 'en',
  speaking_speed            numeric(3,2) NOT NULL DEFAULT 1.00 CHECK (speaking_speed BETWEEN 0.25 AND 1.5),
  conversation_style        text NOT NULL DEFAULT 'friendly',
  greeting_message          text NOT NULL,
  max_call_duration_sec     integer NOT NULL DEFAULT 300 CHECK (max_call_duration_sec BETWEEN 30 AND 3600),
  conversation_rules        text,
  call_ending_instructions  text,
  is_active                 boolean NOT NULL DEFAULT true,
  created_by                uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_agents_org_idx ON ai_agents (org_id);

-- ───────────────────────── Campaigns ─────────────────────────
CREATE TABLE campaigns (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name                  text NOT NULL,
  ai_agent_id           uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  from_number_id        uuid REFERENCES phone_numbers(id) ON DELETE SET NULL,
  instructions          text,
  status                text NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','running','paused','stopped','completed')),
  calling_hours_start   time NOT NULL DEFAULT '09:00',
  calling_hours_end     time NOT NULL DEFAULT '18:00',
  timezone              text NOT NULL DEFAULT 'UTC',
  max_concurrent        integer NOT NULL DEFAULT 1 CHECK (max_concurrent BETWEEN 1 AND 10),
  max_retries           integer NOT NULL DEFAULT 1 CHECK (max_retries BETWEEN 0 AND 5),
  retry_delay_min       integer NOT NULL DEFAULT 30 CHECK (retry_delay_min BETWEEN 5 AND 1440),
  consent_confirmed     boolean NOT NULL DEFAULT false,
  consent_confirmed_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  consent_confirmed_at  timestamptz,
  started_at            timestamptz,
  completed_at          timestamptz,
  created_by            uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaigns_org_idx ON campaigns (org_id, created_at DESC);

CREATE TABLE campaign_contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id      uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id       uuid REFERENCES contacts(id) ON DELETE SET NULL,
  phone_e164       text NOT NULL,
  display_name     text,
  status           text NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','queued','calling','answered','completed','no_answer','busy','failed','opted_out')),
  attempts         integer NOT NULL DEFAULT 0,
  last_attempt_at  timestamptz,
  next_attempt_at  timestamptz,
  last_call_id     uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, phone_e164)
);
CREATE INDEX campaign_contacts_status_idx ON campaign_contacts (campaign_id, status);

CREATE TABLE campaign_logs (
  id           bigserial PRIMARY KEY,
  org_id       uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  campaign_id  uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  level        text NOT NULL DEFAULT 'info' CHECK (level IN ('info','warn','error')),
  message      text NOT NULL,
  data         jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX campaign_logs_campaign_idx ON campaign_logs (campaign_id, created_at DESC);

-- ───────────────────────── Calls ─────────────────────────
CREATE TABLE calls (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id               uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id              uuid REFERENCES users(id) ON DELETE SET NULL,
  direction            text NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  mode                 text NOT NULL CHECK (mode IN ('human','ai')),
  provider             text NOT NULL DEFAULT 'twilio',
  provider_call_sid    text UNIQUE,
  from_number          text NOT NULL,
  to_number            text NOT NULL,
  to_country_iso       text,
  status               text NOT NULL DEFAULT 'initiated'
                       CHECK (status IN ('initiated','queued','ringing','in_progress','completed','busy','no_answer','failed','canceled')),
  ai_agent_id          uuid REFERENCES ai_agents(id) ON DELETE SET NULL,
  campaign_id          uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  campaign_contact_id  uuid REFERENCES campaign_contacts(id) ON DELETE SET NULL,
  started_at           timestamptz NOT NULL DEFAULT now(),
  answered_at          timestamptz,
  ended_at             timestamptz,
  duration_sec         integer,
  recording_enabled    boolean NOT NULL DEFAULT false,
  error_code           text,
  error_message        text,
  estimated_cost_usd   numeric(12,5),
  actual_cost_usd      numeric(12,5),
  idempotency_key      text,
  metadata             jsonb NOT NULL DEFAULT '{}',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);
CREATE INDEX calls_org_started_idx ON calls (org_id, started_at DESC);
CREATE INDEX calls_org_status_idx ON calls (org_id, status);
CREATE INDEX calls_campaign_idx ON calls (campaign_id);

ALTER TABLE campaign_contacts
  ADD CONSTRAINT campaign_contacts_last_call_fk FOREIGN KEY (last_call_id) REFERENCES calls(id) ON DELETE SET NULL;

CREATE TABLE call_events (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  event_type  text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_events_call_idx ON call_events (call_id, created_at);

CREATE TABLE call_recordings (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id                 uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  provider_recording_sid  text UNIQUE,
  duration_sec            integer,
  status                  text NOT NULL DEFAULT 'processing',
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE call_transcripts (
  id          bigserial PRIMARY KEY,
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id     uuid NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  speaker     text NOT NULL CHECK (speaker IN ('ai','caller','agent','system')),
  text        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX call_transcripts_call_idx ON call_transcripts (call_id, id);
CREATE INDEX call_transcripts_search_idx ON call_transcripts USING gin (to_tsvector('simple', text));

-- ───────────────────────── Usage & billing ─────────────────────────
CREATE TABLE usage_records (
  id                  bigserial PRIMARY KEY,
  org_id              uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  call_id             uuid REFERENCES calls(id) ON DELETE SET NULL,
  campaign_id         uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  provider            text NOT NULL,           -- twilio | openai
  category            text NOT NULL,           -- telephony | ai_audio | ai_text
  quantity            numeric(14,4) NOT NULL,
  unit                text NOT NULL,           -- seconds | input_audio_tokens | ...
  estimated_cost_usd  numeric(12,5),
  source              text NOT NULL DEFAULT 'estimate' CHECK (source IN ('estimate','provider')),
  recorded_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_org_idx ON usage_records (org_id, recorded_at DESC);

CREATE TABLE billing_records (
  id            bigserial PRIMARY KEY,
  org_id        uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider      text NOT NULL,
  period_start  date NOT NULL,
  period_end    date NOT NULL,
  category      text NOT NULL,
  amount_usd    numeric(12,5) NOT NULL,
  raw           jsonb NOT NULL DEFAULT '{}',
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider, period_start, period_end, category)
);

-- ───────────────────────── Audit ─────────────────────────
CREATE TABLE audit_logs (
  id           bigserial PRIMARY KEY,
  org_id       uuid REFERENCES organizations(id) ON DELETE CASCADE,
  user_id      uuid REFERENCES users(id) ON DELETE SET NULL,
  action       text NOT NULL,
  entity_type  text,
  entity_id    text,
  ip           text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_org_idx ON audit_logs (org_id, created_at DESC);

-- ───────────────────────── Row Level Security ─────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','roles','users','profiles','org_settings','contacts','do_not_call_list',
    'integrations','encrypted_credentials','setup_progress','phone_numbers','ai_agents',
    'campaigns','campaign_contacts','campaign_logs','calls','call_events','call_recordings',
    'call_transcripts','usage_records','billing_records','audit_logs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
