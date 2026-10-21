"""The board node's own web pages, served on the Pi (default :8090).

  /                  live view: every camera with overlays, the event
                     log, "board is empty", and the harness verdict
                     buttons for the last dart
  /calibrate/<cam>   click the wire/ring points on a snapshot, solve, save
  /stream/<cam>      MJPEG with overlays (what the debug view embeds)
  /snap/<cam>.jpg    one frame (?overlay=1 draws the calibration rings)
  /api/...           JSON, see `_api`

Standard library only (no Flask) so the Pi needs nothing beyond OpenCV.
"""
from __future__ import annotations

import json
import logging
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import cv2
import numpy as np

from . import board
from . import calibration as calib
from .node import Node

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------
# Overlay drawing
# ---------------------------------------------------------------------
def draw_overlay(node: Node, cam_id: str, frame: np.ndarray) -> np.ndarray:
    img = frame.copy()
    cal = node.cals.get(cam_id)
    det = node.detectors.get(cam_id)
    if cal is not None and cal.ready:
        for p in calib.board_overlay_polylines(cal):
            cv2.polylines(img, [p.reshape(-1, 1, 2)], False, (0, 200, 0), 1, cv2.LINE_AA)
        for tid, (px, py) in cal.clicks.items():
            cv2.drawMarker(img, (int(px), int(py)), (255, 160, 0), cv2.MARKER_CROSS, 10, 1)
    if det is not None:
        obs = det.last_obs
        if obs is not None and obs.bbox:
            x, y, w, h = obs.bbox
            col = (0, 220, 255) if obs.kind == 'dart' else (0, 0, 255)
            cv2.rectangle(img, (x, y), (x + w, y + h), col, 1)
            if obs.axis:
                x0, y0, vx, vy = obs.axis
                p1 = (int(x0 - 400 * vx), int(y0 - 400 * vy))
                p2 = (int(x0 + 400 * vx), int(y0 + 400 * vy))
                cv2.line(img, p1, p2, (255, 0, 255), 1, cv2.LINE_AA)
            if obs.px is not None:
                cv2.circle(img, (int(obs.px), int(obs.py)), 5, (0, 0, 255), 2)
        txt = f'{cam_id}  {det.state}  darts:{det.darts_seen}'
        if cal is not None and cal.has_pose:
            txt += f'  fx:{cal.fx:.0f}'
        cv2.putText(img, txt, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 3, cv2.LINE_AA)
        cv2.putText(img, txt, (8, 22), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def jpeg(img: np.ndarray, max_w: int | None = None, quality: int = 80) -> bytes:
    if max_w and img.shape[1] > max_w:
        s = max_w / img.shape[1]
        img = cv2.resize(img, (max_w, int(img.shape[0] * s)), interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode('.jpg', img, [cv2.IMWRITE_JPEG_QUALITY, quality])
    return buf.tobytes() if ok else b''


# ---------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------
CSS = """
:root{--bg:#0f1720;--card:#172231;--line:#243244;--fg:#e6edf3;--mut:#8b9bb0;--ok:#39d98a;--warn:#f0c265;--bad:#ff6b6b;--acc:#4ea1ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.4 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{display:flex;gap:14px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--line);background:#0b121a;position:sticky;top:0;z-index:2}
header h1{font-size:17px;margin:0}header a{color:var(--acc);text-decoration:none}.sp{flex:1}
main{padding:14px;display:grid;gap:14px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.cams{display:grid;grid-template-columns:repeat(auto-fit,minmax(380px,1fr));gap:12px}.cams img{width:100%;border-radius:6px;background:#000;display:block}
.cam h3{margin:0 0 6px;font-size:14px;display:flex;gap:8px;align-items:center}.cam h3 a,.cam h3 a:visited{color:#04111f;background:var(--acc);padding:5px 12px;border-radius:8px;text-decoration:none;font-weight:600}.badge{font-size:11px;padding:2px 7px;border-radius:99px;background:#223044;color:var(--mut)}
.badge.ok{background:#17382b;color:var(--ok)}.badge.bad{background:#3d1f1f;color:var(--bad)}.badge.warn{background:#3b3220;color:var(--warn)}
button{background:#223044;color:var(--fg);border:1px solid #2f4058;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer}button:hover{background:#2a3b52}
button.primary{background:var(--acc);border-color:var(--acc);color:#04111f;font-weight:600}button.danger{border-color:#6b2f2f;color:var(--bad)}
.big{font-size:44px;font-weight:700;line-height:1}.mut{color:var(--mut)}.row{display:flex;gap:10px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:4px 6px;border-bottom:1px solid var(--line);text-align:left}
.grid20{display:grid;grid-template-columns:repeat(10,1fr);gap:5px}.grid20 button{padding:8px 0}
.seg{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:6px}
#canvasWrap{position:relative}#calCanvas{width:100%;display:block;border-radius:6px;background:#000;cursor:crosshair;touch-action:none}
.targets{max-height:60vh;overflow:auto}.targets div{padding:5px 8px;border-radius:6px;cursor:pointer;display:flex;justify-content:space-between}
.targets div.cur{background:#223044}.targets div.done{color:var(--ok)}.targets div.bad{color:var(--bad)}
.log{max-height:40vh;overflow:auto;font-family:ui-monospace,Menlo,monospace;font-size:12px}
"""

INDEX_HTML = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>TSB Darts — board node</title><style>@@CSS@@</style></head><body>
<header><h1>TSB Darts · <span id="boardId">board</span></h1><span class="badge" id="up"></span><span class="sp"></span>
<button id="btnEmpty" title="Take fresh reference frames: the board has NO darts in it right now">Board is empty</button>
<button id="btnPause">Pause</button></header>
<main>
<div class="card"><div class="row"><div><div class="mut">Last dart</div><div class="big" id="last">—</div><div class="mut" id="lastMeta"></div></div>
<div class="sp"></div><div id="simTruth" class="mut"></div>
<div><div class="mut">Harness</div><div id="hsum">—</div></div></div>
<div id="verdict" style="margin-top:10px;display:none">
<div class="mut">Was that right? Tap what it really was (or ✓ if correct).</div>
<div class="row" style="margin-top:6px"><button class="primary" id="vOk">✓ correct</button>
<button data-t="MISS">Miss</button><button data-t="BULL">Bull (25)</button><button data-t="DBULL">D-Bull (50)</button>
<span class="mut">Ring:</span><button data-ring="S" class="ring">Single</button><button data-ring="D" class="ring">Double</button><button data-ring="T" class="ring">Treble</button></div>
<div class="grid20" id="nums"></div></div></div>
<div class="cams" id="cams"></div>
<div class="card"><h3 style="margin:0 0 8px">Events</h3><div class="log" id="log"></div></div>
</main>
<script>
const $=id=>document.getElementById(id);let since=0,lastDart=null,ring='S',paused=false;
async function j(u,o){const r=await fetch(u,o);return r.json()}
function esc(s){return String(s??'').replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))}
async function status(){const s=await j('/api/status');$('boardId').textContent=s.board_id;$('up').textContent='up '+Math.round(s.uptime_s/60)+' min · '+s.loops+' loops';
paused=s.paused;$('btnPause').textContent=paused?'Resume':'Pause';
const cams=$('cams');if(cams.children.length!==s.cameras.length){cams.innerHTML=s.cameras.map(c=>`<div class="card cam" id="cam-${c.id}"><h3>${esc(c.id)} <span class="st"></span><span class="sp"></span><a href="/calibrate/${encodeURIComponent(c.id)}">calibrate</a></h3><img src="/stream/${encodeURIComponent(c.id)}?overlay=1&t=${Date.now()}"></div>`).join('')}
for(const c of s.cameras){const el=document.querySelector(`#cam-${CSS.escape(c.id)} .st`);if(!el)continue;
el.innerHTML=`<span class="badge ${c.alive?'ok':'bad'}">${c.alive?'live':'no signal'}</span> <span class="badge ${c.posed?'ok':(c.calibrated?'warn':'bad')}">${c.posed?'calibrated · '+c.reprojection_mm.toFixed(1)+' mm':(c.calibrated?'calibrated (no pose)':'not calibrated')}</span> <span class="badge">${c.state}</span>`}
if(s.publisher.enabled)$('up').textContent+=' · cloud sent '+s.publisher.sent+(s.publisher.failed?' failed '+s.publisher.failed:'')}
async function events(){const ev=await j('/api/events?since='+since);for(const e of ev){since=e.id;const d=new Date(e.t*1000).toLocaleTimeString();let line;
if(e.kind==='dart'){line=`${d}  DART ${e.dart_index}: <b>${e.label||'?'}</b>  (${(e.x||0).toFixed(0)}, ${(e.y||0).toFixed(0)}) conf ${e.confidence} spread ${e.spread_mm} mm ${e.method}`;lastDart=e;$('last').textContent=e.label||'?';
$('lastMeta').textContent=`dart ${e.dart_index} · ${e.method} · conf ${e.confidence} · spread ${e.spread_mm} mm · #${e.id}`;$('verdict').style.display='block'}
else if(e.kind==='takeout'){line=`${d}  TAKEOUT`;$('verdict').style.display='none'}else if(e.kind==='removed'){line=`${d}  removed one dart, ${e.dart_index} left`}else{line=`${d}  ${e.kind} ${e.cameras.map(c=>c.camera_id+':'+c.kind+(c.note?'('+c.note+')':'')).join(' ')}`}
const div=document.createElement('div');div.innerHTML=line;$('log').prepend(div)}
try{const t=await j('/api/sim/truth');if(t.truth)$('simTruth').innerHTML='<div class="mut">Simulator truth</div><div>'+t.truth.join(' · ')+'</div>'}catch(e){}}
async function hsum(){const h=await j('/api/harness/summary');$('hsum').innerHTML=h.n?`<b>${h.correct}/${h.n}</b> right (${(h.rate*100).toFixed(1)}%)`:'no verdicts yet'}
async function verdict(t){if(!lastDart)return;await j('/api/harness/'+lastDart.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({truth:t})});$('verdict').style.display='none';hsum()}
$('vOk').onclick=()=>verdict(lastDart.label);document.querySelectorAll('[data-t]').forEach(b=>b.onclick=()=>verdict(b.dataset.t));
document.querySelectorAll('.ring').forEach(b=>b.onclick=()=>{ring=b.dataset.ring;document.querySelectorAll('.ring').forEach(x=>x.classList.toggle('primary',x===b))});
document.querySelector('.ring').classList.add('primary');
$('nums').innerHTML=[20,1,18,4,13,6,10,15,2,17,3,19,7,16,8,11,14,9,12,5].map(n=>`<button data-n="${n}">${n}</button>`).join('');
document.querySelectorAll('[data-n]').forEach(b=>b.onclick=()=>verdict(ring+b.dataset.n));
$('btnEmpty').onclick=async()=>{await j('/api/reset',{method:'POST'});};$('btnPause').onclick=async()=>{await j('/api/pause',{method:'POST',body:JSON.stringify({paused:!paused})});status()};
status();events();hsum();setInterval(status,2000);setInterval(events,700);
</script></body></html>"""

CAL_HTML = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Calibrate @@CAM@@</title><style>@@CSS@@</style></head><body>
<header><h1><a href="/">&larr; board</a> &nbsp; Calibrate <b>@@CAM@@</b></h1><span class="sp"></span>
<button id="btnSnap">New snapshot</button><button id="btnClear" class="danger">Clear clicks</button><button id="btnSolve" class="primary">Solve &amp; save</button></header>
<main style="grid-template-columns:2fr 1fr">
<div class="card"><div id="canvasWrap"><canvas id="calCanvas"></canvas></div>
<p class="mut">Tap the point named on the right as precisely as you can — zoom the page if you need to. The green rings appear once there are 4 points; they should sit exactly on the real wires. 8–12 points spread around the board is plenty. Points you can't see from this camera: just skip.</p>
<div id="result" class="mut"></div></div>
<div class="card"><div class="row" style="margin-bottom:8px"><b>Points</b><span class="sp"></span><button id="btnBack">&larr; Back</button><button id="btnUndo">Undo tap</button><button id="btnSkip">Skip &rarr;</button></div><div class="targets" id="targets"></div></div>
</main>
<script>
const cam=@@CAM_JSON@@,$=id=>document.getElementById(id);let targets=[],clicks={},cur=0,img=new Image(),overlay=false,resid={};
async function j(u,o){const r=await fetch(u,o);return r.json()}
const cv=$('calCanvas'),ctx=cv.getContext('2d');
function load(){img.onload=()=>{cv.width=img.naturalWidth;cv.height=img.naturalHeight;draw()};img.src='/snap/'+encodeURIComponent(cam)+'.jpg?overlay='+(overlay?1:0)+'&t='+Date.now()}
function draw(){ctx.drawImage(img,0,0);for(const [id,p] of Object.entries(clicks)){const t=targets.find(x=>x.id===id);ctx.strokeStyle=id===targets[cur]?.id?'#4ea1ff':'#ffa000';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(p[0]-8,p[1]);ctx.lineTo(p[0]+8,p[1]);ctx.moveTo(p[0],p[1]-8);ctx.lineTo(p[0],p[1]+8);ctx.stroke();ctx.fillStyle='#fff';ctx.font='12px sans-serif';ctx.fillText(t?t.short:id,p[0]+6,p[1]-6)}}
function badLimit(){const v=Object.values(resid).sort((a,b)=>a-b);if(!v.length)return 1e9;const med=v[Math.floor(v.length/2)];return Math.max(4,3*med)}
function list(){const lim=badLimit();$('targets').innerHTML=targets.map((t,i)=>{const r=resid[t.id];const bad=r!==undefined&&r>lim;return `<div class="${i===cur?'cur':''} ${clicks[t.id]?(bad?'bad':'done'):''}" data-i="${i}"><span>${t.name}</span><span>${r!==undefined?r.toFixed(1)+' mm ':''}${clicks[t.id]?(bad?'✗ re-tap':'✓'):''}</span></div>`}).join('');
document.querySelectorAll('#targets div').forEach(d=>d.onclick=()=>{cur=+d.dataset.i;list();draw()});const c=document.querySelector('#targets .cur');if(c)c.scrollIntoView({block:'nearest'})}
cv.addEventListener('pointerdown',e=>{const r=cv.getBoundingClientRect();const x=(e.clientX-r.left)*cv.width/r.width,y=(e.clientY-r.top)*cv.height/r.height;
const t=targets[cur];if(!t)return;clicks[t.id]=[x,y];history.push(t.id);cur=Math.min(cur+1,targets.length-1);list();draw();if(Object.keys(clicks).length>=4)solve(false)});
$('btnSkip').onclick=()=>{cur=(cur+1)%targets.length;list();draw()};
$('btnBack').onclick=()=>{cur=(cur-1+targets.length)%targets.length;list();draw()};
let history=[];
$('btnUndo').onclick=()=>{const id=history.pop();if(!id)return;delete clicks[id];cur=targets.findIndex(t=>t.id===id);list();draw();if(Object.keys(clicks).length>=4)solve(false)};$('btnSnap').onclick=load;
$('btnClear').onclick=()=>{if(confirm('Clear all clicks for this camera?')){clicks={};cur=0;overlay=false;list();load()}};
async function solve(save){const r=await j('/api/calibration/'+encodeURIComponent(cam),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clicks,save,image_size:[cv.width,cv.height]})});
resid=r.residuals||{};list();
const lim=badLimit(),nbad=Object.values(resid).filter(v=>v>lim).length;
$('result').innerHTML=r.ready?`<span style="color:var(--ok)">Solved${save?' and saved':''}.</span> fit error <b>${r.reprojection_mm.toFixed(2)} mm</b> over ${r.clicks} points`+(nbad?` · <span style="color:var(--bad)">${nbad} point${nbad>1?'s':''} marked ✗ in the list look wrong — tap each one, then re-tap it on the picture (or Undo/Clear)</span>`:'')+(r.posed?` · lens fx ${r.fx.toFixed(0)} px · camera at (${r.camera_mm.map(Math.round).join(', ')}) mm`:' · <span style="color:var(--warn)">pose not solved</span>'):'Need at least 4 points.';overlay=r.ready;load()}
$('btnSolve').onclick=()=>solve(true);
(async()=>{targets=await j('/api/targets');const c=await j('/api/calibration/'+encodeURIComponent(cam));clicks=c.clicks||{};resid=c.residuals||{};overlay=!!c.ready;list();load()})();
</script></body></html>"""


# ---------------------------------------------------------------------
# Server
# ---------------------------------------------------------------------
def make_handler(node: Node):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = 'HTTP/1.1'

        def log_message(self, fmt, *args):  # quieter than the default
            log.debug('%s ' + fmt, self.address_string(), *args)

        # -- helpers ----------------------------------------------------
        def _send(self, code: int, body: bytes, ctype: str = 'text/html; charset=utf-8'):
            self.send_response(code)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)

        def _json(self, obj, code=200):
            self._send(code, json.dumps(obj).encode(), 'application/json')

        def _body(self) -> dict:
            n = int(self.headers.get('Content-Length') or 0)
            if not n:
                return {}
            try:
                return json.loads(self.rfile.read(n) or b'{}')
            except json.JSONDecodeError:
                return {}

        # -- routing ----------------------------------------------------
        def do_GET(self):
            u = urllib.parse.urlsplit(self.path)
            q = urllib.parse.parse_qs(u.query)
            parts = [urllib.parse.unquote(p) for p in u.path.strip('/').split('/') if p]
            if not parts:
                return self._send(200, INDEX_HTML.replace('@@CSS@@', CSS).encode())
            if parts[0] == 'calibrate' and len(parts) == 2 and parts[1] in node.sources:
                page = (CAL_HTML.replace('@@CSS@@', CSS).replace('@@CAM_JSON@@', json.dumps(parts[1]))
                        .replace('@@CAM@@', parts[1].replace('<', '&lt;')))
                return self._send(200, page.encode())
            if parts[0] == 'stream' and len(parts) == 2:
                return self._stream(parts[1], q.get('overlay', ['1'])[0] == '1')
            if parts[0] == 'snap' and len(parts) == 2:
                cid = parts[1][:-4] if parts[1].endswith('.jpg') else parts[1]
                src = node.sources.get(cid)
                frame, _ = src.latest() if src else (None, 0)
                if frame is None:
                    return self._send(404, b'no frame', 'text/plain')
                if q.get('overlay', ['0'])[0] == '1':
                    frame = draw_overlay(node, cid, frame)
                return self._send(200, jpeg(frame, quality=92), 'image/jpeg')
            if parts[0] == 'api':
                return self._api('GET', parts[1:], q, {})
            self._send(404, b'not found', 'text/plain')

        def do_POST(self):
            u = urllib.parse.urlsplit(self.path)
            parts = [urllib.parse.unquote(p) for p in u.path.strip('/').split('/') if p]
            if parts and parts[0] == 'api':
                return self._api('POST', parts[1:], {}, self._body())
            self._send(404, b'not found', 'text/plain')

        def _api(self, method: str, parts: list[str], q: dict, body: dict):
            if parts == ['status']:
                return self._json(node.status())
            if parts == ['events']:
                since = int(q.get('since', ['0'])[0])
                return self._json(node.events_since(since))
            if parts == ['targets']:
                out = []
                for t in board.calibration_targets():
                    short = t['id'].upper() if t['id'] == 'bull' else t['name'].split('wire ')[-1]
                    out.append({**t, 'short': ('D ' if t['id'].startswith('do') else 'T ') + short
                                if t['id'] != 'bull' else 'BULL'})
                return self._json(out)
            if parts == ['reset'] and method == 'POST':
                node.reset_empty()
                return self._json({'ok': True})
            if parts == ['pause'] and method == 'POST':
                node.paused = bool(body.get('paused'))
                return self._json({'ok': True, 'paused': node.paused})
            if len(parts) == 2 and parts[0] == 'calibration' and parts[1] in node.sources:
                cid = parts[1]
                if method == 'GET':
                    cal = node.cals[cid]
                    d = cal.to_dict()
                    d['ready'] = cal.ready
                    return self._json(d)
                cal = calib.Calibration(cid)
                cal.clicks = {k: (float(v[0]), float(v[1])) for k, v in (body.get('clicks') or {}).items()}
                if body.get('image_size'):
                    cal.image_size = (int(body['image_size'][0]), int(body['image_size'][1]))
                else:
                    frame, _ = node.sources[cid].latest()
                    if frame is not None:
                        cal.image_size = (frame.shape[1], frame.shape[0])
                ready = cal.solve()
                if ready and body.get('save', True):
                    node.set_calibration(cal)
                return self._json({'ready': ready, 'clicks': len(cal.clicks),
                                   'reprojection_mm': cal.reprojection_mm, 'posed': cal.has_pose,
                                   'residuals': cal.residuals,
                                   'fx': cal.fx, 'camera_mm': cal.C.tolist() if cal.has_pose else None})
            if parts == ['harness', 'summary']:
                return self._json(node.harness.summary())
            if len(parts) == 2 and parts[0] == 'harness' and method == 'POST':
                eid = int(parts[1])
                ev = node.event(eid)
                if ev is None:
                    return self._json({'error': 'unknown event'}, 404)
                return self._json(node.harness.verdict(eid, ev, body.get('truth', ''), body.get('note', '')))
            if parts == ['sim', 'truth']:
                th = getattr(node, 'sim_truth', None)
                return self._json({'truth': list(th.truth) if th else None})
            self._json({'error': 'not found'}, 404)

        def _stream(self, cid: str, overlay: bool):
            src = node.sources.get(cid)
            if src is None:
                return self._send(404, b'no such camera', 'text/plain')
            self.send_response(200)
            self.send_header('Content-Type', 'multipart/x-mixed-replace; boundary=frame')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            last = None
            try:
                while True:
                    frame, ts = src.latest()
                    if frame is None or ts == last:
                        time.sleep(0.05)
                        continue
                    last = ts
                    if overlay:
                        frame = draw_overlay(node, cid, frame)
                    data = jpeg(frame, max_w=800, quality=70)
                    self.wfile.write(b'--frame\r\nContent-Type: image/jpeg\r\nContent-Length: '
                                     + str(len(data)).encode() + b'\r\n\r\n' + data + b'\r\n')
                    self.wfile.flush()
                    time.sleep(0.1)
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    return Handler


def serve(node: Node, port: int, bind: str = '0.0.0.0') -> ThreadingHTTPServer:
    httpd = ThreadingHTTPServer((bind, port), make_handler(node))
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, name='http', daemon=True).start()
    log.info('board node web UI on http://%s:%d/', bind, port)
    return httpd
