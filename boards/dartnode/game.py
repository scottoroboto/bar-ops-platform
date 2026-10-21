"""The game engine: turns board events into a game of darts.

Runs on the board node (the Pi), so a game never depends on the
internet. The board node feeds it the fused events (dart / removed /
takeout) and the players' button presses; the TV page just renders
`state()`.

Turn logic (the part that has to match how people actually behave at a
board -- see tests/test_scenarios.py for the camera side of it):

  THROWING --dart--> THROWING            (darts 1, 2)
  THROWING --3rd dart, bust, or checkout--> REMOVE  ("Remove darts")
  REMOVE   --removed--> REMOVE            (slow puller: "2 still in")
  REMOVE   --takeout--> next player, THROWING

- No clock on REMOVE. Darts stay in the board for two seconds or
  twenty minutes; the game waits.
- A dart landing in REMOVE (next player couldn't wait) is NOT scored:
  "Remove darts first". It comes out with the rest.
- A `removed` in THROWING is a dart that fell out: it stops counting
  (standard steel-tip: a dart must stay in the board until retrieved).
- A takeout in THROWING (grabbed the darts early) ends the turn with
  what was scored.
- NEXT is the manual turn-over for anything the cameras missed; FIX
  rewrites one of the last three darts and the scores are replayed.

x01 only for now (301/501/701/901, straight or double in, double or
straight out). Cricket is the next game.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

from . import board

PHASE_THROWING = 'throwing'
PHASE_REMOVE = 'remove'
PHASE_WON = 'won'

MAX_DARTS = 3

# Checkout preference: when several finishes exist, players want the
# conventional one (T20 first, then the big doubles).
_PREF_ORDER = (
    [('T', s) for s in (20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1)]
    + [('S', s) for s in (20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1)]
    + [('D', s) for s in (20, 16, 18, 12, 10, 8, 19, 17, 15, 14, 13, 11, 9, 7, 6, 5, 4, 3, 2, 1)]
    + [('BULL', 25), ('DBULL', 50)]
)
_DOUBLE_ORDER = [('D', s) for s in (20, 16, 18, 12, 10, 8, 19, 17, 15, 14, 13, 11, 9, 7, 6, 5, 4, 3, 2, 1)] + [('DBULL', 50)]


def _value(kind: str, n: int) -> int:
    if kind == 'T':
        return 3 * n
    if kind == 'D':
        return 2 * n
    if kind == 'BULL':
        return 25
    if kind == 'DBULL':
        return 50
    return n


def _label(kind: str, n: int) -> str:
    return kind if kind in ('BULL', 'DBULL') else f'{kind}{n}'


_ALL = _PREF_ORDER
_FINAL_RANK = {(k, n): i for i, (k, n) in enumerate(_DOUBLE_ORDER)}
_cache: dict = {}


def checkout(remaining: int, darts_left: int, double_out: bool = True) -> list[str] | None:
    """Shortest finish, ranked the way a chart would: fewest darts, then
    the big familiar doubles (D20, D16, D18...), then as few trebles as
    possible in the set-up (S20 D20 beats T18 D3 for 60)."""
    key = (remaining, darts_left, double_out)
    if key in _cache:
        return _cache[key]
    out = None
    if 0 < remaining and darts_left > 0:
        finals = _DOUBLE_ORDER if double_out else _ALL
        for n in range(1, darts_left + 1):
            paths = []
            _finishes(remaining, n, finals, [], paths)
            if paths:
                def rank(path):
                    fk, fn = path[-1]
                    setup = path[:-1]
                    # set-up darts: trebles cost a little, doubles a lot
                    # (nobody aims at a double to set up), odd singles a little
                    penalty = (sum(1 for k, _ in setup if k == 'T')
                               + 2 * sum(1 for k, _ in setup if k in ('D', 'DBULL'))
                               + sum(1 for k, v in setup if k == 'S' and v not in (20, 19, 18, 16)))
                    final = _FINAL_RANK.get((fk, fn), 50 if fk == 'S' else 60)
                    return (penalty, final)
                best = min(paths, key=rank)
                out = [_label(k, v) for k, v in best]
                break
    _cache[key] = out
    return out


def _finishes(remaining: int, n: int, finals, path, out) -> None:
    if n == 1:
        for kind, s in finals:
            if _value(kind, s) == remaining:
                out.append(path + [(kind, s)])
        return
    for kind, s in _ALL:
        v = _value(kind, s)
        if v < remaining:
            _finishes(remaining - v, n - 1, finals, path + [(kind, s)], out)


def parse_label(label: str) -> tuple[int, int, str]:
    """'T20' -> (20, 3, 'treble'); 'BULL' -> (25, 1, 'bull'); 'MISS' -> (0, 0, 'miss')."""
    s = (label or '').strip().upper()
    if s in ('MISS', '', '0'):
        return 0, 0, 'miss'
    if s == 'BULL':
        return 25, 1, 'bull'
    if s == 'DBULL':
        return 25, 2, 'dbull'
    kind, num = s[0], int(s[1:])
    mult = {'S': 1, 'D': 2, 'T': 3}[kind]
    return num, mult, {'S': 'single', 'D': 'double', 'T': 'treble'}[kind]


@dataclass
class Dart:
    label: str
    segment: int
    multiplier: int
    ring: str
    x: float | None = None
    y: float | None = None
    t: float = 0.0
    source: str = 'camera'     # camera | manual
    counted: bool = True       # False once it fell out
    ignored: bool = False      # landed while darts should have been pulled
    event_id: int | None = None

    @property
    def score(self) -> int:
        return self.segment * self.multiplier if self.counted and not self.ignored else 0

    @property
    def is_double(self) -> bool:
        return self.multiplier == 2

    def to_dict(self) -> dict:
        return {'label': self.label, 'score': self.score, 'counted': self.counted,
                'ignored': self.ignored, 'source': self.source, 'x': self.x, 'y': self.y}


@dataclass
class Player:
    name: str
    turns: list[list[Dart]] = field(default_factory=list)
    # derived by replay()
    remaining: int = 0
    in_game: bool = True
    darts_thrown: int = 0
    last_turn_score: int = 0
    last_turn_bust: bool = False

    def to_dict(self) -> dict:
        thrown = max(1, self.darts_thrown)
        scored = sum(d.score for t in self.turns for d in t)
        return {'name': self.name, 'remaining': self.remaining, 'in_game': self.in_game,
                'darts_thrown': self.darts_thrown, 'avg3': round(scored / thrown * 3, 1),
                'last_turn_score': self.last_turn_score, 'last_turn_bust': self.last_turn_bust,
                'turns': [[d.to_dict() for d in t] for t in self.turns[-8:]]}


class X01:
    def __init__(self, players: list[str], start: int = 501, double_in: bool = False,
                 double_out: bool = True):
        if not players:
            raise ValueError('need at least one player')
        self.players = [Player(n) for n in players]
        self.start = int(start)
        self.double_in = bool(double_in)
        self.double_out = bool(double_out)
        self.current = 0
        self.phase = PHASE_THROWING
        self.turn: list[Dart] = []
        self.winner: int | None = None
        self.message = ''
        self.flash = ''              # one-shot banner for the TV ("BUST!")
        self.started = time.time()
        self.finished: float | None = None
        self.log: list[dict] = []    # what happened, for the harness / platform
        self.darts_in_board = 0
        self.replay()

    # -- the rules --------------------------------------------------------
    def replay(self) -> None:
        """Recompute every score from the dart history. Corrections just
        edit history and call this, so the rules live in one place."""
        self.winner = None
        for p in self.players:
            p.remaining = self.start
            p.in_game = not self.double_in
            p.darts_thrown = 0
            p.last_turn_score = 0
            p.last_turn_bust = False
            for turn in p.turns:
                self._apply_turn(p, turn)
        # the turn in progress for the current player
        if self.turn:
            p = self.players[self.current]
            self._apply_turn(p, self.turn, in_progress=True)

    def _apply_turn(self, p: Player, turn: list[Dart], in_progress: bool = False) -> str:
        """Returns 'bust' | 'won' | 'ok'."""
        start_remaining = p.remaining
        start_in_game = p.in_game
        outcome = 'ok'
        for d in turn:
            p.darts_thrown += 1 if not d.ignored else 0
            if d.ignored or not d.counted:
                continue
            if not p.in_game:
                if d.is_double:
                    p.in_game = True
                else:
                    continue
            new = p.remaining - d.score
            bust = new < 0 or (self.double_out and new == 1) or \
                (new == 0 and self.double_out and not d.is_double)
            if bust:
                outcome = 'bust'
                break
            p.remaining = new
            if new == 0:
                outcome = 'won'
                break
        if outcome == 'bust':
            p.remaining = start_remaining
            p.in_game = start_in_game
        p.last_turn_score = start_remaining - p.remaining
        p.last_turn_bust = outcome == 'bust'
        if outcome == 'won':
            self.winner = self.players.index(p)
        return outcome

    # -- events from the board ------------------------------------------
    def on_event(self, ev: dict) -> None:
        kind = ev.get('kind')
        if kind == 'dart':
            self._on_dart(ev)
        elif kind == 'removed':
            self._on_removed(ev)
        elif kind == 'takeout':
            self._on_takeout()

    def _on_dart(self, ev: dict) -> None:
        label = ev.get('label') or 'MISS'
        seg, mult, ring = parse_label(label)
        d = Dart(label, seg, mult, ring, ev.get('x'), ev.get('y'), ev.get('t') or time.time(),
                 event_id=ev.get('id'))
        self.darts_in_board += 1
        if self.phase != PHASE_THROWING or len(self.turn) >= MAX_DARTS:
            d.ignored = True
            self.turn.append(d) if self.phase == PHASE_REMOVE else None
            self.flash = 'Remove darts first'
            self.message = 'Remove darts first' if self.phase != PHASE_WON else self.message
            self._log('dart_ignored', label=label)
            return
        self.turn.append(d)
        self._log('dart', label=label, player=self.players[self.current].name)
        self._after_dart()

    def _after_dart(self) -> None:
        p = self.players[self.current]
        self.replay()
        outcome = self._turn_outcome(p)
        if outcome == 'won':
            self.phase = PHASE_WON
            self.finished = time.time()
            self.flash = f'{p.name} wins!'
            self.message = f'{p.name} wins! Remove darts.'
            self._log('won', player=p.name)
        elif outcome == 'bust':
            self.phase = PHASE_REMOVE
            self.flash = 'BUST'
            self.message = f'Bust. Remove darts — next: {self._next_name()}'
            self._log('bust', player=p.name)
        elif len([d for d in self.turn if not d.ignored]) >= MAX_DARTS:
            self.phase = PHASE_REMOVE
            self.flash = ''
            self.message = f'Remove darts — next: {self._next_name()}'
        else:
            self.flash = ''
            self.message = ''

    def _turn_outcome(self, p: Player) -> str:
        if self.winner == self.players.index(p):
            return 'won'
        if p.last_turn_bust:
            return 'bust'
        return 'ok'

    def _on_removed(self, ev: dict) -> None:
        self.darts_in_board = max(0, self.darts_in_board - 1)
        if self.phase == PHASE_THROWING and self.turn:
            # a dart fell out: the one nearest where the removal was seen
            live = [d for d in self.turn if d.counted and not d.ignored]
            if not live:
                return
            x, y = ev.get('x'), ev.get('y')
            if x is not None and y is not None and any(d.x is not None for d in live):
                victim = min(live, key=lambda d: ((d.x or 0) - x) ** 2 + ((d.y or 0) - y) ** 2)
            else:
                victim = live[-1]
            victim.counted = False
            self.flash = f'{victim.label} fell out'
            self._log('fell_out', label=victim.label)
            self.replay()
            self.message = ''
        elif self.phase in (PHASE_REMOVE, PHASE_WON):
            left = ev.get('dart_index', self.darts_in_board)
            self.message = f'{left} still in — next: {self._next_name()}' if self.phase == PHASE_REMOVE else self.message

    def _on_takeout(self) -> None:
        self.darts_in_board = 0
        if self.phase == PHASE_WON:
            self.message = f'{self.players[self.winner].name} wins!'
            return
        if self.phase == PHASE_THROWING and not self.turn:
            return  # nothing was thrown; nothing to do
        self._end_turn(reason='takeout')

    # -- the buttons ------------------------------------------------------
    def next_player(self) -> None:
        """NEXT: the turn is over whatever the cameras think."""
        if self.phase == PHASE_WON:
            return
        self._end_turn(reason='manual')
        self.darts_in_board = 0

    def correct(self, which: int, label: str) -> bool:
        """FIX: rewrite one of the last three darts thrown (1 = most
        recent). Scores are replayed from history. Returns False if there
        is no such dart."""
        recent = self._recent_darts()
        if which < 1 or which > len(recent):
            return False
        d = recent[which - 1]
        seg, mult, ring = parse_label(label)
        old = d.label
        d.label, d.segment, d.multiplier, d.ring = (label.upper() if label else 'MISS'), seg, mult, ring
        d.counted = True
        d.source = 'manual'
        self._log('corrected', was=old, now=d.label)
        self.replay()
        # the phase follows the corrected history: a bust can become a
        # live turn, a live turn a win, and the reverse
        if self.winner is not None:
            self.phase = PHASE_WON
            self.finished = self.finished or time.time()
            self.message = f'{self.players[self.winner].name} wins! Remove darts.'
        elif self.turn:
            p = self.players[self.current]
            counted = len([x for x in self.turn if not x.ignored])
            if p.last_turn_bust or counted >= MAX_DARTS:
                self.phase = PHASE_REMOVE
                self.message = ('Bust. ' if p.last_turn_bust else '') + f'Remove darts — next: {self._next_name()}'
            else:
                self.phase = PHASE_THROWING
                self.message = ''
            self.finished = None
        elif self.phase == PHASE_WON:
            self.phase = PHASE_THROWING
            self.finished = None
            self.message = ''
        self.flash = f'Fixed: {old} → {d.label}'
        return True

    def add_manual_dart(self, label: str) -> None:
        """For boards without cameras, or a dart the cameras missed."""
        self._on_dart({'label': label, 'kind': 'dart', 't': time.time()})
        if self.turn:
            self.turn[-1].source = 'manual'

    # -- internals ----------------------------------------------------------
    def _end_turn(self, reason: str) -> None:
        p = self.players[self.current]
        kept = [d for d in self.turn if not d.ignored]
        p.turns.append(kept)
        self._log('turn_end', player=p.name, darts=[d.label for d in kept],
                  score=sum(d.score for d in kept), reason=reason)
        self.turn = []
        self.current = (self.current + 1) % len(self.players)
        self.phase = PHASE_THROWING
        self.replay()
        self.flash = ''
        self.message = ''

    def _next_name(self) -> str:
        return self.players[(self.current + 1) % len(self.players)].name

    def _recent_darts(self) -> list[Dart]:
        """Last three real darts, most recent first, across the turn boundary."""
        seq = []
        for i, p in enumerate(self.players):
            for ti, t in enumerate(p.turns):
                for di, d in enumerate(t):
                    seq.append((d.t, d))
        for d in self.turn:
            if not d.ignored:
                seq.append((d.t, d))
        seq.sort(key=lambda x: x[0], reverse=True)
        return [d for _, d in seq[:3]]

    def _log(self, what: str, **kw) -> None:
        self.log.append({'t': time.time(), 'what': what, **kw})

    # -- for the TV -----------------------------------------------------------
    def state(self) -> dict:
        p = self.players[self.current]
        darts_left = MAX_DARTS - len([d for d in self.turn if not d.ignored])
        hint = None
        if self.phase == PHASE_THROWING and p.in_game:
            hint = checkout(p.remaining, darts_left, self.double_out)
        return {
            'kind': 'x01', 'start': self.start, 'double_in': self.double_in, 'double_out': self.double_out,
            'phase': self.phase, 'current': self.current, 'winner': self.winner,
            'players': [pl.to_dict() for pl in self.players],
            'turn': [d.to_dict() for d in self.turn],
            'darts_left': darts_left, 'darts_in_board': self.darts_in_board,
            'checkout': hint, 'message': self.message, 'flash': self.flash,
            'recent': [d.to_dict() for d in self._recent_darts()],
            'started': self.started, 'finished': self.finished,
        }
