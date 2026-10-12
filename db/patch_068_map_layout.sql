-- patch_068: a drawn floor plan per site for the staff Map tab
-- (agent/public/staff_map.html). Items and TV positions are in percent of
-- a 10:7 box: { items: [{id,type,x,y,w,h,text,outer?}], tvs: [{n,x,y,tvId?}] }.
-- Rides down to the Pi inside GET /api/venue/agent/config as site.map.
ALTER TABLE vc_sites ADD COLUMN IF NOT EXISTS map_layout JSONB;
