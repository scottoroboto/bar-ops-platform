-- patch_067: text-message consent (Oct 2026). US carriers (A2P 10DLC)
-- require a record of how each person agreed to receive texts. A person
-- opts in on Systems Monitoring -> My alert settings by picking Text and
-- ticking the consent box; we keep when and at which number.
ALTER TABLE monitoring_notify_settings ADD COLUMN IF NOT EXISTS sms_consent_at timestamptz;
ALTER TABLE monitoring_notify_settings ADD COLUMN IF NOT EXISTS sms_consent_phone text;
