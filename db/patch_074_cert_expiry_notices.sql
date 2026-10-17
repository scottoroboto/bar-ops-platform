-- patch_074: certification expiry countdown + manager status rule.
-- One row per (certification, step) so the daily sweep can run as often
-- as it likes and still send each notice exactly once. days_out is the
-- step the notice was for: 30, 20, 10, 5, 4, 3, 2, 1, and 0 = expired.
CREATE TABLE IF NOT EXISTS cert_expiry_notices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  certification_id uuid NOT NULL REFERENCES employee_certifications(id) ON DELETE CASCADE,
  person_id        uuid NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  days_out         int  NOT NULL,
  days_left        int  NOT NULL,
  recipients       jsonb,
  sent_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (certification_id, days_out)
);
ALTER TABLE cert_expiry_notices ENABLE ROW LEVEL SECURITY;

-- A manager whose certification lapses drops to staff until a current
-- certificate is on file. These remember what to put back.
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS role_before_cert_lapse text,
  ADD COLUMN IF NOT EXISTS role_lapsed_cert_id    uuid,
  ADD COLUMN IF NOT EXISTS role_lapsed_at         timestamptz;

-- Certificates may be a full page or a PDF, not just a wallet card.
UPDATE storage.buckets
   SET allowed_mime_types = ARRAY['image/jpeg','image/png','image/heic','image/webp','application/pdf']
 WHERE id = 'people-photos';
