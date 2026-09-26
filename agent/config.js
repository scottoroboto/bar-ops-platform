// Loads .env (see .env.example). Every other file in this app reads its
// settings from here rather than touching process.env directly.
require('dotenv').config();

const CLOUD_URL = (process.env.CLOUD_URL || 'https://bar-ops-platform-52n1.onrender.com').replace(/\/$/, '');
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const ADMIN_PIN = process.env.ADMIN_PIN || '';
const STAFF_PIN = process.env.STAFF_PIN || '';
const SMARTTHINGS_TOKEN = process.env.SMARTTHINGS_TOKEN || '';
// The bar's Dream Machine, for speed tests (lib/unifi-local.js). A local-
// only admin; blank = no speed tests from this box.
const UNIFI_URL = (process.env.UNIFI_URL || '').replace(/\/$/, '');
const UNIFI_USER = process.env.UNIFI_USER || '';
const UNIFI_PASS = process.env.UNIFI_PASS || '';
const UNIFI_SITE = process.env.UNIFI_SITE || 'default';
const SPEEDTEST_EVERY_HOURS = Number(process.env.SPEEDTEST_EVERY_HOURS) || 6;
const PORT = Number(process.env.PORT) || 8088;

if (!AGENT_TOKEN) {
  // Not fatal -- the local status UI still comes up so whoever's setting
  // this box up can see *why* it isn't syncing, rather than a crash with no
  // explanation.
  console.error(
    '[config] AGENT_TOKEN is not set. Generate one from TSB Platform: ' +
    'Venue Control -> Sites card -> "Generate agent token", then put it in .env. ' +
    'The agent will not register with the cloud until this is set.'
  );
}

module.exports = { CLOUD_URL, AGENT_TOKEN, ADMIN_PIN, STAFF_PIN, SMARTTHINGS_TOKEN, PORT, UNIFI_URL, UNIFI_USER, UNIFI_PASS, UNIFI_SITE, SPEEDTEST_EVERY_HOURS };
