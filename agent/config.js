// Loads .env (see .env.example). Every other file in this app reads its
// settings from here rather than touching process.env directly.
require('dotenv').config();

const CLOUD_URL = (process.env.CLOUD_URL || 'https://bar-ops-platform-52n1.onrender.com').replace(/\/$/, '');
const AGENT_TOKEN = process.env.AGENT_TOKEN || '';
const ADMIN_PIN = process.env.ADMIN_PIN || '';
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

module.exports = { CLOUD_URL, AGENT_TOKEN, ADMIN_PIN, PORT };
