"""Dart detection: one `DartDetector` per camera, one `Fuser` per board.

Per camera the job is "something changed on the board, it has stopped
moving, where does the new thing touch the board?":

  idle --(frame differs from the reference)--> moving
  moving --(N consecutive near-identical frames)--> analyse
  analyse: compare the settled frame with the reference
     - looks like the empty board again  -> TAKEOUT (darts pulled)
     - one dart-sized blob               -> DART, tip = lowest point of the blob
     - anything else (hand, two darts, a flight brushing the lens) -> BLOCKED,
       reference is NOT updated, so the next settle re-analyses from scratch

"Lowest point" works because the cameras sit on the rim looking across
the board: the board plane is seen nearly edge-on, so a dart standing out
of it points *up* in the image and its tip -- the only part actually on
the plane, where the homography is exact -- is at the bottom. `tip_end`
flips that for a camera mounted some other way.

The Fuser collects each camera's opinion for a short window and agrees
on one answer: the tightest cluster of estimates wins, so a camera whose
view of the tip was blocked by another dart's flight is simply outvoted.
"""
from __future__ import annotations

import logging
import math
import time
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import board
from .calibration import Calibration

log = logging.getLogger(__name__)

KIND_DART = 'dart'
KIND_TAKEOUT = 'takeout'
KIND_BLOCKED = 'blocked'
KIND_REMOVED = 'removed'    # one dart pulled (the last one pulled becomes a takeout)


@dataclass
class DetectorConfig:
    blur: int = 5               # Gaussian kernel, odd
    diff_thresh: int = 18       # |frame - reference| above this = "changed" (0-255);
                                # low enough to catch a black barrel on the dark dish
    motion_thresh: int = 20     # |frame - previous frame| above this = "moving"
    min_change_px: int = 120    # fewer changed pixels than this is noise
    settle_px: int = 60         # moving pixels below this = still
    settle_frames: int = 4      # consecutive still frames before analysing
    min_dart_area: int = 150    # blob size limits for "one dart", in pixels
    max_dart_area: int = 60000  # generous: a dart close to the camera is big; a hand/arm is bigger
    min_aspect: float = 1.3     # a dart is elongated; a round shadow is not
    max_dart_width_px: int = 60 # thicker than this is an arm, not a barrel
    remove_median_px: int = 31  # median filter wider than a barrel, for added-vs-removed
    remove_ratio: float = 1.15  # "before" must out-detail "after" by this to count as removed
    tip_band_px: int = 3        # rows at the tip end averaged for the tip point
    stack_gap_px: int = 12      # blobs within this many px of the dart's axis are one dart
    tip_end: str = 'bottom'     # 'bottom' | 'top' | 'left' | 'right'
    roi_mm: float = 215.0       # ignore changes further than this from centre
    roi_up_frac: float = 0.45   # ...but keep the airspace above the board, where
                                # the dart body stands: this fraction of the frame height
    open_kernel: int = 3        # morphological opening to drop speckle
    adopt_after_s: float = 8.0  # a rejected scene that stays still this long becomes
                                # the new reference (self-heals a bad "board is empty")

    @classmethod
    def from_dict(cls, d: dict | None) -> 'DetectorConfig':
        c = cls()
        for k, v in (d or {}).items():
            if hasattr(c, k):
                setattr(c, k, type(getattr(c, k))(v))
        return c


@dataclass
class Observation:
    camera_id: str
    t: float
    kind: str
    px: float | None = None
    py: float | None = None
    x: float | None = None      # board mm (None if uncalibrated)
    y: float | None = None
    area: int = 0
    bbox: tuple[int, int, int, int] | None = None   # x, y, w, h in pixels
    mm_per_px: float = 1.0      # this camera's precision at the tip
    axis: tuple[float, float, float, float] | None = None  # x0, y0, vx, vy: the dart's line in the image
    note: str = ''

    def to_dict(self) -> dict:
        return {'camera_id': self.camera_id, 't': self.t, 'kind': self.kind,
                'px': self.px, 'py': self.py, 'x': self.x, 'y': self.y,
                'area': self.area, 'bbox': self.bbox, 'mm_per_px': round(self.mm_per_px, 3),
                'axis': [round(v, 3) for v in self.axis] if self.axis else None,
                'note': self.note}


class DartDetector:
    def __init__(self, camera_id: str, cal: Calibration | None, cfg: DetectorConfig | None = None):
        self.camera_id = camera_id
        self.cal = cal if (cal is not None and cal.ready) else None
        self.cfg = cfg or DetectorConfig()
        self.state = 'idle'
        self.ref: np.ndarray | None = None       # board as it currently stands
        self.empty_ref: np.ndarray | None = None  # board with no darts in it
        self._prev: np.ndarray | None = None
        self._analysed: np.ndarray | None = None  # last frame we judged
        self._rejected_at: float | None = None    # when the current standoff began
        self._still = 0
        self._roi: np.ndarray | None = None
        self.last_mask: np.ndarray | None = None  # for the debug view
        self.last_obs: Observation | None = None
        self.darts_seen = 0
        self._dart_areas: list[int] = []   # pixel size of each dart seen this turn

    # -- public ---------------------------------------------------------
    def set_calibration(self, cal: Calibration | None) -> None:
        self.cal = cal if (cal is not None and cal.ready) else None
        self._roi = None

    def reset(self, frame: np.ndarray | None = None, empty: bool = True) -> None:
        """Take the current frame as the reference. `empty=True` also
        records it as what the board looks like with no darts in it."""
        g = self._prep(frame) if frame is not None else None
        self.ref = g
        if empty:
            self.empty_ref = g
            self.darts_seen = 0
            self._dart_areas = []
        self._prev = g
        self._analysed = None
        self._rejected_at = None
        self.state = 'idle'
        self._still = 0

    def process(self, frame: np.ndarray, t: float | None = None) -> Observation | None:
        t = time.time() if t is None else t
        g = self._prep(frame)
        if self.cal is not None and self.cal.image_size is None:
            self.cal.image_size = (g.shape[1], g.shape[0])
            self.cal.solve_pose()
        if self.ref is None:
            self.ref = g
            self.empty_ref = g
            self._prev = g
            return None
        roi = self._get_roi(g.shape)
        moving = int(np.count_nonzero((cv2.absdiff(g, self._prev) > self.cfg.motion_thresh) & roi))
        self._prev = g
        changed = int(np.count_nonzero((cv2.absdiff(g, self.ref) > self.cfg.diff_thresh) & roi))

        if self.state == 'idle':
            # Something new on the board -- unless it's the same something
            # we already looked at and rejected (a hand holding still): then
            # wait for actual motion before looking again...
            if changed >= self.cfg.min_change_px:
                same_as_rejected = (
                    self._analysed is not None and moving < self.cfg.settle_px and
                    int(np.count_nonzero((cv2.absdiff(g, self._analysed) > self.cfg.diff_thresh) & roi))
                    < self.cfg.min_change_px)
                if not same_as_rejected:
                    self.state = 'moving'
                    self._still = 0
                elif self._rejected_at and t - self._rejected_at >= self.cfg.adopt_after_s:
                    # ...and if that rejected scene just stays there, it IS
                    # the board now: whatever we thought was wrong, wasn't.
                    log.info('[%s] adopting the still scene as the reference', self.camera_id)
                    self.ref = g
                    if self.darts_seen == 0 or self.darts_seen >= 3:
                        self.empty_ref = g      # between turns: the board is empty
                        self.darts_seen = 0
                    self._rejected_at = None
                    self._analysed = None
            return None

        # moving
        if moving < self.cfg.settle_px:
            self._still += 1
        else:
            self._still = 0
        if self._still < self.cfg.settle_frames:
            return None

        obs = self._analyse(g, roi, t)
        self._analysed = g
        if obs is not None and obs.kind == KIND_BLOCKED:
            self._rejected_at = self._rejected_at or t
        else:
            self._rejected_at = None
        self.state = 'idle'
        self._still = 0
        if obs is not None:
            self.last_obs = obs
        return obs

    # -- internals ------------------------------------------------------
    def _prep(self, frame: np.ndarray) -> np.ndarray:
        g = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY) if frame.ndim == 3 else frame
        k = self.cfg.blur
        return cv2.GaussianBlur(g, (k, k), 0) if k > 1 else g

    def _get_roi(self, shape) -> np.ndarray:
        if self._roi is not None and self._roi.shape == shape:
            return self._roi
        roi = np.ones(shape, dtype=bool)
        if self.cal is not None:
            angles = np.arange(0, 360, 4)
            pts = np.array([board.polar_to_xy(self.cfg.roi_mm, a) for a in angles])
            poly = self.cal.board_to_image_many(pts)
            if np.all(np.isfinite(poly)):
                # the board outline plus the same outline lifted by the
                # height a dart can stand in the image, hulled together
                up = self.cfg.roi_up_frac * shape[0]
                if self.cfg.tip_end == 'top':
                    up = -up
                lifted = poly + np.array([0.0, -up])
                hull = cv2.convexHull(np.vstack([poly, lifted]).astype(np.float32))
                m = np.zeros(shape, dtype=np.uint8)
                cv2.fillPoly(m, [hull.astype(np.int32)], 255)
                roi = m.astype(bool)
        self._roi = roi
        return roi

    def _analyse(self, g: np.ndarray, roi: np.ndarray, t: float) -> Observation | None:
        cfg = self.cfg
        mask = ((cv2.absdiff(g, self.ref) > cfg.diff_thresh) & roi).astype(np.uint8) * 255
        if cfg.open_kernel > 1:
            k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (cfg.open_kernel, cfg.open_kernel))
            mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, k)
        self.last_mask = mask
        changed = int(np.count_nonzero(mask))
        if changed < cfg.min_change_px:
            return None  # a flicker; nothing actually changed

        # Back to the empty board? Then the darts were pulled.
        if self.empty_ref is not None:
            vs_empty = int(np.count_nonzero((cv2.absdiff(g, self.empty_ref) > cfg.diff_thresh) & roi))
            if vs_empty < cfg.min_change_px:
                self.ref = g
                self.empty_ref = g      # refresh against slow lighting drift
                self.darts_seen = 0
                self._dart_areas = []
                return Observation(self.camera_id, t, KIND_TAKEOUT, area=changed)

        n, labels, stats, centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
        if n <= 1:
            return None
        members, others = self._stack(labels, stats, centroids)
        comp = np.isin(labels, members)
        area = int(np.count_nonzero(comp))
        ys, xs = np.nonzero(comp)
        bbox = (int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))

        # Judge the CANDIDATE on its own merits. Other change in the frame
        # (the thrower's reflection in a glossy surround, their shadow, an
        # earlier dart's flight twitching) is normal at a real board and
        # must not veto a perfectly good dart.
        if area > cfg.max_dart_area:
            return Observation(self.camera_id, t, KIND_BLOCKED, area=changed, bbox=bbox,
                               note='too big for a dart')
        if area < cfg.min_dart_area:
            return Observation(self.camera_id, t, KIND_BLOCKED, area=changed, bbox=bbox,
                               note='too small for a dart')

        rect = cv2.minAreaRect(np.column_stack([xs, ys]).astype(np.float32))
        (rw, rh) = rect[1]
        aspect = max(rw, rh) / max(1.0, min(rw, rh))
        if aspect < cfg.min_aspect:
            return Observation(self.camera_id, t, KIND_BLOCKED, area=area, bbox=bbox,
                               note=f'not dart-shaped (aspect {aspect:.1f})')
        if min(rw, rh) > cfg.max_dart_width_px:
            return Observation(self.camera_id, t, KIND_BLOCKED, area=area, bbox=bbox,
                               note=f'too thick for a dart ({min(rw, rh):.0f} px): an arm?')

        px, py = self._tip(xs, ys)
        vx, vy, x0, y0 = (float(v) for v in cv2.fitLine(
            np.column_stack([xs, ys]).astype(np.float32), cv2.DIST_HUBER, 0, 0.01, 0.01).ravel())
        bx = by = None
        mmpp = 1.0
        if self.cal is not None:
            bx, by = self.cal.image_to_board(px, py)
            mmpp = self.cal.mm_per_px(px, py)
            if math.hypot(bx, by) > cfg.roi_mm:
                return Observation(self.camera_id, t, KIND_BLOCKED, area=area, bbox=bbox,
                                   note=f'tip off the board ({math.hypot(bx, by):.0f} mm out)')

        # Added or removed? Pulling a dart changes exactly the pixels it
        # stood on, which is just as dart-shaped as it arriving. Whichever
        # frame has the thin object in it is the one with the dart.
        before, after = self._thinness(self.ref, comp, bbox), self._thinness(g, comp, bbox)
        if before > after * cfg.remove_ratio:
            self.ref = g
            # far more change than any one dart made = they all came out at once
            typical = float(np.median(self._dart_areas)) if self._dart_areas else float(area)
            if self.darts_seen >= 2 and changed >= 1.7 * typical:
                self.empty_ref = g
                self.darts_seen = 0
                self._dart_areas = []
                return Observation(self.camera_id, t, KIND_TAKEOUT, area=changed,
                                   note=f'all pulled; thin {before:.1f} -> {after:.1f}')
            self.darts_seen = max(0, self.darts_seen - 1)
            if self._dart_areas:
                self._dart_areas.pop()
            if self.darts_seen == 0:
                self.empty_ref = g      # that was the last one: this IS the empty board
            return Observation(self.camera_id, t, KIND_REMOVED, px=px, py=py, x=bx, y=by,
                               area=area, bbox=bbox, mm_per_px=mmpp,
                               note=f'thin {before:.1f} -> {after:.1f}')
        note = f'noisy: {others} px of other change' if others > area * 0.5 else ''
        if after < before * cfg.remove_ratio:
            note = (note + '; ' if note else '') + f'add/remove unclear ({before:.1f} vs {after:.1f})'
        self.ref = g
        self.darts_seen += 1
        self._dart_areas.append(area)
        return Observation(self.camera_id, t, KIND_DART, px=px, py=py, x=bx, y=by,
                           area=area, bbox=bbox, mm_per_px=mmpp, axis=(x0, y0, vx, vy), note=note)

    def _thinness(self, img: np.ndarray, comp: np.ndarray, bbox) -> float:
        """How much fine detail sits inside the changed region: a dart is
        thin, so a wide median filter wipes it out and leaves a big
        difference; the board underneath (broad segments, thin wires)
        leaves much less. Computed on a crop around the region only."""
        x, y, w, h = bbox
        pad = 12
        y0, y1 = max(0, y - pad), min(img.shape[0], y + h + pad)
        x0, x1 = max(0, x - pad), min(img.shape[1], x + w + pad)
        crop = img[y0:y1, x0:x1]
        m = comp[y0:y1, x0:x1]
        if crop.size == 0 or not m.any():
            return 0.0
        med = cv2.medianBlur(crop, self.cfg.remove_median_px)
        return float(np.mean(np.abs(crop.astype(np.int16) - med.astype(np.int16))[m]))

    def _stack(self, labels: np.ndarray, stats: np.ndarray, centroids: np.ndarray) -> tuple[list[int], int]:
        """One dart rarely comes out as one blob: a dark shaft vanishes
        against the dark surround, the flight floats free above the
        barrel, and the thin steel point breaks into dots. Starting from
        the biggest blob, take its long axis and pull in every other blob
        whose centre lies close to that line -- a leaning dart is still
        one straight line. Returns the member labels and the pixel count
        of what was left out."""
        gap = self.cfg.stack_gap_px
        order = list(range(1, len(stats)))
        total = sum(int(stats[i, cv2.CC_STAT_AREA]) for i in order)

        def members_near(line) -> list[int]:
            vx, vy, x0, y0 = line
            out = []
            for i in order:
                cx, cy = float(centroids[i][0]), float(centroids[i][1])
                # perpendicular distance from the blob centre to the axis
                if abs((cx - x0) * vy - (cy - y0) * vx) <= gap:
                    out.append(i)
            return out

        def fit(sel: np.ndarray):
            ys, xs = np.nonzero(sel)
            pts = np.column_stack([xs, ys]).astype(np.float32)
            if len(pts) < 5:
                return 0.0, 1.0, float(xs.mean()), float(ys.mean())
            return tuple(float(v) for v in cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel())

        # First guess: one straight line through EVERYTHING that changed.
        # When one dart arrived, that's the dart, however it fragmented.
        members = members_near(fit(labels > 0))
        covered = sum(int(stats[i, cv2.CC_STAT_AREA]) for i in members)
        if covered < 0.6 * total:
            # Didn't explain the change (shadow, two things): fall back to
            # the LONGEST blob (a barrel), not the biggest (a flight seen
            # face-on can out-area a foreshortened barrel), and its axis.
            def length(i):
                return math.hypot(float(stats[i, cv2.CC_STAT_WIDTH]), float(stats[i, cv2.CC_STAT_HEIGHT]))
            seed = max(order, key=lambda i: (length(i), int(stats[i, cv2.CC_STAT_AREA])))
            members = members_near(fit(labels == seed))
            if seed not in members:
                members.append(seed)
        others = total - sum(int(stats[i, cv2.CC_STAT_AREA]) for i in members)
        return members, others

    def _tip(self, xs: np.ndarray, ys: np.ndarray) -> tuple[float, float]:
        band = self.cfg.tip_band_px
        end = self.cfg.tip_end
        if end == 'bottom':
            sel = ys >= ys.max() - band
        elif end == 'top':
            sel = ys <= ys.min() + band
        elif end == 'left':
            sel = xs <= xs.min() + band
        else:
            sel = xs >= xs.max() - band
        return float(xs[sel].mean()), float(ys[sel].mean())


@dataclass
class BoardEvent:
    kind: str                      # dart | takeout | blocked
    t: float
    x: float | None = None
    y: float | None = None
    hit: board.Hit | None = None
    confidence: float = 0.0        # fraction of cameras that agreed
    spread_mm: float = 0.0         # how far apart the agreeing cameras were
    method: str = ''               # '3d' (triangulated) | '2d' (homography fallback)
    dart_index: int = 0            # 1..3 since the last takeout
    cameras: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        d = {'kind': self.kind, 't': self.t, 'x': self.x, 'y': self.y,
             'confidence': round(self.confidence, 3), 'spread_mm': round(self.spread_mm, 2),
             'method': self.method, 'dart_index': self.dart_index, 'cameras': self.cameras}
        if self.hit is not None:
            d.update({'segment': self.hit.segment, 'ring': self.hit.ring,
                      'multiplier': self.hit.multiplier, 'score': self.hit.score,
                      'label': self.hit.label})
        return d


class Fuser:
    """Turns per-camera observations into one event per dart.

    Preferred method -- triangulation. Each camera reports the dart's
    line in its image. That line and the camera's centre define a plane
    in board space that the dart lies in; two cameras' planes intersect
    in the dart's 3-D line, and where that line pierces the board (z=0)
    is the tip. The steel point never has to be seen: the barrel, the
    biggest and shiniest part of the dart, carries all the information.

    Fallback -- each camera's "lowest pixel of the dart" pushed through
    its homography, weighted by how sharply that camera sees that spot.
    Used with one camera, or when poses aren't solved yet.
    """

    def __init__(self, camera_ids: list[str], window_s: float = 0.8,
                 agree_mm: float = 10.0, min_cameras: int = 2,
                 cals: dict[str, Calibration] | None = None):
        self.camera_ids = list(camera_ids)
        self.window_s = window_s
        self.agree_mm = agree_mm
        self.min_cameras = max(1, min(min_cameras, len(camera_ids)))
        self.cals: dict[str, Calibration] = dict(cals or {})
        self._pending: list[Observation] = []
        self._opened = 0.0
        self.dart_index = 0
        # darts standing in the board this turn (fused mm). A dart keeps
        # settling into the sisal for seconds after it looks still, and
        # that sag reads as a new dart-shaped change with the same tip:
        # anything landing within dup_mm of one of these is that dart
        # resettling, not a new one.
        self.dup_mm = 5.0
        self.in_board: list[tuple[float, float]] = []

    def set_calibration(self, cal: Calibration) -> None:
        self.cals[cal.camera_id] = cal

    # -- 3-D ------------------------------------------------------------
    def _plane(self, o: Observation):
        cal = self.cals.get(o.camera_id)
        if cal is None or not cal.has_pose or o.axis is None:
            return None
        x0, y0, vx, vy = o.axis
        da = cal.ray(x0, y0)
        db = cal.ray(x0 + 100 * vx, y0 + 100 * vy)
        n = np.cross(da, db)
        nn = np.linalg.norm(n)
        if nn < 1e-9:
            return None
        return n / nn, cal.C

    @staticmethod
    def _pierce(p1, p2, min_angle_deg: float = 8.0):
        """Tip from two planes, or None if they're too nearly parallel
        (the dart lies on the line between the two cameras)."""
        (n1, c1), (n2, c2) = p1, p2
        u = np.cross(n1, n2)
        un = np.linalg.norm(u)
        if un < math.sin(math.radians(min_angle_deg)):
            return None
        u /= un
        if abs(u[2]) < 0.25:      # a dart lying nearly flat: not believable
            return None
        # a point on the line: solve the two plane equations plus u.X = 0
        A = np.vstack([n1, n2, u])
        b = np.array([n1 @ c1, n2 @ c2, 0.0])
        X0 = np.linalg.solve(A, b)
        s = -X0[2] / u[2]
        tip = X0 + s * u
        return tip[:2]

    def _triangulate(self, darts: list[Observation]):
        """Returns (xy, used_indices, spread_mm) or None."""
        planes = [self._plane(o) for o in darts]
        idx = [i for i, p in enumerate(planes) if p is not None]
        if len(idx) < 2:
            return None
        pairs = []
        for a in range(len(idx)):
            for b in range(a + 1, len(idx)):
                i, j = idx[a], idx[b]
                tip = self._pierce(planes[i], planes[j])
                if tip is not None:
                    pairs.append((i, j, tip))
        if not pairs:
            return None
        # largest cluster of agreeing pair-answers
        best = None
        for _, _, seed in pairs:
            cl = [p for p in pairs if np.linalg.norm(p[2] - seed) <= self.agree_mm]
            if best is None or len(cl) > len(best):
                best = cl
        tips = np.array([p[2] for p in best])
        xy = tips.mean(axis=0)
        used = sorted({i for p in best for i in (p[0], p[1])})
        spread = float(max(np.linalg.norm(t - xy) for t in tips)) if len(tips) > 1 else 0.0
        return xy, used, spread

    def add(self, obs: Observation, now: float | None = None) -> BoardEvent | None:
        now = obs.t if now is None else now
        if not self._pending:
            self._opened = now
        self._pending.append(obs)
        if {o.camera_id for o in self._pending} >= set(self.camera_ids):
            return self._resolve()
        return self.tick(now)

    def tick(self, now: float | None = None) -> BoardEvent | None:
        """Call regularly; closes a window whose cameras never all spoke."""
        if not self._pending:
            return None
        now = time.time() if now is None else now
        if now - self._opened >= self.window_s:
            return self._resolve()
        return None

    def _resolve(self) -> BoardEvent | None:
        obs, self._pending = self._pending, []
        t = max(o.t for o in obs)
        kinds = [o.kind for o in obs]
        n_cams = len(self.camera_ids)

        if kinds.count(KIND_TAKEOUT) >= max(1, (n_cams + 1) // 2) or \
                (KIND_TAKEOUT in kinds and KIND_DART not in kinds):
            self.dart_index = 0
            self.in_board = []
            return BoardEvent(KIND_TAKEOUT, t, confidence=kinds.count(KIND_TAKEOUT) / n_cams,
                              cameras=[o.to_dict() for o in obs])

        removed = [o for o in obs if o.kind == KIND_REMOVED]
        if removed and KIND_DART not in kinds:
            # drop the nearest dart we know of; the last one out is a takeout
            pos = [(o.x, o.y) for o in removed if o.x is not None]
            if self.in_board:
                if pos:
                    rx, ry = np.mean(np.array(pos), axis=0)
                    k = int(np.argmin([math.hypot(x - rx, y - ry) for x, y in self.in_board]))
                else:
                    k = len(self.in_board) - 1
                self.in_board.pop(k)
            if not self.in_board:
                self.dart_index = 0
                return BoardEvent(KIND_TAKEOUT, t, confidence=len(removed) / n_cams,
                                  cameras=[o.to_dict() for o in obs])
            self.dart_index = max(0, self.dart_index - 1)
            return BoardEvent(KIND_REMOVED, t, dart_index=self.dart_index,
                              confidence=len(removed) / n_cams, cameras=[o.to_dict() for o in obs])

        darts = [o for o in obs if o.kind == KIND_DART and o.x is not None]
        if not darts:
            if KIND_DART in kinds:  # uncalibrated cameras saw a dart
                self.dart_index += 1
                return BoardEvent(KIND_DART, t, dart_index=self.dart_index,
                                  cameras=[o.to_dict() for o in obs])
            return BoardEvent(KIND_BLOCKED, t, cameras=[o.to_dict() for o in obs])

        tri = self._triangulate(darts)
        if tri is not None:
            fused, used, spread = tri
            method = '3d'
        else:
            fused, used, spread = self._fuse_2d(darts)
            method = '2d'
        if any(math.hypot(fused[0] - x, fused[1] - y) <= self.dup_mm for x, y in self.in_board):
            log.info('dart at (%.0f, %.0f) is one already in the board resettling; ignored',
                     fused[0], fused[1])
            return None
        self.in_board.append((float(fused[0]), float(fused[1])))
        hit = board.score_at(float(fused[0]), float(fused[1]))
        self.dart_index += 1
        cams = []
        for o in obs:
            d = o.to_dict()
            d['used'] = o.kind == KIND_DART and any(darts[k] is o for k in used)
            cams.append(d)
        return BoardEvent(KIND_DART, t, x=float(fused[0]), y=float(fused[1]), hit=hit,
                          confidence=len(used) / n_cams, spread_mm=spread, method=method,
                          dart_index=self.dart_index, cameras=cams)

    def _fuse_2d(self, darts: list[Observation]):
        pts = np.array([(o.x, o.y) for o in darts])
        # a camera's say is inversely proportional to its blur at that spot
        w = np.array([1.0 / max(o.mm_per_px, 0.05) ** 2 for o in darts])
        if len(darts) == 1:
            used = [0]
        else:
            d = np.linalg.norm(pts[:, None, :] - pts[None, :, :], axis=2)
            np.fill_diagonal(d, np.inf)
            i, j = np.unravel_index(int(np.argmin(d)), d.shape)
            seed = (pts[i] * w[i] + pts[j] * w[j]) / (w[i] + w[j])
            used = [k for k in range(len(pts)) if np.linalg.norm(pts[k] - seed) <= self.agree_mm]
            if len(used) < 2:
                used = [int(i), int(j)]
        fused = (pts[used] * w[used, None]).sum(axis=0) / w[used].sum()
        spread = float(max(np.linalg.norm(pts[k] - fused) for k in used)) if len(used) > 1 else 0.0
        return fused, used, spread
