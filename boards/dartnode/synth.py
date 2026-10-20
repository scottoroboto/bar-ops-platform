"""A synthetic board and cameras, so the whole pipeline -- calibration,
detection, fusion, scoring, the web UI -- can be exercised and tested
without a single camera plugged in.

The virtual cameras copy the Omni's geometry: on the rim about 440 mm
from the centre, ~210 mm above the board face (phone photos from the pod
positions show the board at roughly 25-30 degrees of elevation), looking
at the bull.
Darts are rendered as real 3-D objects (tip on the board, shaft standing
out of it, flight on the end) and projected through the same camera
model, so the "tip is the lowest point" assumption gets a genuine test
rather than a flattering one.
"""
from __future__ import annotations

import math
import random

import cv2
import numpy as np

from . import board

BG = (38, 38, 38)             # the Omni's dark dish
NUMBER_RING = (24, 24, 24)
WIRE = (190, 190, 190)
BLACK = (28, 28, 30)
CREAM = (226, 222, 205)
RED = (40, 40, 200)
GREEN = (60, 150, 60)


def camera_pose(angle_cw_deg: float, radius_mm: float = 440.0, height_mm: float = 210.0,
                size: tuple[int, int] = (1280, 720), fov_h_deg: float = 68.0,
                look_at=(0.0, 0.0, 0.0)):
    """K, R, t for a camera on the rim at `angle_cw_deg` (clockwise from
    the 20), `height_mm` above the board plane, looking at `look_at`.
    Board coords: x right, y up, z out of the board towards the thrower."""
    w, h = size
    fx = (w / 2) / math.tan(math.radians(fov_h_deg) / 2)
    K = np.array([[fx, 0, w / 2], [0, fx, h / 2], [0, 0, 1]], dtype=np.float64)
    cx, cy = board.polar_to_xy(radius_mm, angle_cw_deg)
    C = np.array([cx, cy, height_mm], dtype=np.float64)
    f = np.array(look_at, dtype=np.float64) - C
    f /= np.linalg.norm(f)
    up_hint = np.array([0.0, 0.0, 1.0])
    right = np.cross(f, up_hint)
    right /= np.linalg.norm(right)
    up = np.cross(right, f)
    R = np.vstack([right, -up, f])        # image y runs down
    t = -R @ C
    return K, R, t


def project(K, R, t, pts3: np.ndarray) -> np.ndarray:
    p = (R @ pts3.T + t[:, None])
    p = K @ p
    return (p[:2] / p[2]).T


def plane_homography(K, R, t) -> np.ndarray:
    """Board plane (z = 0) -> image, as a 3x3."""
    return K @ np.column_stack([R[:, 0], R[:, 1], t])


class BoardCanvas:
    """The board face drawn in millimetre space at `scale` px/mm."""

    def __init__(self, scale: float = 2.0, extent_mm: float = 240.0):
        self.scale = scale
        self.extent = extent_mm
        n = int(2 * extent_mm * scale)
        self.size = n
        self.img = np.full((n, n, 3), BG, dtype=np.uint8)
        self._draw()
        # canvas pixel -> mm
        self.M_px2mm = np.array([[1 / scale, 0, -extent_mm],
                                 [0, -1 / scale, extent_mm],
                                 [0, 0, 1]], dtype=np.float64)

    def _mm2px(self, pts) -> np.ndarray:
        pts = np.asarray(pts, dtype=np.float64)
        out = np.empty_like(pts)
        out[:, 0] = (pts[:, 0] + self.extent) * self.scale
        out[:, 1] = (self.extent - pts[:, 1]) * self.scale
        return out

    def _wedge(self, r0, r1, a0, a1, color):
        angs = np.linspace(a0, a1, 12)
        outer = [board.polar_to_xy(r1, a) for a in angs]
        inner = [board.polar_to_xy(r0, a) for a in angs[::-1]]
        poly = self._mm2px(outer + inner).astype(np.int32)
        cv2.fillPoly(self.img, [poly], color, lineType=cv2.LINE_AA)

    def _draw(self):
        c = self._mm2px([(0, 0)])[0].astype(int)
        cv2.circle(self.img, tuple(c), int(board.R_BOARD_EDGE * self.scale), NUMBER_RING, -1)
        half = board.SEGMENT_DEG / 2
        for k, seg in enumerate(board.SEGMENTS):
            centre = k * board.SEGMENT_DEG
            a0, a1 = centre - half, centre + half
            dark = (k % 2 == 0)
            single = BLACK if dark else CREAM
            ring = RED if dark else GREEN
            self._wedge(board.R_OUTER_BULL, board.R_TREBLE_INNER, a0, a1, single)
            self._wedge(board.R_TREBLE_INNER, board.R_TREBLE_OUTER, a0, a1, ring)
            self._wedge(board.R_TREBLE_OUTER, board.R_DOUBLE_INNER, a0, a1, single)
            self._wedge(board.R_DOUBLE_INNER, board.R_DOUBLE_OUTER, a0, a1, ring)
        cv2.circle(self.img, tuple(c), int(board.R_OUTER_BULL * self.scale), GREEN, -1, cv2.LINE_AA)
        cv2.circle(self.img, tuple(c), int(board.R_INNER_BULL * self.scale), RED, -1, cv2.LINE_AA)
        # wires
        for r in (board.R_OUTER_BULL, board.R_TREBLE_INNER, board.R_TREBLE_OUTER,
                  board.R_DOUBLE_INNER, board.R_DOUBLE_OUTER):
            cv2.circle(self.img, tuple(c), int(r * self.scale), WIRE, 1, cv2.LINE_AA)
        for a in board.wire_angles():
            p = self._mm2px([board.polar_to_xy(board.R_OUTER_BULL, a),
                             board.polar_to_xy(board.R_DOUBLE_OUTER, a)]).astype(np.int32)
            cv2.polylines(self.img, [p], False, WIRE, 1, cv2.LINE_AA)


class VirtualCamera:
    def __init__(self, cam_id: str, angle_cw_deg: float, canvas: BoardCanvas,
                 size=(1280, 720), noise: float = 2.0, **pose_kw):
        self.id = cam_id
        self.size = size
        self.noise = noise
        self.K, self.R, self.t = camera_pose(angle_cw_deg, size=size, **pose_kw)
        self.H_board2img = plane_homography(self.K, self.R, self.t)
        self.canvas = canvas
        # canvas pixel -> mm -> image pixel
        self._base = cv2.warpPerspective(canvas.img, self.H_board2img @ canvas.M_px2mm,
                                         size, borderValue=BG)
        self._rng = np.random.default_rng(hash(cam_id) & 0xffff)

    def project(self, pts3: np.ndarray) -> np.ndarray:
        return project(self.K, self.R, self.t, np.asarray(pts3, dtype=np.float64))

    def board_point_to_px(self, x: float, y: float) -> tuple[float, float]:
        p = self.project(np.array([[x, y, 0.0]]))[0]
        return float(p[0]), float(p[1])

    def render(self, darts: list['Dart']) -> np.ndarray:
        img = self._base.copy()
        for d in darts:
            d.draw(self, img)
        if self.noise > 0:
            n = self._rng.normal(0, self.noise, img.shape).astype(np.int16)
            img = np.clip(img.astype(np.int16) + n, 0, 255).astype(np.uint8)
        return img

    def fake_clicks(self, jitter_px: float = 0.0, rng: random.Random | None = None) -> dict:
        """What a careful person would click for every calibration target."""
        rng = rng or random.Random(0)
        out = {}
        for tgt in board.calibration_targets():
            px, py = self.board_point_to_px(tgt['x'], tgt['y'])
            out[tgt['id']] = (px + rng.gauss(0, jitter_px), py + rng.gauss(0, jitter_px))
        return out


# Dart "styles": nobody at a bar throws the same darts. Barrels from
# bright silver to black-coated tungsten, shafts from clear to black,
# flights from standard to slim and any colour, including ones that
# nearly match the board. The detector has to cope with all of them.
STYLES = {
    'silver':   dict(barrel=(170, 170, 175), barrel_w=3, shaft=(40, 40, 45), shaft_w=2, flight=(60, 60, 220), flight_r=(9, 14)),
    'black':    dict(barrel=(45, 45, 48), barrel_w=3, shaft=(30, 30, 30), shaft_w=2, flight=(240, 240, 240), flight_r=(9, 14)),
    'brass':    dict(barrel=(70, 150, 190), barrel_w=4, shaft=(200, 200, 200), shaft_w=2, flight=(30, 200, 240), flight_r=(10, 15)),
    'slim':     dict(barrel=(120, 120, 125), barrel_w=2, shaft=(60, 60, 60), shaft_w=1, flight=(60, 180, 60), flight_r=(5, 11)),
    # black-coated tungsten under a ring light: dark, but it still catches light
    'stealth':  dict(barrel=(64, 64, 68), barrel_w=3, shaft=(48, 48, 48), shaft_w=2, flight=(58, 58, 58), flight_r=(9, 14)),
    'cream':    dict(barrel=(200, 200, 205), barrel_w=3, shaft=(220, 215, 200), shaft_w=2, flight=(226, 222, 205), flight_r=(9, 14)),
}


class Dart:
    """A dart standing in the board. Tip at (x, y) on the plane, shaft
    leaning `tilt_deg` from the board normal towards `lean_cw_deg`."""

    def __init__(self, x: float, y: float, tilt_deg: float = 8.0, lean_cw_deg: float = 180.0,
                 length_mm: float = 150.0, style: str = 'silver'):
        self.x, self.y = x, y
        t = math.radians(tilt_deg)
        lx, ly = board.polar_to_xy(math.sin(t), lean_cw_deg)
        self.dir = np.array([lx, ly, math.cos(t)])
        self.length = length_mm
        self.style = style
        self.st = STYLES[style]

    def draw(self, cam: VirtualCamera, img: np.ndarray) -> None:
        tip = np.array([self.x, self.y, 0.0])
        s = np.linspace(0, self.length, 24)
        pts3 = tip[None, :] + s[:, None] * self.dir[None, :]
        px = cam.project(pts3)
        st = self.st

        def seg(i0, i1, color, thick):
            cv2.polylines(img, [px[i0:i1 + 1].astype(np.int32)], False, color, thick, cv2.LINE_AA)
        seg(0, 4, (200, 200, 200), 1)                       # steel point, ~25 mm
        seg(4, 11, st['barrel'], st['barrel_w'])            # barrel
        seg(11, 19, st['shaft'], st['shaft_w'])             # shaft
        f = px[19:].astype(np.int32)
        if len(f) >= 2:
            c = f.mean(axis=0).astype(int)
            cv2.ellipse(img, (int(c[0]), int(c[1])), st['flight_r'], 0, 0, 360, st['flight'], -1, cv2.LINE_AA)


def default_rig(canvas: BoardCanvas | None = None, angles=(45.0, 135.0, 315.0), **kw) -> list[VirtualCamera]:
    """Three cameras where the Omni's pods are (day-one prototype)."""
    canvas = canvas or BoardCanvas()
    return [VirtualCamera(f'cam{i}', a, canvas, **kw) for i, a in enumerate(angles)]


def random_dart(rng: random.Random, max_r: float = board.R_DOUBLE_OUTER - 2) -> Dart:
    r = math.sqrt(rng.random()) * max_r
    a = rng.random() * 360
    x, y = board.polar_to_xy(r, a)
    return Dart(x, y, tilt_deg=rng.uniform(0, 14), lean_cw_deg=rng.uniform(0, 360),
                style=rng.choice(list(STYLES)))
