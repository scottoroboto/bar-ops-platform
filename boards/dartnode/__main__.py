"""CLI:  python -m dartnode run|simulate|list-cameras [--config boards/config.json]"""
from __future__ import annotations

import argparse
import logging
import os
import signal
import sys
import time


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog='dartnode', description='TSB Darts board node')
    ap.add_argument('--config', default=os.environ.get('DARTNODE_CONFIG', 'config.json'))
    ap.add_argument('-v', '--verbose', action='store_true')
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('run', help='real cameras, from the config file')
    sim = sub.add_parser('simulate', help='virtual cameras that throw darts by themselves')
    sim.add_argument('--precalibrated', action='store_true', help='skip the calibration step')
    sim.add_argument('--interval', type=float, default=3.0, help='seconds between throws')
    sub.add_parser('list-cameras', help='show /dev/video* devices')
    args = ap.parse_args(argv)

    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format='%(asctime)s %(levelname)s %(name)s: %(message)s', datefmt='%H:%M:%S')
    log = logging.getLogger('dartnode')

    if args.cmd == 'list-cameras':
        from .camera import list_v4l2_devices
        devs = list_v4l2_devices()
        if not devs:
            print('no /dev/video* devices found')
        for d in devs:
            print(f"{d['device']:14} {d['name']:40} {d['by_id']}")
        print('\nUse the /dev/v4l/by-id/... path in config.json so cameras keep their identity across reboots.')
        return 0

    from .node import load_config, Node
    from .web import serve

    cfg = load_config(args.config)
    thrower = None
    if args.cmd == 'simulate':
        from .simulate import build
        cfg['data_dir'] = cfg.get('sim_data_dir') or os.path.join(cfg['data_dir'], 'sim')
        node, thrower = build(cfg, precalibrated=args.precalibrated, interval_s=args.interval)
    else:
        if not cfg['cameras']:
            log.error('no cameras in %s -- copy config.example.json to config.json and fill in the devices', args.config)
            return 2
        node = Node(cfg)

    node.start()
    httpd = serve(node, int(cfg.get('http_port', 8090)))
    if thrower:
        thrower.start()
    log.info('board %s running; open http://<this box>:%s/', node.board_id, cfg.get('http_port', 8090))

    stop = []
    signal.signal(signal.SIGINT, lambda *_: stop.append(1))
    signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
    while not stop:
        time.sleep(0.5)
    log.info('stopping')
    if thrower:
        thrower.stop()
    node.stop()
    httpd.shutdown()
    return 0


if __name__ == '__main__':
    sys.exit(main())
