const express = require('express');
const multer = require('multer');
const { withServiceClient } = require('./db');
const employees = require('./employees');

// ---------------------------------------------------------------------
// Jotform webhook intake for the "Ticket Sports Bar New Hire Information"
// form. This is the real version of what POST /api/employees/pending used
// to simulate manually.
//
// The new-hire form collects a LOT of sensitive stuff (SSN, bank/routing
// numbers, a driver's license upload, W-4 details, date of birth, ...).
// NONE of that is read, logged, or stored here. We only ever pull out the
// handful of fields listed in WANTED below, and everything else in the
// request — including req.body.rawRequest, req.body.pretty in full, and
// any uploaded files multer parses into req.files — is discarded when the
// request finishes. Never console.log(req.body) or req.files in this file.
// ---------------------------------------------------------------------

// Jotform sends this as multipart/form-data whenever the form has a file
// upload question defined (true for this form), even on submissions that
// didn't use it — but falls back to urlencoded for simpler forms/tests.
// Route on content-type rather than assuming one or the other.
const multerAny = multer({ storage: multer.memoryStorage() }).any();
const urlencoded = express.urlencoded({ extended: true });
function parseBody(req, res, next) {
  const ct = req.headers['content-type'] || '';
  if (ct.includes('multipart/form-data')) return multerAny(req, res, next);
  return urlencoded(req, res, next);
}

// The only fields we ever look for. `label` is matched against the start
// of each "Label:value" pair from Jotform's `pretty` summary — case
// insensitive, so small rewordings of the question text on the live form
// don't break this.
const WANTED = [
  { key: 'name', label: 'Full Name' },
  { key: 'email', label: 'E-mail' },
  { key: 'phone', label: 'Phone Number' },
  { key: 'location', label: 'Hired to work at the following locations' },
];

// Jotform's `pretty` field looks like:
//   "Full Name:Jane Doe, E-mail:jane@x.com, Phone Number:555-123-4567, ..."
// Split right before what looks like the next "Label:" pair (not on every
// comma) so commas inside an answer — an address, for instance — don't
// break the split.
function parsePretty(pretty) {
  if (!pretty) return {};
  const parts = String(pretty).split(/,\s+(?=[A-Z][A-Za-z0-9 .'\-]{1,60}:)/);
  const out = {};
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
}

function extractSafeFields(prettyMap) {
  const labels = Object.keys(prettyMap);
  const result = {};
  for (const { key, label } of WANTED) {
    const found = labels.find(l => l.toLowerCase().startsWith(label.toLowerCase()));
    if (found && prettyMap[found]) result[key] = prettyMap[found];
  }
  return result;
}

// The location answer might carry more than one token (a multi-select
// field, or trailing punctuation) — match the first piece that lines up
// with a real location name so a manager doesn't have to fix it by hand.
async function findLocationId(client, locationAnswer) {
  if (!locationAnswer) return null;
  const candidates = String(locationAnswer).split(/[,;]/).map(s => s.trim()).filter(Boolean);
  for (const candidate of candidates) {
    const { rows } = await client.query('SELECT id FROM locations WHERE lower(name) = lower($1) LIMIT 1', [candidate]);
    if (rows[0]) return rows[0].id;
  }
  return null;
}

async function handleWebhook(req, res) {
  try {
    const secret = process.env.JOTFORM_WEBHOOK_SECRET;
    if (secret && req.query.key !== secret) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }

    const submissionId = (req.body && (req.body.submissionID || req.body.submissionId)) || null;
    const prettyMap = parsePretty(req.body && req.body.pretty);
    const safe = extractSafeFields(prettyMap);

    if (!safe.name) {
      // Nothing usable — acknowledge so Jotform doesn't keep retrying, but
      // don't create a garbage pending-review record.
      return res.status(200).json({ ok: true, skipped: true });
    }

    if (submissionId) {
      const alreadyProcessed = await withServiceClient(async (client) => {
        const { rows } = await client.query(
          'SELECT id FROM people WHERE jotform_submission_id = $1 LIMIT 1',
          [submissionId]
        );
        return !!rows[0];
      });
      if (alreadyProcessed) return res.status(200).json({ ok: true, duplicate: true });
    }

    const locationId = await withServiceClient((client) => findLocationId(client, safe.location));

    await employees.createPendingEmployee({
      name: safe.name,
      email: safe.email,
      phone: safe.phone,
      requestedLocationId: locationId,
      jotformSubmissionId: submissionId,
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[jotform webhook] failed:', err.message);
    res.status(500).json({ ok: false });
  }
}

module.exports = { parseBody, handleWebhook };
