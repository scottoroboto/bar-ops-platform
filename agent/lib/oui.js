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

  // LG Electronics -- webOS TVs boot with SSAP (3000/3001) closed until the
  // set is fully awake, so the OUI-only fallback is what catches a sleepy
  // LG. E43ED7 came off TV 12 at Ticket 1 (an LJ550M) scanning as
  // "unidentified, WoL only".
  'A81986': 'LG Electronics',
  '10683F': 'LG Electronics',
  '3CBDD8': 'LG Electronics',
  '008B4B': 'LG Electronics',
  'E43ED7': 'LG Electronics',
  '001C62': 'LG Electronics',
  '001E75': 'LG Electronics',
  '0021FB': 'LG Electronics',
  '0025E5': 'LG Electronics',
  '0026E2': 'LG Electronics',
  '10F96F': 'LG Electronics',
  '2021A5': 'LG Electronics',
  '34FCEF': 'LG Electronics',
  '3CCD5D': 'LG Electronics',
  '40B0FA': 'LG Electronics',
  '58A2B5': 'LG Electronics',
  '64899A': 'LG Electronics',
  '6CD68A': 'LG Electronics',
  '70058D': 'LG Electronics',
  '88C9D0': 'LG Electronics',
  '8CE081': 'LG Electronics',
  'A039F7': 'LG Electronics',
  'A8236F': 'LG Electronics',
  'AC0D1B': 'LG Electronics',
  'B81DAA': 'LG Electronics',
  'BCF5AC': 'LG Electronics',
  'C49A02': 'LG Electronics',
  'CC2D8C': 'LG Electronics',
  'CCFA00': 'LG Electronics',
  'D013FD': 'LG Electronics',
  'DC0B34': 'LG Electronics',
  'E892A4': 'LG Electronics',
  'F80CF3': 'LG Electronics',

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
