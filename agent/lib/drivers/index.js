// One place that answers "which driver talks to this TV?" so the routes in
// agent/server.js don't grow a vendor branch per feature. Samsung stays the
// default for every method it always handled (including SmartThings-only
// and WoL-only sets, which its setPower/setMute already route); LG gets
// its own module (cloud patch_039).
const samsungWs = require('./samsung-ws');
const lgWebos = require('./lg-webos');

function driverFor(tv) {
  return tv && tv.control_method === 'lg_webos' ? lgWebos : samsungWs;
}

// Methods a remote key press can reach (the bulk/key route's filter).
const KEY_METHODS = new Set(['samsung_ws_token', 'samsung_ws_plain', 'lg_webos']);

module.exports = { driverFor, KEY_METHODS, samsungWs, lgWebos };
