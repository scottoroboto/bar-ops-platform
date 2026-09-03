// Embedded MAC-vendor (OUI) table -- docs/venue-control.md §9.1, pass 4
// ("Identify"): "resolve vendor via an embedded OUI table (Samsung, Roku,
// Raspberry Pi Foundation, LG, Vizio, TCL, DirecTV)."
//
// This is deliberately a small, best-effort starter list, not a full IEEE
// OUI database -- and per §9.1's own confidence model, that's fine: OUI
// match alone only ever produces "low" confidence. "High" confidence comes
// from an identity endpoint actually answering (interrogate pass), "medium"
// from a port signature agreeing with OUI. A device this table doesn't
// recognize just falls through to identity-probe-only classification, which
// is the primary signal anyway -- an unmatched OUI never blocks or degrades
// scan/adopt, it just means confidence stays at whatever interrogate found.
//
// Extend this table as real hardware turns up prefixes it misses (a scan's
// "oui_vendor: null" on a device that clearly IS a known TV turns into a
// new row here) -- nothing else in the discovery pipeline needs to change
// when a prefix is added.
//
// Note on DirecTV specifically: H25 receivers are identified reliably by the
// SHEF :8080/info/getVersion probe (interrogate pass), not by OUI -- set-top
// box network hardware is commonly OEM'd, so there's no single trustworthy
// "DirecTV" MAC block to encode here. Left out rather than guessed.
const OUI_TABLE = {
  // Samsung Electronics -- Samsung owns dozens of registered blocks; this
  // is a representative subset commonly seen on consumer Samsung TVs.
  '8C79F5': 'Samsung Electronics',
  '5C0A5B': 'Samsung Electronics',
  'F47B5E': 'Samsung Electronics',
  'D0176A': 'Samsung Electronics',
  'A00798': 'Samsung Electronics',
  '34145F': 'Samsung Electronics',
  'CC6D8A': 'Samsung Electronics',
  'B84B59': 'Samsung Electronics',
  '78BDBC': 'Samsung Electronics',
  '4844F7': 'Samsung Electronics',

  // Roku
  'B0A737': 'Roku',
  'D8311C': 'Roku',
  'CC6D2C': 'Roku',
  'AC3743': 'Roku',
  '88DE7C': 'Roku',

  // Raspberry Pi Foundation -- useful for spotting the agent box itself
  // (or another Pi on the network) during a scan, not a TV vendor.
  'B827EB': 'Raspberry Pi Foundation',
  'DCA632': 'Raspberry Pi Foundation',
  'E45F01': 'Raspberry Pi Foundation',
  '28CDC1': 'Raspberry Pi Foundation',

  // LG Electronics
  'A81986': 'LG Electronics',
  '10683F': 'LG Electronics',
  '3CBDD8': 'LG Electronics',
  '008B4B': 'LG Electronics',

  // Vizio Inc
  '7078B2': 'Vizio Inc',
  'C8695D': 'Vizio Inc',
  '000CE7': 'Vizio Inc',

  // TCL / TTE (TCL-brand smart TVs; some run Roku or Google TV firmware,
  // in which case the interrogate pass may also classify them as Roku)
  '983B16': 'TCL',
  'C0AE55': 'TCL',
};

function normalizeMac(mac) {
  if (!mac) return null;
  return String(mac).toUpperCase().replace(/[^0-9A-F]/g, '');
}

// Returns a vendor name string, or null if the prefix isn't in the table.
function lookupVendor(mac) {
  const clean = normalizeMac(mac);
  if (!clean || clean.length < 6) return null;
  return OUI_TABLE[clean.slice(0, 6)] || null;
}

module.exports = { lookupVendor, OUI_TABLE };
