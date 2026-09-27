-- patch_039 — LG webOS TVs (Scotto, 2026-09-27: "can we add LG TVs to
-- venue control"). New control_method 'lg_webos': the box talks to the
-- set over LG's SSAP WebSocket (port 3001 wss / 3000 ws), pairs once with
-- the TV's on-screen prompt, and keeps the client key in vc_tvs.ws_token,
-- the same slot Samsung's token uses.
ALTER TABLE vc_tvs DROP CONSTRAINT vc_tvs_control_chk;
ALTER TABLE vc_tvs ADD CONSTRAINT vc_tvs_control_chk CHECK (control_method IN
  ('unknown','samsung_ws_token','samsung_ws_plain','samsung_legacy',
   'smartthings','wol_only','none','lg_webos'));
