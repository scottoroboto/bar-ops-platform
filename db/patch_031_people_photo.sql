-- =====================================================================
-- Patch 031 — optional profile photo on the Apply page (batch 2, item a).
--
-- An applicant can attach a photo of themselves when they apply, so the
-- manager reviewing the pile — and the owner activating — can put a face
-- to the name. It's optional; nothing else about the application changes.
--
-- Storage follows the cash-receipts pattern exactly (patch_024 /
-- server/storage.js): its own PRIVATE bucket, zero storage.objects
-- policies, so the service role key is the only way in or out and a
-- browser only ever sees a short-lived signed URL minted by the server.
-- Kept as a separate bucket rather than a folder in cash-receipts so the
-- two never share a size/mime policy or a blast radius.
--
-- people.photo_path is the object path inside that bucket (`<person
-- id>.<ext>`), never a URL. NULL = no photo.
-- =====================================================================

ALTER TABLE people ADD COLUMN photo_path text;

-- Supabase only: a plain local Postgres has no storage schema, so the
-- bucket insert is skipped there (the column above still applies, and
-- server/storage.js fails soft without SUPABASE_URL anyway).
DO $$
BEGIN
  IF to_regclass('storage.buckets') IS NOT NULL THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'people-photos', 'people-photos', false,
      10485760,                                                   -- 10 MB; phone photos are 2–6 MB, HEIC bigger
      ARRAY['image/jpeg','image/png','image/heic','image/webp']  -- images only; no PDFs, unlike receipts
    );
  END IF;
END $$;
