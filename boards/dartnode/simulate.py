"""`dartnode simulate`: the node running on virtual cameras that throw
darts by themselves. Lets the web UI, calibration flow and harness be
used end to end on a laptop with nothing plugged in.

The virtual cameras start UNCALIBRATED, exactly like real ones, so the
calibration page can be exercised for real (the rings only line up once
the right points are clicked). `--precalibrated` skips that.
"""
from __future__ import annotations

import logging
import random
import threading
import time

from . import calibration as calib
from . import synth
from .camera import StaticSource
from .node import Node

log = logging.getLogger(__name__)


class Thrower(threading.Thread):
    """Throws three darts, pauses, pulls them, repeats."""

    def __init__(self, cams: list[synth.VirtualCamera], sources: dict[str, StaticSource],
                 interval_s: float = 3.0, seed: int = 1):
        super().__init__(name='thrower', daemon=True)
        self.cams, self.sources, self.interval = cams, sources, interval_s
        self.rng = random.Random(seed)
        self.darts: list[synth.Dart] = []
        self.truth: list[str] = []
        self._stop = threading.Event()

    def render(self) -> None:
        for c in self.cams:
            self.sources[c.id].set(c.render(self.darts))

    def run(self) -> None:
        from . import board
        self.render()
        time.sleep(2.0)
        while not self._stop.is_set():
            if len(self.darts) == 3:
                self.darts = []
                self.truth = []
                log.info('sim: pulling darts')
            else:
                d = synth.random_dart(self.rng)
                self.darts.append(d)
                label = board.score_at(d.x, d.y).label
                self.truth.append(label)
                log.info('sim: threw %s', label)
            # a few "moving" frames so the detector sees motion, then still
            for _ in range(3):
                for c in self.cams:
                    noisy = c.render(self.darts)
                    self.sources[c.id].set(noisy)
                time.sleep(0.1)
            self.render()
            time.sleep(self.interval)

    def stop(self) -> None:
        self._stop.set()


def build(config: dict, precalibrated: bool = False, interval_s: float = 3.0) -> tuple[Node, Thrower]:
    canvas = synth.BoardCanvas()
    cams = synth.default_rig(canvas)
    sources = {c.id: StaticSource(c.id) for c in cams}
    for c in cams:
        sources[c.id].set(c.render([]))
    config = dict(config)
    config['board_id'] = config.get('board_id') or 'sim'
    node = Node(config, sources=list(sources.values()))
    if precalibrated:
        for c in cams:
            cal = calib.Calibration(c.id, clicks=c.fake_clicks(jitter_px=0.5), image_size=c.size)
            cal.solve()
            node.set_calibration(cal)
    thrower = Thrower(cams, sources, interval_s=interval_s)
    node.sim_truth = thrower  # the UI shows the real answer next to the guess
    return node, thrower
