#!/usr/bin/env node
// Kitchen board history by hand. The box does this by itself overnight
// (2am-7am, after the kitchen's last pull) for any day since Jan 1 the
// cloud doesn't have; this runs the same thing right now.
//   node tools/spoton-backfill.js                    missing days since Jan 1 (or SPOTON_BACKFILL_FROM)
//   node tools/spoton-backfill.js 2026-06-01         missing days since June 1
//   node tools/spoton-backfill.js 2026-01-01 2026-03-31 --force   redo a range even if stored
// Safe to stop (Ctrl+C) and run again: stored days are skipped.
process.chdir(require('path').join(__dirname, '..'));
require('dotenv').config();
const kitchen = require('../lib/kitchen');

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const force = process.argv.includes('--force');
const ymdOk = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
if (args[0] && !ymdOk(args[0])) { console.log('Usage: node tools/spoton-backfill.js [from YYYY-MM-DD] [to YYYY-MM-DD] [--force]'); process.exit(1); }

kitchen.backfill({ from: args[0] || undefined, to: ymdOk(args[1]) ? args[1] : null, force, log: console.log })
  .then((r) => { console.log(`\nDone: ${r.done} day(s) stored, ${r.failed} failed${r.alreadyStored ? `, ${r.alreadyStored} were already there` : ''}.`); process.exit(0); })
  .catch((err) => { console.error('Failed:', err.message); process.exit(1); });
