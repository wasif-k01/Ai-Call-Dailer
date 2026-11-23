-- Phase 7: recordings & call history
ALTER TABLE call_recordings ADD COLUMN channels integer;
ALTER TABLE call_recordings ADD COLUMN source text; -- conference | call
CREATE INDEX call_recordings_org_idx ON call_recordings (org_id, created_at DESC);
CREATE INDEX calls_org_to_idx ON calls (org_id, to_number);
