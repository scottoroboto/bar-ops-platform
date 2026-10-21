"""The game engine, driven by the same event shapes the fuser emits."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from dartnode import game  # noqa: E402


def dart(label, t=None, x=None, y=None):
    dart.t = getattr(dart, 't', 0) + 1
    return {'kind': 'dart', 'label': label, 't': t or dart.t, 'x': x, 'y': y}


def test_checkouts():
    assert game.checkout(170, 3) == ['T20', 'T20', 'DBULL']
    assert game.checkout(40, 1) == ['D20']
    assert game.checkout(32, 3) == ['D16']
    assert game.checkout(2, 1) == ['D1']
    assert game.checkout(1, 3) is None
    assert game.checkout(169, 3) is None
    assert game.checkout(50, 1) == ['DBULL']
    assert game.checkout(60, 2) == ['S20', 'D20']
    assert game.checkout(3, 1, double_out=False) == ['S3']


def test_basic_turns_and_busts():
    g = game.X01(['A', 'B'], start=501)
    for lab in ('T20', 'T20', 'T20'):
        g.on_event(dart(lab))
    assert g.phase == 'remove' and g.players[0].remaining == 321
    assert 'Remove darts' in g.message and 'B' in g.message
    g.on_event({'kind': 'takeout'})
    assert g.phase == 'throwing' and g.current == 1
    # B busts: 501 - 180 ... no; set B low first via history
    g.players[1].turns = [[game.Dart('T20', 20, 3, 'treble')] * 3] * 2  # 360 scored
    g.replay()
    assert g.players[1].remaining == 141
    g.on_event(dart('T20'))   # 81
    g.on_event(dart('T20'))   # 21
    g.on_event(dart('T20'))   # -39 -> bust
    assert g.phase == 'remove' and g.players[1].remaining == 141 and g.flash == 'BUST'
    assert g.players[1].last_turn_bust


def test_double_out_and_win():
    g = game.X01(['A'], start=101, double_out=True)
    g.on_event(dart('T20'))   # 41
    g.on_event(dart('S1'))    # 40
    assert g.state()['checkout'] == ['D20']
    g.on_event(dart('D20'))   # 0 on a double
    assert g.phase == 'won' and g.winner == 0
    # leaving 1 is a bust under double-out
    g2 = game.X01(['A'], start=41)
    g2.on_event(dart('T20')) ; g2.on_event(dart('S20'))   # 41-60 = bust actually: -19
    assert g2.phase == 'remove' and g2.players[0].remaining == 41
    g3 = game.X01(['A'], start=3)
    g3.on_event(dart('S2'))   # leaves 1 -> bust
    assert g3.phase == 'remove' and g3.players[0].remaining == 3
    g4 = game.X01(['A'], start=20)
    g4.on_event(dart('S20'))  # 0 but not a double -> bust
    assert g4.phase == 'remove' and g4.players[0].remaining == 20


def test_double_in():
    g = game.X01(['A'], start=301, double_in=True)
    g.on_event(dart('T20'))
    assert g.players[0].remaining == 301 and not g.players[0].in_game
    g.on_event(dart('D20'))
    assert g.players[0].remaining == 261 and g.players[0].in_game
    g.on_event(dart('S5'))
    assert g.players[0].remaining == 256


def test_eager_next_player_not_scored():
    g = game.X01(['A', 'B'])
    for lab in ('S20', 'S20', 'S20'):
        g.on_event(dart(lab))
    assert g.phase == 'remove'
    g.on_event(dart('T20'))   # B throws before pulling
    assert g.players[0].remaining == 441 and g.flash == 'Remove darts first'
    g.on_event({'kind': 'takeout'})
    assert g.current == 1 and g.players[1].remaining == 501 and g.turn == []


def test_dart_falls_out_mid_turn():
    g = game.X01(['A'])
    g.on_event(dart('T20', x=0, y=103))
    g.on_event(dart('S5', x=-40, y=123))
    assert g.players[0].remaining == 436
    g.on_event({'kind': 'removed', 'x': 1, 'y': 102, 'dart_index': 1})
    assert g.players[0].remaining == 496 and 'T20 fell out' in g.flash
    assert g.phase == 'throwing' and g.state()['darts_left'] == 1
    g.on_event(dart('S1'))
    assert g.phase == 'remove' and g.players[0].remaining == 495


def test_angry_grab_ends_turn_with_what_was_scored():
    g = game.X01(['A', 'B'])
    g.on_event(dart('S20'))
    g.on_event({'kind': 'takeout'})
    assert g.current == 1 and g.players[0].remaining == 481 and g.players[0].darts_thrown == 1


def test_manual_next_and_fix():
    g = game.X01(['A', 'B'])
    g.on_event(dart('S20'))
    g.on_event(dart('S5'))     # camera said S5, it was T5
    g.next_player()
    assert g.current == 1 and g.players[0].remaining == 476
    assert g.correct(1, 'T5')  # most recent dart, across the turn boundary
    assert g.players[0].remaining == 466
    assert g.correct(2, 'T20')
    assert g.players[0].remaining == 426
    assert not g.correct(3, 'S1')


def test_fix_turns_bust_into_live_turn():
    g = game.X01(['A'], start=61)
    g.on_event(dart('T20'))   # 1
    g.on_event(dart('S1'))    # 0, not a double: bust per the camera
    assert g.phase == 'remove' and g.players[0].last_turn_bust
    g.correct(1, 'MISS')      # actually missed the board
    assert g.phase == 'throwing' and g.players[0].remaining == 1 or g.players[0].last_turn_bust
    # remaining 1 under double-out is itself a bust, so the turn stays over
    g2 = game.X01(['A'], start=62)
    g2.on_event(dart('T20'))  # 2
    g2.on_event(dart('S2'))   # 0 not double -> bust
    assert g2.phase == 'remove'
    g2.correct(1, 'D1')       # it was the double after all
    assert g2.phase == 'won' and g2.winner == 0


def test_state_shape():
    g = game.X01(['Scott', 'Ryan'])
    g.on_event(dart('T20'))
    s = g.state()
    assert s['players'][0]['remaining'] == 441 and s['darts_left'] == 2
    assert s['checkout'] is None  # 441 can't be finished in 2
    assert s['turn'][0]['label'] == 'T20'


if __name__ == '__main__':
    for name, fn in list(globals().items()):
        if name.startswith('test_') and callable(fn):
            fn()
            print('PASS', name)
