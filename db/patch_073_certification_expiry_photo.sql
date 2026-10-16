-- patch_073: certification expiry date + photo of the certificate.
-- expires_on   when the cert lapses (shown as "expires / expiring soon /
--              expired" on the employee card).
-- photo_path   object path in the people-photos bucket
--              (<person_id>/certs/<uuid>.<ext>), signed on read like the
--              person photo.
-- photo_check  what the app read off the photo when it was uploaded:
--              { cert_name, holder_name, expires_on, acquired_on,
--                confidence, match: 'match'|'mismatch'|'unreadable'|
--                'no_date', note }.
ALTER TABLE employee_certifications
  ADD COLUMN IF NOT EXISTS expires_on  date,
  ADD COLUMN IF NOT EXISTS photo_path  text,
  ADD COLUMN IF NOT EXISTS photo_check jsonb;
