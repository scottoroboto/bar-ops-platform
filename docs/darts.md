# TSB Darts — camera-scored steel-tip boards, sold by the hour

Own-built auto-scoring for the bar's steel-tip boards: a Pi and three
cameras per board read where every dart lands, a tablet at the oche runs
the games and the clock, and lane time rings into SpotOn like everything
else. Starts as a prototype on the Omni ring at the house, then 2–8
boards at the bar, with nothing in the design that stops at 20.

Files: `boards/` (the per-board node, Python — see `boards/README.md`);
the platform side (`server/darts.js`, `db/patch_0xx_darts.sql`,
`public/darts.*`) is phase 3 below and doesn't exist yet.

## Why build rather than buy

Target Omni, Scolia and Autodarts all do the camera part, and none of
them publishes an API or venue licence we could build billing and our
own games on. At one board that's an annoyance; at twenty it's the whole
business depending on a consumer product's app. The vision problem is
tractable (see below), the hardware is ~$150–250 a board, and once it
works it's ours to sell to other bars.

## How a dart gets scored

1. **Three cameras on the rim** (where the Omni's pods are, ~440 mm from
   the bull, a little above the board face) each see the whole board
   obliquely under the ring light.
2. **Calibration** is clicking 8–12 wire/ring intersections per camera
   once. That gives the camera's homography (pixel ↔ board millimetre
   on the face) *and*, because a flat board seen obliquely pins down the
   focal length, the camera's position in space.
3. **Detection**: each camera watches for the frame to change, waits for
   it to stop moving, then fits one straight line through whatever
   changed. No dart model, no colour model — a black barrel with white
   flights and a silver barrel with clear shafts both come out as "a
   streak", fragments and all.
4. **Triangulation**: that line plus the camera's position is a plane
   the dart lies in. Two cameras' planes intersect in the dart's 3-D
   line; where it pierces the board plane is the tip. Three cameras give
   three pair-answers that vote, so a view blocked by another dart's
   flight is simply outvoted. If a pose isn't available it falls back
   to each camera's lowest-pixel-through-homography estimate, weighted
   by how sharply that camera sees that spot.
5. **Scoring** is pure geometry on the fused (x, y): ring by radius,
   segment by angle.

On the synthetic rig (same geometry as the Omni, random dart styles,
realistic click error) this scores 60/60 at 0.7 mm mean error; the old
"find the tip pixel" approach managed 44/60 at 9 mm because the thin
steel point has no contrast against cream sisal. Real boards add blur,
shadows and worn sisal; the harness measures that.

## Phases

**1. Detection prototype at the house (now).** Cameras taped to the Omni,
Pi next to the board, Omni + DartCounter running alongside as the
referee. Throw a few hundred darts with the harness on; fix what the
miss folder shows. Exit criterion: ~98 % right, misses explainable.
Then decide 3 vs 4 cameras and 90° vs 120° spacing from the data, and
design the printed bracket for the bar boards.

**2. Game engine + scoreboard** (in the platform, can start any time).
501/301 (straight/double in, double out), Cricket, Around the Clock,
Shanghai, Killer. Players, turns, busts, checkout hints, and a one-tap
**correction** when the cameras miss — every commercial system has it
and players forgive a miss if the fix is instant. Phone-first web page
like `public/amusement.js`, on the lane tablet, mirrored to a TV via
Venue Control.

**3. Lanes, the clock and billing.** Start a lane session (prepaid block
or open tab), timer on the scoreboard with 10- and 5-minute warnings,
board stops scoring at time-out, time posts to SpotOn the way Diamond
collections do. Reports: hours sold per lane, busiest hours, which
games get played.

**4. Bar install.** One Pi + three cameras + light ring per board, a
printed bracket on a plain surround (no Omni), tablet per lane. The
board node is just another device type behind the Venue Control agent.

## Open questions for the prototype to answer

- Camera height above the board face: higher sees the far side less
  obliquely (more precise there) but a dart leaning toward the camera
  gets shorter. The harness will say.
- Whether black-coated barrels need the diff threshold lower than 18 in
  the real light, and what that does to false triggers.
- Bounce-outs, a dart landing in another's flight, and a dart falling
  out: the detector reports "blocked" for the ambiguous ones; see
  whether those need their own handling or just the correction button.
- Pi 4 CPU at 3 × 720p × 15 fps with the loop in Python/OpenCV — expected
  fine; measure.
