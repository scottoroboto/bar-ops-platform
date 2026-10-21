"""The board node: owns the cameras, detectors, fuser, event log, harness
and publisher, and runs the detection loop on its own thread. The web UI
(web.py) and the CLI (__main__.py) only talk to this object.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque

import numpy as np

from . import calibration as calib
from .camera import FrameSource, UsbCamera
from .detector import DartDetector, DetectorConfig, Fuser, KIND_DART, KIND_TAKEOUT
from .harness import Harness
from .publisher import Publisher

log = logging.getLogger(__name__)

DEFAULT_CONFIG = {
    'board_id': 'home-1',
    'http_port': 8090,
    'data_dir': 'data',
    'cloud': {'url': '', 'token': ''},
    'cameras': [],
    'detector': {},
    'fuser': {'window_s': 0.8, 'agree_mm': 10.0, 'min_cameras': 2},
    'loop_hz': 15,
}


def load_config(path: str | None) -> dict:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if path and os.path.exists(path):
        with open(path) as f:
            user = json.load(f)
        for k, v in user.items():
            if isinstance(v, dict) and isinstance(cfg.get(k), dict):
                cfg[k].update(v)
            else:
                cfg[k] = v
    return cfg


class Node:
    def __init__(self, config: dict, sources: list[FrameSource] | None = None):
        self.config = config
        self.board_id = config['board_id']
        self.data_dir = config['data_dir']
        os.makedirs(self.data_dir, exist_ok=True)
        self.det_cfg = DetectorConfig.from_dict(config.get('detector'))

        if sources is None:
            sources = [UsbCamera(c['id'], c.get('device', i), c.get('width', 1280), c.get('height', 720),
                                 c.get('fps', 15), c.get('controls'), c.get('rotate', 0))
                       for i, c in enumerate(config['cameras'])]
        self.sources: dict[str, FrameSource] = {s.id: s for s in sources}
        self.cals: dict[str, calib.Calibration] = {
            cid: calib.load(self.data_dir, cid) for cid in self.sources}
        self.detectors: dict[str, DartDetector] = {
            cid: DartDetector(cid, self.cals[cid], self.det_cfg) for cid in self.sources}
        f = config['fuser']
        self.fuser = Fuser(list(self.sources), f.get('window_s', 0.8), f.get('agree_mm', 10.0),
                           f.get('min_cameras', 2), cals=self.cals)
        self.harness = Harness(self.data_dir)
        cloud = config.get('cloud') or {}
        self.publisher = Publisher(cloud.get('url'), cloud.get('token'), self.board_id)

        self.events: deque = deque(maxlen=500)   # (id, dict)
        self.event_seq = 0
        self._last_ts: dict[str, float] = {}
        self._last_frames: dict[str, np.ndarray] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.started = time.time()
        self.loop_count = 0
        self.paused = False
        self._thread = threading.Thread(target=self._loop, name='detect', daemon=True)

    # -- lifecycle ------------------------------------------------------
    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        for s in self.sources.values():
            s.stop()

    def _loop(self) -> None:
        period = 1.0 / max(1, self.config.get('loop_hz', 15))
        while not self._stop.is_set():
            t0 = time.time()
            if not self.paused:
                self.step()
            self.loop_count += 1
            dt = time.time() - t0
            if dt < period:
                time.sleep(period - dt)

    def step(self) -> None:
        """One pass over every camera. Public so the simulator and tests
        can drive it without the thread."""
        now = time.time()
        for cid, src in self.sources.items():
            frame, ts = src.latest()
            if frame is None or ts == self._last_ts.get(cid):
                continue
            self._last_ts[cid] = ts
            self._last_frames[cid] = frame
            obs = self.detectors[cid].process(frame, ts)
            if obs is not None:
                log.debug('[%s] %s %s', cid, obs.kind, obs.note)
                self._emit(self.fuser.add(obs, now))
        self._emit(self.fuser.tick(now))

    def _emit(self, ev) -> None:
        if ev is None:
            return
        d = ev.to_dict()
        d['board_id'] = self.board_id
        with self._lock:
            self.event_seq += 1
            eid = self.event_seq
            d['id'] = eid
            self.events.append((eid, d))
        if ev.kind == KIND_DART:
            log.info('DART %s  (%.1f, %.1f) conf %.2f spread %.1f %s',
                     d.get('label'), ev.x or 0, ev.y or 0, ev.confidence, ev.spread_mm, ev.method)
            self.harness.record(eid, d, dict(self._last_frames),
                                {c: det.last_mask for c, det in self.detectors.items()})
        elif ev.kind == KIND_TAKEOUT:
            log.info('TAKEOUT')
        else:
            # rejected scenes are the interesting ones while tuning: keep the frames
            log.info('BLOCKED %s', '; '.join(f"{c['camera_id']}: {c['note']}" for c in d['cameras']))
            self.harness.record(eid, d, dict(self._last_frames),
                                {c: det.last_mask for c, det in self.detectors.items()})
        self.publisher.publish(d)

    # -- control from the UI --------------------------------------------
    def reset_empty(self) -> None:
        """The board has no darts in it right now: take new references."""
        for cid, det in self.detectors.items():
            frame, _ = self.sources[cid].latest()
            if frame is not None:
                det.reset(frame, empty=True)
        self.fuser.dart_index = 0
        self.fuser._pending.clear()

    def set_calibration(self, cal: calib.Calibration) -> None:
        self.cals[cal.camera_id] = cal
        self.fuser.set_calibration(cal)
        self.detectors[cal.camera_id].set_calibration(cal)
        calib.save(self.data_dir, cal)

    def events_since(self, since: int) -> list[dict]:
        with self._lock:
            return [d for i, d in self.events if i > since]

    def event(self, eid: int) -> dict | None:
        with self._lock:
            for i, d in self.events:
                if i == eid:
                    return d
        return None

    def status(self) -> dict:
        cams = []
        for cid, src in self.sources.items():
            cal = self.cals.get(cid)
            det = self.detectors[cid]
            cams.append({
                'id': cid, 'alive': src.alive, 'state': det.state, 'darts_seen': det.darts_seen,
                'calibrated': bool(cal and cal.ready), 'posed': bool(cal and cal.has_pose),
                'reprojection_mm': cal.reprojection_mm if cal else None,
                'clicks': len(cal.clicks) if cal else 0,
                'fx': cal.fx if cal and cal.has_pose else None,
                'camera_mm': [round(float(v)) for v in cal.C] if cal and cal.has_pose else None,
            })
        return {'board_id': self.board_id, 'uptime_s': round(time.time() - self.started),
                'loops': self.loop_count, 'paused': self.paused, 'cameras': cams,
                'dart_index': self.fuser.dart_index, 'events': self.event_seq,
                'publisher': self.publisher.status()}
