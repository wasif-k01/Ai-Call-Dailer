-- Phase 6: bulk campaign engine
ALTER TABLE campaigns ADD COLUMN default_country text NOT NULL DEFAULT 'US';
ALTER TABLE campaigns ADD COLUMN stopped_at timestamptz;
ALTER TABLE campaign_contacts ADD COLUMN last_error text;
ALTER TABLE campaign_contacts ADD COLUMN final boolean NOT NULL DEFAULT false; -- no more attempts will be made
ALTER TABLE campaign_contacts ADD COLUMN extra jsonb NOT NULL DEFAULT '{}';     -- other columns from the uploaded file

-- Picking the next contacts to dial must stay fast on large campaigns.
CREATE INDEX campaign_contacts_pick_idx ON campaign_contacts (campaign_id, status, next_attempt_at) WHERE NOT final;
CREATE INDEX calls_campaign_contact_idx ON calls (campaign_contact_id);
CREATE INDEX contacts_org_name_idx ON contacts (org_id, lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'')));
