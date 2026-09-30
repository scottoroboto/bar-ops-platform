// Sunrise / sunset / dawn / dusk for a place and day, computed on the Pi so
// light routines keep running with no internet. Standard solar-position
// math (the same approach as NOAA's calculator and the suncalc library):
// sunrise/sunset at -0.833° (refraction + the sun's radius), dawn/dusk at
// -6° (civil twilight: "actually dark" for signage).
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;

function toJulian(date) { return date.valueOf() / DAY_MS - 0.5 + J1970; }
function fromJulian(j) { return new Date((j + 0.5 - J1970) * DAY_MS); }
function toDays(date) { return toJulian(date) - J2000; }
function declination(l) { return Math.asin(Math.sin(OBLIQUITY) * Math.sin(l)); }
function solarMeanAnomaly(d) { return RAD * (357.5291 + 0.98560028 * d); }
function eclipticLongitude(m) {
  const c = RAD * (1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m));
  return m + c + RAD * 102.9372 + Math.PI;
}
function julianCycle(d, lw) { return Math.round(d - 0.0009 - lw / (2 * Math.PI)); }
function approxTransit(ht, lw, n) { return 0.0009 + (ht + lw) / (2 * Math.PI) + n; }
function solarTransitJ(ds, m, l) { return J2000 + ds + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l); }
function hourAngle(h, phi, dec) {
  return Math.acos((Math.sin(h) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec)));
}

// `date` is any instant on the local day wanted; lat/lng in degrees (west
// negative). Returns Dates: { sunrise, sunset, dawn, dusk, noon }.
function sunTimes(date, lat, lng) {
  const lw = RAD * -lng;
  const phi = RAD * lat;
  // Anchor on local noon so the cycle picks the right day in the Americas.
  const noonish = new Date(date);
  noonish.setHours(12, 0, 0, 0);
  const d = toDays(noonish);
  const n = julianCycle(d, lw);
  const ds = approxTransit(0, lw, n);
  const m = solarMeanAnomaly(ds);
  const l = eclipticLongitude(m);
  const dec = declination(l);
  const jNoon = solarTransitJ(ds, m, l);
  const at = (angleDeg) => {
    const w = hourAngle(angleDeg * RAD, phi, dec);
    const a = approxTransit(w, lw, n);
    const jSet = solarTransitJ(a, m, l);
    return { rise: fromJulian(jNoon - (jSet - jNoon)), set: fromJulian(jSet) };
  };
  const horizon = at(-0.833);
  const civil = at(-6);
  return { sunrise: horizon.rise, sunset: horizon.set, dawn: civil.rise, dusk: civil.set, noon: fromJulian(jNoon) };
}

module.exports = { sunTimes };
