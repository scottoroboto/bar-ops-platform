"""End-to-end on the synthetic rig: calibrate from clicks, throw darts,
settle, fuse, score. Run with `python -m pytest boards/tests` or plain
`python boards/tests/test_pipeline.py`."""
import math
import os
import random
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dartnode import board, calibration, detector, synth  # noqa: E402


def test_scoring_rings():
    assert board.score_at(0, 0).label == 'DBULL'
    assert board.score_at(10, 0).label == 'BULL'
    assert board.score_at(*board.polar_to_xy(103, 0)).label == 'T20'
    assert board.score_at(*board.polar_to_xy(166, 0)).label == 'D20'
    assert board.score_at(*board.polar_to_xy(50, 18)).label == 'S1'
    assert board.score_at(*board.polar_to_xy(130, 180)).label == 'S3'
    assert board.score_at(*board.polar_to_xy(103, 270)).label == 'T11'
    assert board.score_at(*board.polar_to_xy(200, 0)).label == 'MISS'
    assert board.score_at(*board.polar_to_xy(166, 9 * 18 + 9 - 1)).label == 'D17'
    assert board.score_at(*board.polar_to_xy(166, 9 * 18 + 9 + 1)).label == 'D3'


def test_homography_roundtrip():
    cam = synth.default_rig()[0]
    cal = calibration.Calibration(cam.id, clicks=cam.fake_clicks(jitter_px=0.0))
    assert cal.solve()
    assert cal.reprojection_mm < 0.05
    for x, y in [(0, 0), (100, 50), (-150, -20), (30, -160)]:
        px, py = cam.board_point_to_px(x, y)
        bx, by = cal.image_to_board(px, py)
        assert math.hypot(bx - x, by - y) < 0.05


def _calibrated(cam, jitter_px):
    cal = calibration.Calibration(cam.id, clicks=cam.fake_clicks(jitter_px=jitter_px),
                                  image_size=cam.size)
    assert cal.solve()
    assert cal.has_pose
    return cal


def test_pose_recovery():
    for cam in synth.default_rig():
        cal = _calibrated(cam, 0.0)
        assert abs(cal.fx - cam.K[0, 0]) < 1.0
        assert float(np.linalg.norm(cal.C - (-cam.R.T @ cam.t))) < 0.5
        cal = _calibrated(cam, 1.0)
        assert float(np.linalg.norm(cal.C - (-cam.R.T @ cam.t))) < 20.0


def _settle(det, frame, t, n=6):
    """Feed the same frame enough times for the detector to settle."""
    out = None
    for i in range(n):
        o = det.process(frame, t + i * 0.05)
        out = o or out
    return out


def throw_session(n_throws=60, seed=3, jitter_px=0.7):
    rng = random.Random(seed)
    cams = synth.default_rig()
    dets = [detector.DartDetector(c.id, _calibrated(c, jitter_px)) for c in cams]
    fuser = detector.Fuser([c.id for c in cams], cals={d.camera_id: d.cal for d in dets})
    for c, d in zip(cams, dets):
        d.reset(c.render([]), empty=True)
    results = []
    t = 0.0
    darts = []
    for k in range(n_throws):
        if len(darts) == 3:
            darts = []
            events = []
            for c, d in zip(cams, dets):
                obs = _settle(d, c.render(darts), t)
                # a camera that rejected the last dart has nothing to
                # compare against and may stay silent; the others carry it
                if obs is not None:
                    assert obs.kind == detector.KIND_TAKEOUT, obs
                    ev = fuser.add(obs)
                    if ev:
                        events.append(ev)
            ev = fuser.tick(t + 5)
            if ev:
                events.append(ev)
            assert len(events) == 1 and events[0].kind == detector.KIND_TAKEOUT, events
            t += 2
        dart = synth.random_dart(rng)
        darts.append(dart)
        truth = board.score_at(dart.x, dart.y)
        events = []
        for c, d in zip(cams, dets):
            obs = _settle(d, c.render(darts), t)
            assert obs is not None, f'{c.id} saw nothing for dart {k}'
            ev = fuser.add(obs)
            if ev:
                events.append(ev)
        assert len(events) == 1, events
        ev = events[0]
        assert ev.kind == detector.KIND_DART
        err = math.hypot(ev.x - dart.x, ev.y - dart.y)
        results.append((truth, ev, err))
        t += 2
    return results


def test_three_camera_throws():
    res = throw_session()
    errs = [e for _, _, e in res]
    right = sum(1 for truth, ev, _ in res if ev.hit.label == truth.label)
    mean_err = sum(errs) / len(errs)
    # synthetic board, sub-pixel-ish clicks: triangulation should land
    # within a couple of millimetres, with only wire-line misses left
    assert mean_err < 2.5, mean_err
    assert max(errs) < 8.0, max(errs)
    assert right >= len(res) * 0.9, (right, len(res))
    assert all(ev.method == '3d' for _, ev, _ in res)


def test_blocked_hand_does_not_move_reference():
    cam = synth.default_rig()[0]
    det = detector.DartDetector(cam.id, _calibrated(cam, 0.5))
    det.reset(cam.render([]), empty=True)
    import cv2
    img = cam.render([])
    cv2.rectangle(img, (500, 100), (900, 600), (120, 90, 80), -1)  # an arm
    obs = _settle(det, img, 1.0)
    assert obs is not None and obs.kind == detector.KIND_BLOCKED
    # arm leaves, board is unchanged: nothing is reported, state is clean
    assert _settle(det, cam.render([]), 3.0) is None
    assert det.state == 'idle'


if __name__ == '__main__':
    test_scoring_rings()
    test_homography_roundtrip()
    test_pose_recovery()
    test_blocked_hand_does_not_move_reference()
    res = throw_session()
    right = sum(1 for truth, ev, _ in res if ev.hit.label == truth.label)
    errs = sorted(e for _, _, e in res)
    print(f'{right}/{len(res)} scored right; mean err {sum(errs)/len(errs):.2f} mm, '
          f'median {errs[len(errs)//2]:.2f}, max {errs[-1]:.2f}')
    for truth, ev, err in res:
        if ev.hit.label != truth.label:
            print(f'  truth {truth.label:6} got {ev.hit.label:6} err {err:5.1f} mm '
                  f'conf {ev.confidence:.2f} spread {ev.spread_mm:.1f}')
