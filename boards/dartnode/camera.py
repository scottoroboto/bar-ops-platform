"""Frame sources: the USB cameras on the board, and stand-ins for testing.

Every source hands out (frame, timestamp) pairs through `latest()`; the
detector polls that at its own pace, so a slow detector never backs up
the camera's buffer (a stale frame is worse than a dropped one here).

The OV9732 modules on the Omni do 1280x720 at 30 fps in MJPEG only; raw
YUV is capped at 10 fps over USB 2.0, so MJPEG is forced. Auto exposure,
auto gain and auto white balance are switched OFF at open: with the ring
light on, the scene is constant, and any of those "auto" loops hunting
between frames looks exactly like a dart arriving.
"""
from __future__ import annotations

import logging
import shutil
import subprocess
import threading
import time

import cv2
import numpy as np

log = logging.getLogger(__name__)


class FrameSource:
    id: str

    def latest(self) -> tuple[np.ndarray | None, float]:
        raise NotImplementedError

    def stop(self) -> None:
        pass

    @property
    def alive(self) -> bool:
        return True


class UsbCamera(FrameSource):
    """One V4L2 camera, grabbed continuously on its own thread."""

    def __init__(self, cam_id: str, device, width=1280, height=720, fps=15,
                 controls: dict | None = None, rotate: int = 0):
        self.id = cam_id
        self.device = device
        self.width, self.height, self.fps = width, height, fps
        self.controls = controls or {}
        self.rotate = rotate  # 0, 90, 180, 270 -- for a module mounted sideways
        self._frame: np.ndarray | None = None
        self._ts = 0.0
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._cap: cv2.VideoCapture | None = None
        self._errors = 0
        self._thread = threading.Thread(target=self._run, name=f'cam-{cam_id}', daemon=True)
        self._thread.start()

    # -- V4L2 -----------------------------------------------------------
    def _open(self) -> bool:
        dev = self.device
        cap = cv2.VideoCapture(dev, cv2.CAP_V4L2) if isinstance(dev, (str, int)) else None
        if cap is None or not cap.isOpened():
            log.warning('[%s] cannot open %s', self.id, dev)
            return False
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*'MJPG'))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.width)
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.height)
        cap.set(cv2.CAP_PROP_FPS, self.fps)
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
        self._cap = cap
        self._apply_controls()
        got_w = cap.get(cv2.CAP_PROP_FRAME_WIDTH)
        got_h = cap.get(cv2.CAP_PROP_FRAME_HEIGHT)
        log.info('[%s] open %s %dx%d @ %s fps', self.id, dev, got_w, got_h, cap.get(cv2.CAP_PROP_FPS))
        return True

    def _apply_controls(self) -> None:
        """Lock exposure/gain/white balance via v4l2-ctl. Control names
        differ between kernel versions, so each setting is tried under
        its old and new name and whichever the driver accepts wins."""
        if not isinstance(self.device, str) or not shutil.which('v4l2-ctl'):
            return
        wanted = {
            # manual exposure: 1 = manual on UVC
            'auto_exposure': 1, 'exposure_auto': 1,
            'white_balance_automatic': 0, 'white_balance_temperature_auto': 0,
            'gain_automatic': 0,
        }
        wanted.update(self.controls)  # e.g. exposure_time_absolute, gain, white_balance_temperature
        for name, value in wanted.items():
            r = subprocess.run(['v4l2-ctl', '-d', self.device, '-c', f'{name}={value}'],
                               capture_output=True, text=True)
            if r.returncode == 0:
                log.debug('[%s] %s=%s', self.id, name, value)

    def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            if self._cap is None and not self._open():
                time.sleep(backoff)
                backoff = min(backoff * 2, 10)
                continue
            backoff = 1.0
            ok, frame = self._cap.read()
            if not ok or frame is None:
                self._errors += 1
                if self._errors > 30:
                    log.warning('[%s] lost camera, reopening', self.id)
                    self._cap.release()
                    self._cap = None
                    self._errors = 0
                time.sleep(0.05)
                continue
            self._errors = 0
            if self.rotate:
                code = {90: cv2.ROTATE_90_CLOCKWISE, 180: cv2.ROTATE_180,
                        270: cv2.ROTATE_90_COUNTERCLOCKWISE}[self.rotate]
                frame = cv2.rotate(frame, code)
            with self._lock:
                self._frame = frame
                self._ts = time.time()
        if self._cap is not None:
            self._cap.release()

    def latest(self):
        with self._lock:
            return self._frame, self._ts

    @property
    def alive(self) -> bool:
        return self._cap is not None and (time.time() - self._ts) < 3.0

    def stop(self) -> None:
        self._stop.set()


class StaticSource(FrameSource):
    """Hands out whatever frame it was last given. The simulator and the
    tests drive the detector through this."""

    def __init__(self, cam_id: str, frame: np.ndarray | None = None):
        self.id = cam_id
        self._frame = frame
        self._ts = time.time()

    def set(self, frame: np.ndarray) -> None:
        self._frame = frame

    def latest(self):
        # a real camera keeps delivering the same scene; so does this
        return self._frame, time.time()


def list_v4l2_devices() -> list[dict]:
    """Enumerate /dev/video* with their names, for `dartnode list-cameras`."""
    import glob
    import os
    out = []
    for dev in sorted(glob.glob('/dev/video*')):
        name = ''
        try:
            base = os.path.basename(dev)
            with open(f'/sys/class/video4linux/{base}/name') as f:
                name = f.read().strip()
        except OSError:
            pass
        by_id = ''
        for link in glob.glob('/dev/v4l/by-id/*'):
            if os.path.realpath(link) == dev:
                by_id = link
        out.append({'device': dev, 'name': name, 'by_id': by_id})
    return out
