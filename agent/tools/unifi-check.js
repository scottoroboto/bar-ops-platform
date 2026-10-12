#!/usr/bin/env node
// Read-only look at the bar's UniFi from the Pi, for troubleshooting a
// device the Sonos/DirecTV apps can't find. Uses the same local admin the
// agent uses (UNIFI_URL/UNIFI_USER/UNIFI_PASS in agent/.env). Prints the
// settings that break discovery (multicast/broadcast filtering, client
// isolation, IGMP snooping, mDNS) and the client records for the MACs or
// IPs given. Never prints wifi passwords or the admin login.
//
//   node tools/unifi-check.js                      # networks + wifi settings
//   node tools/unifi-check.js b8:e9:37:98:37:f2 10.1.40.56   # plus these clients
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const unifi = require('../lib/unifi-local');
const site = process.env.UNIFI_SITE || 'default';

async function get(path) {
  const r = await unifi.raw(`/proxy/network/api/s/${site}/${path}`);
  if (r.status !== 200) throw new Error(`${path}: HTTP ${r.status} ${r.text || ''}`.trim());
  return (r.json && r.json.data) || [];
}
const yn = (v) => (v ? 'YES' : 'no');
const pad = (s, n) => String(s == null ? '' : s).padEnd(n);

(async () => {
  if (!unifi.configured()) { console.log('UNIFI_URL/UNIFI_USER/UNIFI_PASS are not set in agent/.env'); process.exit(1); }
  const want = process.argv.slice(2).map((s) => s.toLowerCase());

  const nets = await get('rest/networkconf');
  console.log('\nNETWORKS');
  for (const n of nets.filter((x) => x.purpose !== 'wan')) {
    console.log(`  ${pad(n.name, 18)} vlan ${pad(n.vlan ?? '-', 5)} ${pad(n.ip_subnet || '', 18)} igmp_snooping=${yn(n.igmp_snooping)} mdns=${yn(n.mdns_enabled)} isolation=${yn(n.network_isolation_enabled)} id=${n._id}`);
  }

  const wlans = await get('rest/wlanconf');
  console.log('\nWIFI (settings that stop apps finding devices)');
  for (const w of wlans) {
    const net = nets.find((n) => n._id === w.networkconf_id);
    console.log(`  ${pad(w.name, 18)} enabled=${yn(w.enabled)} network=${pad(net ? net.name : w.networkconf_id, 14)} block_multicast_bcast=${yn(w.bc_filter_enabled)} multicast_enhance=${yn(w.mcastenhance_enabled)} client_isolation=${yn(w.l2_isolation)} proxy_arp=${yn(w.proxy_arp)} bands=${(w.wlan_bands || []).join('/')}`);
  }

  const sta = await get('stat/sta');
  const users = await get('rest/user');
  const devs = await get('stat/device');
  const portName = (c) => {
    if (!c.sw_mac) return c.ap_mac ? `wifi via AP ${c.ap_mac}${c.essid ? ` (${c.essid})` : ''}` : '';
    const d = devs.find((x) => x.mac === c.sw_mac);
    return `${d ? d.name || d.model : c.sw_mac} port ${c.sw_port}`;
  };
  if (want.length) {
    console.log('\nCLIENTS');
    for (const w of want) {
      const live = sta.find((c) => String(c.mac).toLowerCase() === w || c.ip === w);
      const rec = users.find((c) => String(c.mac).toLowerCase() === w || (live && c.mac === live.mac));
      if (!live && !rec) { console.log(`  ${w}: not known to UniFi at all`); continue; }
      const c = live || {};
      const net = nets.find((n) => n._id === (c.network_id || (rec && rec.network_id)));
      console.log(`  ${w}`);
      console.log(`    name=${(rec && (rec.name || rec.hostname)) || c.hostname || '-'}  mac=${(live || rec).mac}  ip=${c.ip || (rec && rec.fixed_ip) || '-'}  network=${net ? `${net.name} (vlan ${net.vlan ?? '-'})` : '-'}`);
      console.log(`    online=${yn(!!live)}  ${live ? portName(c) : ''}  last_seen=${c.last_seen ? new Date(c.last_seen * 1000).toLocaleString() : (rec && rec.last_seen ? new Date(rec.last_seen * 1000).toLocaleString() : '-')}`);
      console.log(`    blocked=${yn(rec && rec.blocked)}  fixed_ip=${rec && rec.use_fixedip ? rec.fixed_ip : 'no'}  noted=${(rec && rec.note) || ''}`);
    }
  }

  let rules = [];
  try { rules = await get('rest/firewallrule'); } catch (e) { /* zone-based firewall hides these */ }
  const avIds = new Set(nets.filter((n) => /av|tv|media|sonos|40/i.test(`${n.name} ${n.vlan}`)).map((n) => n._id));
  const hits = rules.filter((r) => r.enabled && (r.src_networkconf_id && avIds.has(r.src_networkconf_id) || r.dst_networkconf_id && avIds.has(r.dst_networkconf_id) || /sonos|b8:e9:37/i.test(JSON.stringify(r))));
  if (hits.length) {
    console.log('\nFIREWALL RULES touching the AV network');
    for (const r of hits) console.log(`  ${pad(r.ruleset, 10)} ${pad(r.action, 7)} ${r.name}`);
  }
  console.log('');
})().catch((e) => { console.error('unifi-check:', e.message); process.exit(1); });
