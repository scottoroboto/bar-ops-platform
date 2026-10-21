"""Hands-on-the-board scenarios, run through the synthetic rig at 15 fps.

Each scenario is a little script of what a player does -- throws, reaches
in, hesitates, pulls some or all darts, wanders off -- and the assertion
is the exact sequence of events the board node must hand to the game
engine. These are the contract the engine's turn logic is built on, so a
detector change that breaks one of them is a real regression.

Run: python boards/tests/test_scenarios.py   (or pytest)
"""
from __future__ import annotations

import os
import random
import sys

import cv2
import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dartnode import board, calibration, detector, synth  # noqa: E402

FPS = 15
DT = 1.0 / FPS
SKIN = (120, 150, 200)      # BGR
SLEEVE = (70, 60, 60)


class Hand:
    """An arm reaching in over the board, drawn as a 3-D stroke from off
    the bottom edge of the board to the hand, with a soft shadow on the
    board under the hand. `at` is the hand's board position (mm)."""

    def __init__(self, at=(0.0, -120.0), z_mm: float = 45.0, from_cw_deg: float = 180.0):
        self.at = np.array(at, dtype=float)
        self.z = z_mm
        self.base = np.array(board.polar_to_xy(420.0, from_cw_deg))

    def draw(self, cam: synth.VirtualCamera, img: np.ndarray) -> None:
        base3 = np.array([self.base[0], self.base[1], 140.0])
        hand3 = np.array([self.at[0], self.at[1], self.z])
        pts = cam.project(np.vstack([base3, (base3 + hand3) / 2 + [0, 0, 30], hand3]))
        # shadow first (on the board plane, offset a little)
        sh = cam.project(np.array([[self.at[0] + 15, self.at[1] - 10, 0.0]]))[0]
        overlay = img.copy()
        cv2.ellipse(overlay, (int(sh[0]), int(sh[1])), (48, 22), 0, 0, 360, (10, 10, 10), -1, cv2.LINE_AA)
        cv2.addWeighted(overlay, 0.45, img, 0.55, 0, img)
        cv2.polylines(img, [pts.astype(np.int32)], False, SLEEVE, 64, cv2.LINE_AA)
        cv2.polylines(img, [pts[1:].astype(np.int32)], False, SKIN, 54, cv2.LINE_AA)
        cv2.circle(img, (int(pts[2][0]), int(pts[2][1])), 40, SKIN, -1, cv2.LINE_AA)


class Rig:
    def __init__(self, seed: int = 1, jitter_px: float = 0.5):
        self.cams = synth.default_rig()
        self.rng = random.Random(seed)
        self.dets = []
        cals = {}
        for c in self.cams:
            cal = calibration.Calibration(c.id, clicks=c.fake_clicks(jitter_px=jitter_px, rng=self.rng),
                                          image_size=c.size)
            assert cal.solve() and cal.has_pose
            cals[c.id] = cal
            self.dets.append(detector.DartDetector(c.id, cal))
        self.fuser = detector.Fuser([c.id for c in self.cams], cals=cals)
        self.t = 0.0
        self.darts: list[synth.Dart] = []
        self.hand: Hand | None = None
        self.gain = 1.0
        self.events: list[detector.BoardEvent] = []
        for c, d in zip(self.cams, self.dets):
            d.reset(self.render(c), empty=True)

    # -- rendering ------------------------------------------------------
    def render(self, cam) -> np.ndarray:
        img = cam.render(self.darts)
        if self.hand is not None:
            self.hand.draw(cam, img)
        if self.gain != 1.0:
            img = np.clip(img.astype(np.float32) * self.gain, 0, 255).astype(np.uint8)
        return img

    def frame(self, dt: float = DT) -> None:
        self.t += dt
        for c, d in zip(self.cams, self.dets):
            obs = d.process(self.render(c), self.t)
            if obs is not None:
                ev = self.fuser.add(obs, self.t)
                if ev is not None:
                    self.events.append(ev)
        ev = self.fuser.tick(self.t)
        if ev is not None:
            self.events.append(ev)

    # -- the player's actions -------------------------------------------
    def still(self, seconds: float) -> None:
        for _ in range(int(seconds * FPS)):
            self.frame()

    def wait(self, seconds: float) -> None:
        """A long still period: same scene, but the clock jumps so the
        wait costs nothing to simulate (minutes in a few frames)."""
        self.still(1.0)
        n = 20
        for _ in range(n):
            self.frame(dt=max(DT, (seconds - 2.0) / n))
        self.still(1.0)

    def throw(self, dart: synth.Dart) -> None:
        # a few frames of the dart wobbling before it stands still
        for k in range(3):
            d = synth.Dart(dart.x + self.rng.uniform(-2, 2), dart.y + self.rng.uniform(-2, 2),
                           tilt_deg=8 + self.rng.uniform(-6, 6), lean_cw_deg=self.rng.uniform(0, 360),
                           style=dart.style)
            self.darts.append(d)
            self.frame()
            self.darts.pop()
        self.darts.append(dart)
        self.still(1.5)

    def reach(self, to_xy, seconds: float = 0.6) -> None:
        start = np.array(board.polar_to_xy(420.0, 180.0)) if self.hand is None else self.hand.at
        to = np.array(to_xy, dtype=float)
        n = max(2, int(seconds * FPS))
        for k in range(1, n + 1):
            self.hand = Hand(at=start + (to - start) * k / n)
            self.frame()

    def hover(self, seconds: float) -> None:
        """Hand in place but a person is never perfectly still."""
        assert self.hand is not None
        base = self.hand.at.copy()
        for _ in range(int(seconds * FPS)):
            self.hand = Hand(at=base + np.array([self.rng.uniform(-1.5, 1.5), self.rng.uniform(-1.5, 1.5)]))
            self.frame()

    def pull(self, which: list[int]) -> None:
        """Darts come out in the hand (indices into self.darts)."""
        for i in sorted(which, reverse=True):
            self.darts.pop(i)
        self.frame()

    def withdraw(self, seconds: float = 0.6) -> None:
        assert self.hand is not None
        start = self.hand.at
        end = np.array(board.polar_to_xy(420.0, 180.0))
        n = max(2, int(seconds * FPS))
        for k in range(1, n + 1):
            self.hand = Hand(at=start + (end - start) * k / n)
            self.frame()
        self.hand = None
        self.still(1.5)

    # -- checking -------------------------------------------------------
    def kinds(self) -> list[str]:
        """Event kinds in order, with dart labels, ignoring 'blocked'."""
        out = []
        for e in self.events:
            if e.kind == detector.KIND_DART:
                out.append(f'dart{e.dart_index}:{e.hit.label if e.hit else "?"}')
            elif e.kind == detector.KIND_REMOVED:
                out.append(f'removed({e.dart_index} left)')
            elif e.kind == detector.KIND_TAKEOUT:
                out.append('takeout')
        return out


T20 = lambda: synth.Dart(*board.polar_to_xy(103, 0))        # noqa: E731
S5 = lambda: synth.Dart(*board.polar_to_xy(130, 342))       # noqa: E731
D16 = lambda: synth.Dart(*board.polar_to_xy(166, 234))      # noqa: E731
S11 = lambda: synth.Dart(*board.polar_to_xy(60, 270))       # noqa: E731


def three_darts(rig: Rig) -> None:
    rig.throw(T20())
    rig.throw(S5())
    rig.throw(D16())
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'dart3:D16'], rig.kinds()


def test_fast_grab_all_three():
    rig = Rig()
    three_darts(rig)
    rig.reach((0, -60), 0.4)
    rig.pull([0, 1, 2])
    rig.withdraw(0.4)
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'dart3:D16', 'takeout'], rig.kinds()


def test_slow_one_at_a_time():
    rig = Rig()
    three_darts(rig)
    for i, at in enumerate([(0, 103), (-40, 123), (-134, -98)]):
        rig.reach(at)
        rig.hover(0.8)
        rig.pull([0])
        rig.withdraw()
        rig.still(1.0)
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'dart3:D16',
                           'removed(2 left)', 'removed(1 left)', 'takeout'], rig.kinds()


def test_bathroom_break_then_pull():
    rig = Rig()
    three_darts(rig)
    rig.wait(6 * 60)
    rig.reach((0, -60))
    rig.pull([0, 1, 2])
    rig.withdraw()
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'dart3:D16', 'takeout'], rig.kinds()


def test_angry_grab_after_one_dart():
    rig = Rig()
    rig.throw(T20())
    rig.reach((0, 103))
    rig.pull([0])
    rig.withdraw()
    rig.throw(S5())
    assert rig.kinds() == ['dart1:T20', 'takeout', 'dart1:S5'], rig.kinds()


def test_angry_grab_after_two_darts():
    rig = Rig()
    rig.throw(T20())
    rig.throw(S5())
    rig.reach((-20, 110))
    rig.pull([0, 1])
    rig.withdraw()
    rig.throw(D16())
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'takeout', 'dart1:D16'], rig.kinds()


def test_hover_and_leave_without_pulling():
    rig = Rig()
    three_darts(rig)
    rig.reach((0, 80))
    rig.hover(10.0)          # looking at them, deciding
    rig.withdraw()
    rig.still(3.0)
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'dart3:D16'], rig.kinds()
    # and the darts are still accounted for: pulling them now is a takeout
    rig.reach((0, -60))
    rig.pull([0, 1, 2])
    rig.withdraw()
    assert rig.kinds()[-1] == 'takeout', rig.kinds()


def test_pull_two_hesitate_pull_last():
    rig = Rig()
    three_darts(rig)
    rig.reach((-20, 110))
    rig.pull([0, 1])
    rig.hover(4.0)           # hand stays in, holding two darts
    rig.reach((-134, -98), 0.4)
    rig.pull([0])
    rig.withdraw()
    k = rig.kinds()
    assert k[:3] == ['dart1:T20', 'dart2:S5', 'dart3:D16'] and k[-1] == 'takeout', k
    assert 'dart' not in ''.join(k[3:]), k   # nothing scored while the hand was in


def test_eager_next_player():
    rig = Rig()
    three_darts(rig)
    rig.throw(S11())         # the next player can't wait
    assert rig.kinds()[-1] == 'dart4:S11', rig.kinds()
    rig.reach((0, -60))
    rig.pull([0, 1, 2, 3])
    rig.withdraw()
    assert rig.kinds()[-1] == 'takeout', rig.kinds()
    assert rig.fuser.dart_index == 0


def test_dart_falls_out_mid_turn():
    rig = Rig()
    rig.throw(T20())
    rig.throw(S5())
    rig.darts.pop(0)         # the first one drops out on its own
    rig.still(2.0)
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'removed(1 left)'], rig.kinds()
    rig.throw(D16())
    assert rig.kinds()[-1] == 'dart2:D16', rig.kinds()


def test_hand_across_the_lens():
    """The puller's arm sweeps right past one camera, covering most of
    its frame on the way in and out."""
    rig = Rig()
    three_darts(rig)
    cam0 = rig.cams[0]
    # a few frames where cam0 sees almost nothing but arm
    for _ in range(6):
        rig.t += DT
        for c, d in zip(rig.cams, rig.dets):
            img = rig.render(c)
            if c is cam0:
                cv2.rectangle(img, (0, 100), (1280, 720), SKIN, -1)
            obs = d.process(img, rig.t)
            if obs is not None:
                ev = rig.fuser.add(obs, rig.t)
                if ev:
                    rig.events.append(ev)
    rig.reach((0, -60))
    rig.pull([0, 1, 2])
    rig.withdraw()
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'dart3:D16', 'takeout'], rig.kinds()


def test_lighting_drift_with_darts_in():
    rig = Rig()
    three_darts(rig)
    for k in range(40):      # the room brightens 15% over ~40 s
        rig.gain = 1.0 + 0.15 * (k + 1) / 40
        rig.frame(dt=1.0)
    rig.still(2.0)
    assert rig.kinds() == ['dart1:T20', 'dart2:S5', 'dart3:D16'], rig.kinds()
    rig.reach((0, -60))
    rig.pull([0, 1, 2])
    rig.withdraw()
    assert rig.kinds()[-1] == 'takeout', rig.kinds()


SCENARIOS = [
    test_fast_grab_all_three, test_slow_one_at_a_time, test_bathroom_break_then_pull,
    test_angry_grab_after_one_dart, test_angry_grab_after_two_darts,
    test_hover_and_leave_without_pulling, test_pull_two_hesitate_pull_last,
    test_eager_next_player, test_dart_falls_out_mid_turn, test_hand_across_the_lens,
    test_lighting_drift_with_darts_in,
]

if __name__ == '__main__':
    failed = 0
    for fn in SCENARIOS:
        try:
            fn()
            print(f'PASS  {fn.__name__}')
        except AssertionError as e:
            failed += 1
            print(f'FAIL  {fn.__name__}: {e}')
    sys.exit(1 if failed else 0)
