# Venue Control agent — setup checklist

This is the on-site piece of Venue Control (the "TV" app). It runs on one
always-on box at the bar — not on Render, not in the cloud — and talks
directly to the DirecTV receivers on the headend. What it can do now: prove
this box and TSB Platform can find each other and stay in sync (Phase 0),
scan its own network to find and catalog what's out there (Phase 1,
Discovery & Diagnostics — see step 8 below), and actually change channels
on the receivers (Phase 2, Source control — see step 9 below). TV power/
selection and whole-room layouts are still ahead. See
`docs/venue-control.md` in the main repo for the full plan.

## 1. Pick the box

Needs to be something that's on 24/7 and can run Node.js. Any of these work:

- The cornhole scoreboard Pi, if there's room on it
- A small fanless mini PC (~$130, search "N100 mini PC")
- A NAS that can run Docker/Node
- An old laptop with the lid closed and sleep disabled

**Not** the Windows 7 rack PC — too old for current Node.js.

This does not need to be decided perfectly up front. If the box you pick
later turns out to be wrong, replacing it is quick (see "Replacing the
box" below) because nothing important lives only on this machine.

## 2. Install Node.js

Node 18 or newer. On the box itself:

```
node --version
```

If that's missing or shows something older than 18, install from
https://nodejs.org (pick the LTS version) or via your OS's package manager.

## 3. Get this folder onto the box

Copy the whole `agent/` folder (this one) onto the box, any way that's
convenient — a USB drive, `git clone` of the repo, `scp`, etc.

## 4. Generate an agent token

On any browser, log into TSB Platform as owner and open **Venue Control**.
In the **Sites** card, find this location and click **Generate agent
token**. Copy the token shown — it's shown exactly once and won't be
displayed again (regenerating it later invalidates the old one).

## 5. Configure the agent

On the box, inside the `agent/` folder:

```
cp .env.example .env
```

Open `.env` in a text editor and paste the token in as `AGENT_TOKEN`.
Leave `CLOUD_URL` as-is unless TSB Platform's own address ever changes.
Also pick two PINs: `ADMIN_PIN` protects the Discovery & Diagnostics scan
(step 8 below) from anyone else on the bar's network, and `STAFF_PIN`
protects the day-to-day Sources tab (step 9 below) that actually changes
channels. Leaving either blank leaves that page unprotected — an admin PIN
also works on the staff-gated routes, but a staff PIN does not unlock the
admin ones.

## 6. Install and run

```
npm install
npm start
```

You should see something like:

```
[server] Venue Control agent listening on :8088
[sync] registered as agent #1 for Ticket 3
[sync] config updated for Ticket 3
```

## 7. Confirm it worked

- On the box itself (or another device on the same LAN), open
  `http://<the box's LAN IP>:8088` — it should show "Cloud sync: connected"
  and this location's name.
- Back in TSB Platform's Sites card, this location's **Agent** line should
  flip from "not registered yet" to "online" within about 30 seconds.

If both of those show green, Phase 0 is proven end to end — the box is
reachable, the cloud can see it, and they're staying in sync.

## 8. Run Discovery & Diagnostics (Phase 1)

This is the network scan that finds the DirecTV receivers and TVs and
figures out how each one can be controlled. It's read-only — nothing is
powered on/off, nothing is tuned, nothing changes — until you deliberately
run one of the "Test" actions marked disruptive, and even those require a
confirmation click.

1. On the box (or any device on the same LAN), open
   `http://<the box's LAN IP>:8088/discovery.html`.
2. Enter the admin PIN from step 5.
3. Click **Scan now**. Leave the ranges box blank to scan whatever subnet(s)
   this location is configured with, or type one or more CIDR ranges (e.g.
   `192.168.1.0/24`) separated by commas — useful for checking whether the
   TVs actually sit on a separate network from the receivers. A full /24
   can take up to about a minute.
4. Each device that answers shows its IP, MAC, guessed vendor, open ports,
   and a classification with a confidence level (high/medium/low — high
   means it definitively identified itself, low means only a MAC-vendor
   guess). This is normal to run more than once; nothing is remembered as
   "real" until you adopt it.
5. Use **Test** on a row to double-check a specific device before adopting
   it — `identity` and `power_state` are safe/read-only, `wol` sends an
   actual wake packet, and the rest (`round_trip`, `pair`, `power_cycle`,
   `channel`) aren't built yet (they need the DirecTV/Samsung drivers that
   land in Phase 2/3/6) and will just say so.
6. Once you've confirmed a device is what you think it is, click **Adopt**,
   fill in a real name/zone/slot, and submit. It's now a real row in TSB
   Platform — same data a later phase's Sources/TVs admin pages will manage.
7. If **Scan now** or an adopt ever shows "not synced", the box had no
   internet at that moment — the scan result is still saved locally; click
   **Retry sync** once the connection's back, then adopt from it.

## 9. Change channels (Phase 2)

Once at least one receiver has been added as a source — either adopted from
a Discovery scan (step 8) or added directly in TSB Platform under **Venue
Control → Sources** for this location — the box can actually tune it.

1. On the box (or any device on the same LAN), open
   `http://<the box's LAN IP>:8088/sources.html`.
2. Enter the staff PIN from step 5 (an admin PIN also works here).
3. Each receiver shows what it's currently tuned to — the agent polls every
   15 seconds in the background, so this stays current without reloading.
   "not polled yet" just means the first poll hasn't landed yet (within
   15s of startup); "unreachable" means the receiver didn't answer the last
   poll — check it's powered on and still has the IP address on file.
4. Type a channel (e.g. `206` or a satellite channel like `206.1`) into a
   receiver's box and click **Go**, or use **Guide**/**Info** to send those
   remote buttons instead.
5. If any favorites are set up (TSB Platform → Venue Control → Favorites),
   they show as buttons above the receiver list — click one, pick which
   receiver(s) to send it to, and it tunes all of them in parallel.

Nothing here needs the internet once the config has synced at least once —
tuning talks straight from this box to the receivers on the LAN.

## Keeping it running

For a real deployment (not just this first test), the agent should restart
automatically if it crashes or the box reboots — use `pm2` or a `systemd`
service. Not required just to prove things work the first time; worth
setting up before this becomes something staff actually rely on.

```
npm install -g pm2
pm2 start server.js --name venue-control-agent
pm2 save
pm2 startup     # follow the printed instructions to survive a reboot
```

## Replacing the box

If this box ever dies: install Node on the replacement, copy this same
`agent/` folder over, put the *same* `.env` (same `AGENT_TOKEN`) on it, and
`npm start`. Everything it needs lives in TSB Platform's database, not on
this machine, so a fresh box picks up right where the old one left off —
no re-entering device info once later phases add that. If you don't still
have the old `.env`, generate a new token from the Sites card instead; the
old one stops working the moment you do.
