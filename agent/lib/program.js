// What's on a DirecTV channel now and what comes next (Oct 2026).
//
// The staff pages ask /api/sources/:slot/proginfo every 15 s per receiver.
// The receiver's guide answer carries the program's start and length, so
// the answer is good until that program ends; we keep it that long and,
// once per program, ask the same guide what starts when this one ends.
// That is the "NEXT 7:30p · ..." line on the source cards and the TVs
// rail. Cached per receiver and channel, so sixteen receivers tuned to
// the same game cost one lookup each per program, not one per refresh.
const directv = require('./drivers/directv');

const cache = new Map(); // `${ip}|${major}.${minor}` -> { info, next, end (ms), fetchedAt }
const MAX_AGE_MS = 10 * 60 * 1000; // re-ask at least this often even mid-program (titles change at tip-off)
const NO_END_TTL_MS = 60 * 1000;   // a guide answer with no start/duration: keep a minute

function endOf(info) {
  const start = Number(info && info.startTime);
  const dur = Number(info && info.duration);
  if (!Number.isFinite(start) || !Number.isFinite(dur) || start <= 0 || dur <= 0) return null;
  return (start + dur) * 1000;
}

function trimNext(p) {
  if (!p || p.isOffAir) return null;
  return { title: p.title || '', episodeTitle: p.episodeTitle || '', callsign: p.callsign || null, startTime: Number(p.startTime) || null, duration: Number(p.duration) || null };
}

async function withNext(ip, port, major, minor, now = Date.now(), driver = directv) {
  const key = `${ip}|${major}.${minor == null ? '' : minor}`;
  const hit = cache.get(key);
  if (hit && now - hit.fetchedAt < MAX_AGE_MS && (hit.end ? now < hit.end : now - hit.fetchedAt < NO_END_TTL_MS)) {
    return { ...hit.info, next: hit.next };
  }
  const info = await driver.getProgInfo(ip, port, major, minor);
  const end = endOf(info);
  let next = null;
  if (end) {
    try { next = trimNext(await driver.getProgInfo(ip, port, major, minor, end / 1000 + 60)); } catch (e) { next = null; }
  }
  if (cache.size > 200) cache.clear();
  cache.set(key, { info, next, end, fetchedAt: now });
  return { ...info, next };
}

function reset() { cache.clear(); }

module.exports = { withNext, reset, endOf };
