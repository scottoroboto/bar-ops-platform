"""Per-camera calibration: pixels <-> board millimetres.

The board face is a plane, and a camera looking at a plane is described
completely by a 3x3 homography. So calibrating a camera is: click a
handful of known points (wire/ring intersections, see board.calibration_
targets) in that camera's image, and solve for the matrix that maps them
onto their true millimetre positions. Four points is the minimum; eight
or more spread around the board makes it robust to a sloppy click.

Darts are read at the *tip*, which is on the board plane, so the
homography is exact there. Everything above the plane (barrel, flight)
maps wrongly, which is why the detector goes looking for the tip.
"""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, field

import cv2
import numpy as np

from . import board

MIN_POINTS = 4


@dataclass
class Calibration:
    camera_id: str
    # {target_id: (px, py)} -- what the person clicked
    clicks: dict[str, tuple[float, float]] = field(default_factory=dict)
    # 3x3 image -> board (mm). None until solved.
    H: np.ndarray | None = None
    H_inv: np.ndarray | None = None
    reprojection_mm: float | None = None   # RMS over the clicked points
    residuals: dict[str, float] = field(default_factory=dict)  # per clicked point, mm
    image_size: tuple[int, int] | None = None  # (w, h) the clicks were made at
    # camera pose, from solve_pose()
    fx: float | None = None
    K: np.ndarray | None = None
    R: np.ndarray | None = None
    t: np.ndarray | None = None
    C: np.ndarray | None = None            # camera centre in board mm
    pose_residual: float | None = None

    def solve(self) -> bool:
        """Fit the homography from the clicks. Returns False if too few."""
        targets = {t['id']: t for t in board.calibration_targets()}
        ids = [i for i in self.clicks if i in targets]
        if len(ids) < MIN_POINTS:
            self.H = self.H_inv = None
            self.reprojection_mm = None
            return False
        src = np.array([self.clicks[i] for i in ids], dtype=np.float64)
        dst = np.array([(targets[i]['x'], targets[i]['y']) for i in ids], dtype=np.float64)
        # RANSAC only kicks in with enough points to vote; below that use
        # the plain least-squares fit.
        method = cv2.RANSAC if len(ids) >= 6 else 0
        H, _ = cv2.findHomography(src, dst, method, 4.0)
        if H is None:
            self.H = self.H_inv = None
            return False
        self.H = H
        self.H_inv = np.linalg.inv(H)
        proj = self.image_to_board_many(src)
        errs = np.sqrt(np.sum((proj - dst) ** 2, axis=1))
        self.residuals = {i: float(e) for i, e in zip(ids, errs)}
        self.reprojection_mm = float(np.sqrt(np.mean(errs ** 2)))
        self.R = self.C = None
        if self.image_size:
            self.solve_pose()
        return True

    @property
    def ready(self) -> bool:
        return self.H is not None

    # -- camera pose from the plane homography -------------------------
    # H_inv = K [r1 r2 t] up to scale. With square pixels and the optical
    # centre mid-frame the only unknown in K is the focal length, and the
    # two constraints r1 . r2 = 0, |r1| = |r2| pin it down -- as long as
    # the board is seen obliquely, which from the rim it very much is.
    # That gives where the camera IS in board millimetres, which is what
    # lets two cameras triangulate a dart in 3-D (see Fuser).
    def solve_pose(self) -> bool:
        if self.H_inv is None or self.image_size is None:
            return False
        w, h = self.image_size
        cx, cy = w / 2.0, h / 2.0

        def residual(fx: float) -> float:
            K_inv = np.array([[1 / fx, 0, -cx / fx], [0, 1 / fx, -cy / fx], [0, 0, 1]])
            G = K_inv @ self.H_inv
            g1, g2 = G[:, 0], G[:, 1]
            n1, n2 = np.linalg.norm(g1), np.linalg.norm(g2)
            return (np.dot(g1, g2) / (n1 * n2)) ** 2 + ((n1 - n2) / (n1 + n2)) ** 2

        # coarse log grid then golden-section refine
        grid = np.exp(np.linspace(np.log(w * 0.25), np.log(w * 4.0), 200))
        best = float(grid[int(np.argmin([residual(f) for f in grid]))])
        lo, hi = best / 1.15, best * 1.15
        for _ in range(60):
            m1, m2 = lo + (hi - lo) * 0.382, lo + (hi - lo) * 0.618
            if residual(m1) < residual(m2):
                hi = m2
            else:
                lo = m1
        fx = (lo + hi) / 2
        K = np.array([[fx, 0, cx], [0, fx, cy], [0, 0, 1]])
        G = np.linalg.inv(K) @ self.H_inv
        lam = 2.0 / (np.linalg.norm(G[:, 0]) + np.linalg.norm(G[:, 1]))
        r1, r2, t = G[:, 0] * lam, G[:, 1] * lam, G[:, 2] * lam
        if t[2] < 0:          # the board must be in front of the camera
            r1, r2, t = -r1, -r2, -t
        R = np.column_stack([r1, r2, np.cross(r1, r2)])
        U, _, Vt = np.linalg.svd(R)
        R = U @ Vt
        if np.linalg.det(R) < 0:
            R = -R
        self.fx, self.K, self.R, self.t = fx, K, R, t
        self.C = -R.T @ t
        self.pose_residual = residual(fx)
        return True

    @property
    def has_pose(self) -> bool:
        return self.R is not None

    def ray(self, px: float, py: float) -> np.ndarray:
        """Direction (board coords, unit) of the line of sight through a
        pixel, from self.C."""
        d = self.R.T @ (np.linalg.inv(self.K) @ np.array([px, py, 1.0]))
        return d / np.linalg.norm(d)

    def image_to_board(self, px: float, py: float) -> tuple[float, float]:
        x, y = self.image_to_board_many(np.array([[px, py]], dtype=np.float64))[0]
        return float(x), float(y)

    def image_to_board_many(self, pts: np.ndarray) -> np.ndarray:
        assert self.H is not None
        p = cv2.perspectiveTransform(pts.reshape(-1, 1, 2).astype(np.float64), self.H)
        return p.reshape(-1, 2)

    def mm_per_px(self, px: float, py: float) -> float:
        """How many millimetres one pixel covers at this image point
        (the larger of the two axes). Small near the camera, large on the
        far side of the board; the fuser trusts a camera in proportion."""
        p = np.array([[px, py], [px + 1, py], [px, py + 1]], dtype=np.float64)
        b = self.image_to_board_many(p)
        return float(max(np.linalg.norm(b[1] - b[0]), np.linalg.norm(b[2] - b[0])))

    def board_to_image(self, x: float, y: float) -> tuple[float, float]:
        assert self.H_inv is not None
        p = cv2.perspectiveTransform(np.array([[[x, y]]], dtype=np.float64), self.H_inv)
        return float(p[0, 0, 0]), float(p[0, 0, 1])

    def board_to_image_many(self, pts: np.ndarray) -> np.ndarray:
        assert self.H_inv is not None
        p = cv2.perspectiveTransform(pts.reshape(-1, 1, 2).astype(np.float64), self.H_inv)
        return p.reshape(-1, 2)

    # -- persistence ----------------------------------------------------
    def to_dict(self) -> dict:
        return {
            'camera_id': self.camera_id,
            'clicks': {k: [float(v[0]), float(v[1])] for k, v in self.clicks.items()},
            'H': self.H.tolist() if self.H is not None else None,
            'reprojection_mm': self.reprojection_mm,
            'residuals': {k: round(v, 2) for k, v in self.residuals.items()},
            'image_size': list(self.image_size) if self.image_size else None,
            # informational; recomputed on load
            'fx': getattr(self, 'fx', None),
            'camera_mm': self.C.tolist() if self.has_pose else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> 'Calibration':
        c = cls(camera_id=d['camera_id'])
        c.clicks = {k: (float(v[0]), float(v[1])) for k, v in (d.get('clicks') or {}).items()}
        if d.get('image_size'):
            c.image_size = (int(d['image_size'][0]), int(d['image_size'][1]))
        if d.get('H') is not None:
            c.H = np.array(d['H'], dtype=np.float64)
            c.H_inv = np.linalg.inv(c.H)
            c.reprojection_mm = d.get('reprojection_mm')
        elif c.clicks:
            c.solve()
        if c.ready and c.image_size:
            c.solve_pose()
        return c


def calibration_path(data_dir: str, camera_id: str) -> str:
    safe = ''.join(ch if ch.isalnum() or ch in '-_' else '_' for ch in camera_id)
    return os.path.join(data_dir, 'calibration', f'{safe}.json')


def load(data_dir: str, camera_id: str) -> Calibration:
    path = calibration_path(data_dir, camera_id)
    if os.path.exists(path):
        with open(path) as f:
            return Calibration.from_dict(json.load(f))
    return Calibration(camera_id=camera_id)


def save(data_dir: str, cal: Calibration) -> None:
    path = calibration_path(data_dir, cal.camera_id)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(cal.to_dict(), f, indent=2)
    os.replace(tmp, path)


def board_overlay_polylines(cal: Calibration, step_deg: float = 3.0) -> list[np.ndarray]:
    """Rings and wires in image pixels, for drawing a calibration overlay
    on a camera frame. If the overlay sits on the real wires, the
    calibration is right."""
    out = []
    radii = [board.R_OUTER_BULL, board.R_TREBLE_INNER, board.R_TREBLE_OUTER,
             board.R_DOUBLE_INNER, board.R_DOUBLE_OUTER]
    angles = np.arange(0.0, 360.0 + step_deg, step_deg)
    for r in radii:
        pts = np.array([board.polar_to_xy(r, a) for a in angles])
        out.append(cal.board_to_image_many(pts).astype(np.int32))
    for a in board.wire_angles():
        pts = np.array([board.polar_to_xy(board.R_OUTER_BULL, a),
                        board.polar_to_xy(board.R_DOUBLE_OUTER, a)])
        out.append(cal.board_to_image_many(pts).astype(np.int32))
    return out
