// Reads a photo of an employee's certification card (ServSafe, TIPS,
// food handler, manager cert…) and reports what it says so the app can
// confirm the expiration date the owner typed in. Same shape as the
// amusement photo readers: fails soft — any API/network problem comes
// back as { match: 'unreadable' } and the cert is still saved.
// Needs ANTHROPIC_API_KEY (same key the amusement scale reader uses).
let anthropicClient = null;
function getAnthropic() {
  if (anthropicClient) return anthropicClient;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return anthropicClient;
}

function configured() { return !!process.env.ANTHROPIC_API_KEY; }

const SCHEMA = {
  type: 'object',
  properties: {
    is_certificate: { type: 'boolean', description: 'True if the photo shows a certification card or certificate.' },
    cert_name: { type: ['string', 'null'], description: 'The certification as printed, e.g. "ServSafe Food Handler".' },
    holder_name: { type: ['string', 'null'], description: 'The person the certificate was issued to.' },
    issued_on: { type: ['string', 'null'], description: 'Issue / completion date as YYYY-MM-DD, or null if not shown.' },
    expires_on: { type: ['string', 'null'], description: 'Expiration date as YYYY-MM-DD, or null if not shown.' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    note: { type: 'string', description: 'One short sentence on anything unclear (blurry, cut off, date partly hidden). Empty if fine.' },
  },
  required: ['is_certificate', 'cert_name', 'holder_name', 'issued_on', 'expires_on', 'confidence', 'note'],
  additionalProperties: false,
};

const PROMPT = `This image or document was uploaded as proof of an employee's certification (for example a ServSafe, TIPS, food handler or food manager credential). It may be a wallet card, a full-page certificate, or a scan/PDF of either; it may be rotated or photographed at an angle.
Read what is printed on it. Report the certification name, the holder's name, the issue or completion date and the expiration date exactly as printed, converted to YYYY-MM-DD. If the certificate only states a validity period (e.g. "valid for 5 years") with no explicit expiration date, leave expires_on null and say so in the note. Never guess a date that is not on the card. If the photo is not a certificate at all, set is_certificate to false.`;

// ISO date helpers — Postgres hands dates back as JS Date objects; the
// form posts YYYY-MM-DD strings. Normalise both to YYYY-MM-DD.
function isoDay(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

function fmtUs(iso) {
  const d = isoDay(iso);
  if (!d) return '';
  const [y, m, day] = d.split('-');
  return `${Number(m)}/${Number(day)}/${y}`;
}

// Compare what was read to what was typed. `entered` may be null (owner
// left expires blank) — then the photo's date is offered as the answer.
function compare(read, entered) {
  const typed = isoDay(entered);
  const seen = isoDay(read.expires_on);
  if (!read.is_certificate) return { match: 'unreadable', summary: 'That photo does not look like a certificate.' };
  if (!seen) return { match: 'no_date', summary: `Photo read: ${read.cert_name || 'certificate'}${read.holder_name ? ` for ${read.holder_name}` : ''} — no expiration date visible${read.note ? ` (${read.note})` : ''}.` };
  if (!typed) return { match: 'filled', summary: `Expires ${fmtUs(seen)} — taken from the photo${read.confidence !== 'high' ? ` (${read.confidence} confidence, please double-check)` : ''}.` };
  if (typed === seen) return { match: 'match', summary: `Photo confirms expires ${fmtUs(seen)}.` };
  return { match: 'mismatch', summary: `Photo says expires ${fmtUs(seen)}, but ${fmtUs(typed)} was entered.` };
}

async function readCertPhoto({ buffer, mimetype, enteredExpiresOn, enteredName }) {
  const client = getAnthropic();
  if (!client) return { match: 'unreadable', summary: 'Photo saved. Automatic review is off — ANTHROPIC_API_KEY is not set on the server.', skipped: true };
  // The reader takes JPEG/PNG/WebP/GIF images and PDFs. HEIC (an iPhone
  // photo picked from the library in its original format) is stored but
  // can't be reviewed; most phones hand the browser a JPEG, so this is rare.
  if (mimetype === 'image/heic') return { match: 'unreadable', summary: 'Photo saved. HEIC photos can\'t be reviewed automatically — check the date against the card yourself, or retake it with the camera.' };
  const filePart = mimetype === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } }
    : { type: 'image', source: { type: 'base64', media_type: mimetype, data: buffer.toString('base64') } };
  try {
    const response = await client.messages.create({
      model: 'claude-opus-5-5',
      max_tokens: 400,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{
        role: 'user',
        content: [
          filePart,
          { type: 'text', text: PROMPT + (enteredName ? `\nThe owner filed this as "${enteredName}".` : '') },
        ],
      }],
    });
    if (response.stop_reason === 'refusal') return { match: 'unreadable', summary: 'The photo could not be reviewed.' };
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return { match: 'unreadable', summary: 'The photo could not be read.' };
    const read = JSON.parse(m[0]);
    const result = compare(read, enteredExpiresOn);
    return {
      ...result,
      cert_name: read.cert_name || null,
      holder_name: read.holder_name || null,
      issued_on: isoDay(read.issued_on),
      expires_on: isoDay(read.expires_on),
      confidence: read.confidence || 'medium',
      note: read.note || '',
      checked_at: new Date().toISOString(),
    };
  } catch (e) {
    console.error('[certread] photo review failed', e.message);
    return { match: 'unreadable', summary: 'Photo saved, but the automatic review failed. Check the date against the card yourself.' };
  }
}

module.exports = { readCertPhoto, configured, _test: { compare, isoDay, fmtUs } };
