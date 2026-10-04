// Pandora account link (Scotto, 2026-10-04): the bar's Pandora stations
// straight from the account, so the staff Music page lists every station
// without anyone saving them to My Sonos first, and "+ Add station" can
// search Pandora and make a new one. The Sonos still does the playing
// (lib/sonos.js playPandoraStation); this file only talks to Pandora.
//
// Uses the same JSON API pandora.com's own web player calls (/api/v1,
// /api/v3). It isn't a published API: if Pandora changes it, the list
// falls back to My Sonos favorites and "Add station" reports the error.
// PANDORA_USER / PANDORA_PASS in agent/.env; one Pandora account per bar,
// since Pandora streams one account to one place at a time.
const crypto = require('crypto');
const config = require('../config');
const cache = require('./cache');

const BASE = process.env.PANDORA_BASE || 'https://www.pandora.com'; // override only for tests
const TIMEOUT_MS = 12000;
const REFRESH_MS = 10 * 60 * 1000;
const ART_CDN = 'https://content-images.p-cdn.com/';

let auth = null;                                  // { token, csrf }
let stations = cache.get('pandoraStations') || []; // last good list, kept through restarts
let stationsAt = 0;
let lastError = null;
let timer = null;

function enabled() { return !!(config.PANDORA_USER && config.PANDORA_PASS); }

function artUrl(a) {
  if (!a) return null;
  const url = typeof a === 'string' ? a : a.url || a.artUrl || null;
  if (!url) return null;
  return /^https?:\/\//.test(url) ? url : ART_CDN + url.replace(/^\//, '');
}

// Biggest picture from Pandora's art list ([{ url, size }]), or a lone url.
function pickArt(obj) {
  if (!obj) return null;
  const list = Array.isArray(obj.art) ? obj.art : null;
  if (list && list.length) {
    const best = list.slice().sort((x, y) => (Number(y.size) || 0) - (Number(x.size) || 0))[0];
    return artUrl(best);
  }
  return artUrl(obj.artUrl || (obj.icon && (obj.icon.artUrl || obj.icon.url)) || obj.thorId || null);
}

function friendlyError(data, status) {
  const code = data && (data.errorCode || data.errorString || data.code);
  const msg = data && (data.message || data.errorString);
  if (/AUTH_INVALID_USERNAME_PASSWORD|INVALID_USERNAME|INVALID_PASSWORD/i.test(String(code) + String(msg))) return 'Pandora says the email or password is wrong (PANDORA_USER / PANDORA_PASS on this box).';
  if (status === 429) return 'Pandora is asking us to slow down. Try again in a few minutes.';
  if (/LISTENER_NOT_AUTHORIZED|AUTH_REQUIRED|INVALID_AUTH_TOKEN|AUTH_INVALID_TOKEN/i.test(String(code) + String(msg))) return 'AUTH_EXPIRED';
  return `Pandora: ${msg || code || `HTTP ${status}`}`;
}

async function post(path, body, token) {
  if (!auth) auth = { csrf: crypto.randomBytes(16).toString('hex'), token: null };
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-CsrfToken': auth.csrf,
        Cookie: `csrftoken=${auth.csrf}`,
        ...(token ? { 'X-AuthToken': token } : {}),
        'User-Agent': 'Mozilla/5.0 (Bar Ops venue agent)',
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.errorCode)) throw Object.assign(new Error(friendlyError(data, res.status)), { status: res.status, data });
    return data;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Pandora didn’t answer (no internet at the bar?).');
    throw err;
  } finally {
    clearTimeout(t);
  }
}

async function login() {
  if (!enabled()) throw new Error('No Pandora account on this box (PANDORA_USER / PANDORA_PASS in agent/.env).');
  auth = { csrf: crypto.randomBytes(16).toString('hex'), token: null };
  const data = await post('/api/v1/auth/login', {
    username: config.PANDORA_USER, password: config.PANDORA_PASS, keepLoggedIn: true, existingAuthToken: null,
  });
  if (!data.authToken) throw new Error('Pandora signed in but sent no session. Its website may have changed.');
  auth.token = data.authToken;
  return data;
}

// Every call after login; signs in again once if the session expired.
async function call(path, body) {
  if (!auth || !auth.token) await login();
  try {
    return await post(path, body, auth.token);
  } catch (err) {
    if (err.message !== 'AUTH_EXPIRED' && err.status !== 401) throw err;
    await login();
    return post(path, body, auth.token);
  }
}

function isShuffle(s) {
  return !!(s.isShuffle || s.isQuickMix || s.quickMix || /^shuffle$/i.test(String(s.name || '').trim()) || /shuffle|quickmix/i.test(String(s.stationType || s.type || '')));
}

// The account's stations: [{ stationId, name, art }], Shuffle left out.
async function fetchStations() {
  const out = [];
  for (let start = 0; start < 2000;) {
    const data = await call('/api/v1/station/getStations', { pageSize: 250, startIndex: start });
    const page = Array.isArray(data.stations) ? data.stations : [];
    for (const s of page) {
      const id = String(s.stationId || s.id || '').replace(/^ST:/i, '');
      if (!id || isShuffle(s)) continue;
      out.push({ stationId: id, name: String(s.name || s.stationName || 'Station'), art: pickArt(s) });
    }
    start += page.length;
    const total = Number(data.totalStations || data.total || 0);
    if (!page.length || !total || start >= total) break;
  }
  return out;
}

async function refresh() {
  if (!enabled()) return stations;
  try {
    const list = await fetchStations();
    stations = list;
    stationsAt = Date.now();
    lastError = null;
    cache.set('pandoraStations', list);
  } catch (err) {
    lastError = err.message;
    console.warn('[pandora] station list:', err.message);
  }
  return stations;
}

// Search artists, songs and genres for "+ Add station".
async function search(query) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  // Artists, songs and genre stations ("SF", station factories). Pandora
  // rejects a type it doesn't know with a -32000 assert, so fall back to
  // just artists and songs if the genre type is ever refused.
  let data;
  for (const types of [['AR', 'TR', 'SF'], ['AR', 'TR']]) {
    try {
      data = await call('/api/v3/sod/search', {
        query: q, types, listener: null, start: 0, count: 20,
        annotate: true, searchTime: 0, annotationRecipe: 'CLASS_OF_2019',
      });
      break;
    } catch (err) {
      if (!/-32000|Assert failed/.test(err.message) || types.length === 2) throw err;
    }
  }
  const ids = Array.isArray(data.results) ? data.results : [];
  const notes = data.annotations || {};
  return ids.map((id) => {
    const a = notes[id] || {};
    const type = String(a.type || id.split(':')[0] || '');
    const kind = type === 'AR' ? 'Artist' : type === 'TR' ? 'Song' : type === 'SF' ? 'Genre' : 'Music';
    const sub = type === 'TR' ? [a.artistName, a.albumName].filter(Boolean).join(' · ') : '';
    return { pandoraId: id, kind, name: String(a.name || a.title || id), sub, art: pickArt(a) };
  }).filter((r) => r.name);
}

// Make a station from a search result. Returns { stationId, name, art }.
async function createStation(pandoraId) {
  const id = String(pandoraId || '').trim();
  if (!/^[A-Z]{2}:[\w:-]+$/i.test(id)) throw new Error('Pick something from the search results.');
  const data = await call('/api/v1/station/createStation', { pandoraId: id, stationCode: '', stationName: '' });
  const s = data.station || data;
  const stationId = String(s.stationId || s.id || '').replace(/^ST:/i, '');
  if (!stationId) throw new Error('Pandora made the station but didn’t say which one. It’ll show up in the list within 10 minutes.');
  const st = { stationId, name: String(s.name || s.stationName || 'New station'), art: pickArt(s) };
  if (!stations.some((x) => x.stationId === stationId)) { stations = [...stations, st]; cache.set('pandoraStations', stations); }
  refresh().catch(() => {});
  return st;
}

function getStations() { return stations; }
function stationById(id) { return stations.find((s) => s.stationId === String(id).replace(/^ST:/i, '')) || null; }
function status() { return { enabled: enabled(), ok: enabled() && !lastError, error: lastError, count: stations.length, refreshedAt: stationsAt ? new Date(stationsAt).toISOString() : null }; }

function start() {
  if (timer || !enabled()) return;
  refresh();
  timer = setInterval(refresh, REFRESH_MS);
  console.log('[pandora] linked to the bar’s Pandora account');
}

module.exports = { enabled, start, refresh, login, fetchStations, search, createStation, getStations, stationById, status };
