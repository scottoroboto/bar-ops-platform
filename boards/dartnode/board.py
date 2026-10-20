"""Steel-tip dartboard geometry and scoring.

Everything here is in *board coordinates*: millimetres, origin at the
centre of the bull, x to the right and y UP (towards the 20) when you face
the board. Every camera's calibration maps its pixels into this one frame,
so scoring is the same regardless of how many cameras are on the board or
where they sit.

Ring radii are the WDF/PDC regulation board (Target Tor, Winmau Blade,
Unicorn Eclipse -- all the same within a millimetre).
"""
from __future__ import annotations

import math
from dataclasses import dataclass

# Clockwise from the top. Index 0 is the 20.
SEGMENTS = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5]
SEGMENT_DEG = 360 / len(SEGMENTS)  # 18

# Radii (mm) measured from the centre. Each ring is "from the previous
# radius up to this one".
R_INNER_BULL = 6.35      # 50
R_OUTER_BULL = 15.9      # 25
R_TREBLE_INNER = 99.0    # single (inner)
R_TREBLE_OUTER = 107.0   # treble
R_DOUBLE_INNER = 162.0   # single (outer)
R_DOUBLE_OUTER = 170.0   # double
R_BOARD_EDGE = 225.5     # the number ring's outer edge, for drawing only

RING_SINGLE_BULL = 'bull'
RING_DOUBLE_BULL = 'dbull'


@dataclass(frozen=True)
class Hit:
    """One dart's resting place, scored."""
    x: float
    y: float
    segment: int        # 1..20, 25 for either bull, 0 for a miss
    ring: str           # 'miss' | 'single' | 'double' | 'treble' | 'bull' | 'dbull'
    multiplier: int     # 0, 1, 2 or 3
    score: int
    radius_mm: float
    angle_deg: float    # clockwise from the top, 0..360

    @property
    def label(self) -> str:
        """Short human form: 'T20', 'D16', 'S5', 'BULL', 'DBULL', 'MISS'."""
        if self.ring == 'miss':
            return 'MISS'
        if self.ring == RING_SINGLE_BULL:
            return 'BULL'
        if self.ring == RING_DOUBLE_BULL:
            return 'DBULL'
        return f'{self.ring[0].upper()}{self.segment}'


def clockwise_angle(x: float, y: float) -> float:
    """Angle clockwise from straight up (the 20), 0 <= a < 360."""
    a = 90.0 - math.degrees(math.atan2(y, x))
    return a % 360.0


def segment_at(angle_cw: float) -> int:
    """Segment number for an angle clockwise from the top."""
    idx = int(((angle_cw + SEGMENT_DEG / 2) % 360.0) // SEGMENT_DEG)
    return SEGMENTS[idx]


def score_at(x: float, y: float) -> Hit:
    r = math.hypot(x, y)
    a = clockwise_angle(x, y)
    seg = segment_at(a)
    if r <= R_INNER_BULL:
        return Hit(x, y, 25, RING_DOUBLE_BULL, 2, 50, r, a)
    if r <= R_OUTER_BULL:
        return Hit(x, y, 25, RING_SINGLE_BULL, 1, 25, r, a)
    if r <= R_TREBLE_INNER:
        return Hit(x, y, seg, 'single', 1, seg, r, a)
    if r <= R_TREBLE_OUTER:
        return Hit(x, y, seg, 'treble', 3, seg * 3, r, a)
    if r <= R_DOUBLE_INNER:
        return Hit(x, y, seg, 'single', 1, seg, r, a)
    if r <= R_DOUBLE_OUTER:
        return Hit(x, y, seg, 'double', 2, seg * 2, r, a)
    return Hit(x, y, 0, 'miss', 0, 0, r, a)


def polar_to_xy(radius: float, angle_cw: float) -> tuple[float, float]:
    """Inverse of (hypot, clockwise_angle)."""
    t = math.radians(90.0 - angle_cw)
    return radius * math.cos(t), radius * math.sin(t)


def wire_angles() -> list[float]:
    """The 20 segment-boundary wires, clockwise from the top. Wire k sits
    between SEGMENTS[k] and SEGMENTS[k+1]."""
    return [SEGMENT_DEG / 2 + k * SEGMENT_DEG for k in range(len(SEGMENTS))]


def wire_label(k: int) -> str:
    return f'{SEGMENTS[k]}/{SEGMENTS[(k + 1) % len(SEGMENTS)]}'


# Calibration targets: points a person can click on precisely in a camera
# image. The wire/ring intersections are sharp, high-contrast and at
# exactly known places. Order matters for the calibration UI (it walks the
# list) so keep it stable.
def calibration_targets() -> list[dict]:
    pts = []
    for k, a in enumerate(wire_angles()):
        x, y = polar_to_xy(R_DOUBLE_OUTER, a)
        pts.append({'id': f'do{k}', 'x': x, 'y': y,
                    'name': f'Outer edge of the double ring, wire {wire_label(k)}'})
    for k, a in enumerate(wire_angles()):
        x, y = polar_to_xy(R_TREBLE_OUTER, a)
        pts.append({'id': f'to{k}', 'x': x, 'y': y,
                    'name': f'Outer edge of the treble ring, wire {wire_label(k)}'})
    pts.append({'id': 'bull', 'x': 0.0, 'y': 0.0, 'name': 'Centre of the bull'})
    return pts
