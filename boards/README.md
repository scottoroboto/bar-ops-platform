# TSB Darts — board node (the Pi next to the board)

This is the piece that turns three cheap USB cameras on a steel-tip board
into "that dart was a T20". One of these runs per board, on a Raspberry
Pi 4/5 (or any Linux box, or a laptop for development). It does not know
about games, players or money — it reports darts and takeouts to TSB
Platform (`/api/darts/boards/<id>/events`), and the game engine lives
there. See `docs/darts.md` in the main repo for the whole plan.

What it does, in one line: *each camera sees the dart as a straight
line; two or more lines triangulate the dart in 3-D; where that line
pierces the board is the tip* — so the steel point never has to be
visible, and the dart's colour, barrel shape and flights don't matter.

## Hardware (prototype on the Omni ring)

- 3× USB camera modules, OV9732, 1280×720 MJPEG, ~77° lens, M12 mount
  (the "100°" 3-pack). Fixed focus: set it once at the board, lock the
  ring with a drop of nail polish.
- Raspberry Pi 4 (2 GB+) or Pi 5, proper 3 A supply. Three cameras draw
  about 0.6 A from the Pi's USB ports; no hub needed if they plug
  straight in.
- VHB tape the camera PCBs to the top of three of the Omni's pod blocks
  (10:30, 1:30 and 4:30 o'clock), lens right above the Omni's lens,
  pointed the same way. Tape over the back of the PCB first so nothing
  shorts on the pod. Leave the Omni running: it stays the referee.
- The ring light must be ON whenever the node runs. Constant, even light
  is what makes "did anything change?" reliable.

## Install on the Pi

```
sudo apt install -y python3-pip python3-numpy python3-opencv v4l-utils
# or, in a venv:  pip install -r requirements.txt
cd boards
cp config.example.json config.json
python3 -m dartnode list-cameras
```

Put each camera's `/dev/v4l/by-id/...` path into `config.json` (those
survive reboots; `/dev/video0` doesn't reliably). Then:

```
python3 -m dartnode run
```

and open `http://<pi>:8090/` from the tablet. To run on boot, a systemd
unit with `WorkingDirectory=/home/pi/bar-ops-platform/boards` and
`ExecStart=/usr/bin/python3 -m dartnode run` is all it takes.

## First run: calibrate each camera (once, ~2 minutes each)

1. Board empty, ring light on. Open `/calibrate/<cam>`.
2. The list on the right names a point ("outer edge of the double ring,
   wire 20/1"). Tap exactly that spot in the picture. Zoom the page if
   you need to. Points you can't see from this camera: **Skip**.
3. After 4 points the green rings appear; keep going until they sit
   dead on the real wires all round. 8–12 well-spread points is plenty.
   **Solve & save.** Fit error under ~2 mm is good.
4. The page also reports the lens focal length and the camera's position
   in millimetres from the bull — if that's roughly where the camera
   actually is (about 440 mm out on the Omni, 100-ish up), the pose is
   right and 3-D scoring is on.

Recalibrate a camera any time it gets bumped: the rings on the live view
will visibly drift off the wires.

## Day to day

- The live view (`/`) shows every camera with the calibration rings
  (green), the last detected dart (yellow box, magenta axis, red tip)
  and the event log.
- **Board is empty**: tap it with no darts in the board if the node ever
  gets confused (it also self-heals after ~8 s of a still scene).
- Every dart event is saved under `data/harness/<id>/` with all three
  frames, so a miss can be replayed later without the dart.

## The accuracy harness

After each dart the live view asks "was that right?". Tap ✓ or the real
score. If the Omni + DartCounter is running you only need to look when
the two disagree. `data/harness/log.csv` is the record and the summary
is on the page. The target before any of this goes in a bar: ~98 % of
darts scored right, and the misses explainable (bounce-outs, a dart
landing on top of another).

## Development without cameras

```
python3 -m dartnode simulate                  # virtual cameras, uncalibrated: do the clicking
python3 -m dartnode simulate --precalibrated  # straight to scoring
python3 tests/test_pipeline.py                # geometry + detector + fusion, 60 synthetic throws
```

The simulator copies the Omni's camera geometry, throws a random mix of
dart styles (silver, black, brass, slim, all-black, cream) and shows the
true score next to the node's answer.

## Config knobs that matter (`config.json`)

| key | what |
|---|---|
| `cameras[].controls` | v4l2 controls applied at open; exposure/gain/white balance are forced manual |
| `detector.diff_thresh` | how different a pixel must be to count as "changed" (lower = catches black barrels, more noise) |
| `detector.settle_frames` | still frames before a dart is read; raise if darts are read mid-wobble |
| `detector.tip_end` | `bottom` for rim cameras looking across the board; `top`/`left`/`right` for other mounts |
| `fuser.agree_mm` | how close two cameras' answers must be to count as agreeing |
| `fuser.min_cameras` | 1 lets a single camera score (2-D fallback, less accurate) |
| `cloud.url`, `cloud.token` | where events go; empty = local only |
