"""Accuracy harness: what the cameras said vs. what really happened.

Every dart event gets a folder under data/harness/<event_id>/ with each
camera's frame, the masks and the event JSON, so a miss can be replayed
and fixed later without the dart. The person at the board confirms or
corrects each one from the web UI (or lets the Omni/DartCounter be the
referee and only taps when the two disagree); the verdicts land in
log.csv, and `summary()` is the running hit rate.
"""
from __future__ import annotations

import csv
import json
import os
import threading
import time

import cv2

LOG_FIELDS = ['event_id', 't', 'predicted', 'truth', 'correct', 'x', 'y', 'confidence',
              'spread_mm', 'method', 'dart_index', 'note']


class Harness:
    def __init__(self, data_dir: str):
        self.dir = os.path.join(data_dir, 'harness')
        os.makedirs(self.dir, exist_ok=True)
        self.log_path = os.path.join(self.dir, 'log.csv')
        self._lock = threading.Lock()
        if not os.path.exists(self.log_path):
            with open(self.log_path, 'w', newline='') as f:
                csv.DictWriter(f, LOG_FIELDS).writeheader()

    def record(self, event_id: int, event: dict, frames: dict[str, 'cv2.Mat'],
               masks: dict[str, 'cv2.Mat | None']) -> None:
        d = os.path.join(self.dir, f'{event_id:06d}')
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, 'event.json'), 'w') as f:
            json.dump(event, f, indent=1)
        for cam_id, fr in frames.items():
            if fr is not None:
                cv2.imwrite(os.path.join(d, f'{cam_id}.jpg'), fr, [cv2.IMWRITE_JPEG_QUALITY, 92])
        for cam_id, m in masks.items():
            if m is not None:
                cv2.imwrite(os.path.join(d, f'{cam_id}_mask.png'), m)

    def verdict(self, event_id: int, event: dict, truth: str, note: str = '') -> dict:
        """truth is a label like 'T20', 'S5', 'D16', 'BULL', 'DBULL', 'MISS'."""
        predicted = event.get('label') or ''
        row = {
            'event_id': event_id, 't': event.get('t'), 'predicted': predicted,
            'truth': truth.upper(), 'correct': int(predicted == truth.upper()),
            'x': event.get('x'), 'y': event.get('y'), 'confidence': event.get('confidence'),
            'spread_mm': event.get('spread_mm'), 'method': event.get('method'),
            'dart_index': event.get('dart_index'), 'note': note,
        }
        with self._lock:
            with open(self.log_path, 'a', newline='') as f:
                csv.DictWriter(f, LOG_FIELDS).writerow(row)
            d = os.path.join(self.dir, f'{event_id:06d}')
            if os.path.isdir(d):
                with open(os.path.join(d, 'truth.json'), 'w') as f:
                    json.dump(row, f)
        return row

    def summary(self) -> dict:
        rows = []
        with self._lock:
            with open(self.log_path, newline='') as f:
                rows = list(csv.DictReader(f))
        n = len(rows)
        right = sum(int(r['correct'] or 0) for r in rows)
        misses = [r for r in rows if not int(r['correct'] or 0)]
        by_method = {}
        for r in rows:
            m = r.get('method') or '?'
            by_method.setdefault(m, [0, 0])
            by_method[m][0] += 1
            by_method[m][1] += int(r['correct'] or 0)
        return {
            'n': n, 'correct': right, 'rate': (right / n) if n else None,
            'by_method': {m: {'n': v[0], 'correct': v[1]} for m, v in by_method.items()},
            'recent_misses': [{'event_id': r['event_id'], 'predicted': r['predicted'],
                               'truth': r['truth'], 'spread_mm': r['spread_mm']}
                              for r in misses[-20:]],
            'updated': time.time(),
        }
