"""Sends board events up to TSB Platform.

Plain HTTPS POSTs with a bearer token, queued and retried, so a wobble
in the bar's internet never loses a dart; the game engine on the server
side owns turns and games, this just reports what landed. With no cloud
URL configured it only logs, which is how the prototype runs at home.
"""
from __future__ import annotations

import json
import logging
import queue
import threading
import time
import urllib.error
import urllib.request

log = logging.getLogger(__name__)


class Publisher:
    def __init__(self, url: str | None, token: str | None, board_id: str, timeout: float = 5.0):
        self.url = (url or '').rstrip('/')
        self.token = token or ''
        self.board_id = board_id
        self.timeout = timeout
        self.enabled = bool(self.url)
        self._q: queue.Queue = queue.Queue(maxsize=1000)
        self.sent = 0
        self.failed = 0
        self.last_error = ''
        if self.enabled:
            threading.Thread(target=self._run, name='publisher', daemon=True).start()

    def publish(self, event: dict) -> None:
        if not self.enabled:
            return
        try:
            self._q.put_nowait(event)
        except queue.Full:
            self.failed += 1

    def _run(self) -> None:
        endpoint = f'{self.url}/api/darts/boards/{self.board_id}/events'
        while True:
            ev = self._q.get()
            body = json.dumps(ev).encode()
            delay = 1.0
            for attempt in range(6):
                req = urllib.request.Request(endpoint, data=body, method='POST', headers={
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {self.token}',
                })
                try:
                    with urllib.request.urlopen(req, timeout=self.timeout) as r:
                        r.read()
                    self.sent += 1
                    self.last_error = ''
                    break
                except (urllib.error.URLError, OSError) as e:
                    self.last_error = str(e)
                    log.warning('publish failed (%s), retry in %.0fs', e, delay)
                    time.sleep(delay)
                    delay = min(delay * 2, 30)
            else:
                self.failed += 1

    def status(self) -> dict:
        return {'enabled': self.enabled, 'queued': self._q.qsize(), 'sent': self.sent,
                'failed': self.failed, 'last_error': self.last_error}
