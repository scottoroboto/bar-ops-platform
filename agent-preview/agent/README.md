# Venue Control agent — setup checklist

This is the on-site piece of Venue Control (the "TV" app). It runs on one
always-on box at the bar — not on Render, not in the cloud — and talks
directly to the DirecTV receivers on the headend. What it can do now: prove
this box and TSB Platform can find each other and stay in sync (Phase 0),
scan its own network to find and catalog what's out there (Phase 1,
Discovery & Diagnostics — see step 8 below), actually change channels on
the receivers (Phase 2, Source control — see step 9 below), and turn TVs on
and off with real state verification, including scheduled on/off times
(Phase 3, TV power — see step 10 below). TV source (channel) selection and
whole-room layouts are still ahead. See `docs/venue-control.md` in the main
repo for the full plan.

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

## 10. Turn TVs on and off (Phase 3)

Once at least one TV has been added — either adopted from a Discovery scan
(step 8) or added directly in TSB Platform under **Venue Control → TVs** for
this location, with a `control_method` set (`samsung_ws_token`,
`samsung_ws_plain`, or `smartthings`) — the box can power it on/off with a
real read-verify-report cycle, not a blind toggle.

1. On the box (or any device on the same LAN), open
   `http://<the box's LAN IP>:8088/tvs.html`.
2. Enter the staff PIN from step 5 (an admin PIN also works here).
3. TVs are grouped by zone (set in TSB Platform → Venue Control → Zones).
   Each shows its last-polled power state — the agent polls every 20
   seconds in the background. **On**/**Off** send a real command and
   immediately re-check the TV before reporting back, so "all on" never
   silently leaves one off. **Vol −**/**Vol +**/**Mute** work the same way
   where the TV's control method supports it.
4. **Zone on**/**Zone off** at the top of each group, or **All on**/**All
   off** at the very top, fan out to every TV in that scope at once (four
   at a time, per `docs/venue-control.md` §7.2, so ~50 TVs don't all try to
   open a connection in the same instant).
5. **First-time pairing**: a `samsung_ws_token` TV shows an "Allow this
   device?" prompt on its own screen the first time the agent talks to it —
   someone needs to be there to accept it once. After that, the agent
   remembers the token (pushed back to TSB Platform automatically) and
   never needs the prompt again unless the TV is factory-reset.
6. **Schedules** (TSB Platform → Venue Control → Schedules) fire
   automatically in this location's own timezone — no one needs to be
   looking at this page for "all TVs on at 10:45, all off at 1:30 AM" to
   happen. `source_tune` schedules (retuning receivers on a timer) work the
   same way. Whole-room layout schedules aren't built yet (Phase 5) — a
   schedule pointed at one just logs that and does nothing.
7. A TV with no `control_method` set yet, or set to `unknown`/`none`, shows
   up in the list but with no power buttons — same "visible but not
   controllable yet" treatment non-DirecTV sources get on the Sources tab.

SmartThings is an optional fallback, not required — see `.env.example`'s
`SMARTTHINGS_TOKEN` comment. Without it, power/volume still work over each
TV's local WS connection; SmartThings just isn't there as a second attempt
if that fails or before pairing has happened.

## 11. Change what source a TV is showing (Phase 4)

Once a TV has real `slot`/`qam_channel` data behind it — meaning at least one
source exists in **Venue Control → Sources** — the box can point the TV's
own built-in cable tuner at any of them, the same way someone would type a
channel number on the physical remote.

1. This only shows up for a TV marked **Channel capable** in TSB Platform →
   Venue Control → TVs. That flag starts off for every TV (it's not guessed
   from the control method or set automatically by Discovery) because this
   is genuinely unverified: unlike power, there's no way for the agent to
   read back what a Samsung TV's tuner actually landed on. Try it once with
   the TV in view, confirm the channel actually changed, then turn the flag
   on for that TV.
2. The TV also needs to already be sitting on its Cable/Antenna input with
   the QAM channel list programmed — exactly the state it's in today for
   staff using the physical remote. This doesn't switch inputs; it only
   types a channel number into the tuner that's already showing.
3. On `http://<the box's LAN IP>:8088/tvs.html`, a channel-capable TV shows
   a **Source** line under its power controls with a **Change source**
   button. Tapping it opens every configured source (the same 16 slots the
   Sources tab manages); tapping one sends the channel as key presses —
   `KEY_1`, `KEY_2`, `KEY_MINUS`, `KEY_1`, `KEY_ENTER` for `12.1`, exactly as
   the remote would — with a short pause between each key.
4. The source line shown is the **last one this box actually told the TV to
   go to**, not a live read — the agent has no way to ask the TV what it's
   currently showing. Before any command's been sent since the agent last
   restarted, it shows the TV's own **default source slot** (set on the TVs
   admin card) labeled "usual, unconfirmed" rather than presented as fact.
5. There's no schedule action for this yet — `source_tune` schedules retune
   a *receiver* (DirecTV), not a TV's own tuner. Pointing a TV at a source
   on a timer would need a new schedule action type; not built this round,
   since day-to-day this is normally a one-off staff tap, not something
   that needs to happen automatically at a fixed time.

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
