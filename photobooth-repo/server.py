#!/usr/bin/env python3
"""Photobooth · V0.5 — local collection backend (Python stdlib, no dependencies).

Same contract as server.mjs: serves the app + POST /api/session that writes
sessions/<YYYY-MM-DD_id>/{strip.png, frame-N.jpg, metadata.json}, plus
GET /api/health. Use whichever runtime you have installed.

Run:  python3 server.py      (optional: PORT=8099 python3 server.py)
"""
import http.server, socketserver, os, json, base64, re, secrets, datetime, mimetypes
from urllib.parse import urlparse, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
SESSIONS = os.path.join(ROOT, "sessions")
PORT = int(os.environ.get("PORT", "8099"))
MAX_BODY = 80 * 1024 * 1024

def new_id():
    return f"{datetime.date.today().isoformat()}_{secrets.token_hex(3)}"  # 2026-07-16_ab12cd

def data_url_to_bytes(s):
    m = re.match(r"^data:([^;]+);base64,(.*)$", s or "", re.S)
    return base64.b64decode(m.group(2)) if m else None

def save_session(payload):
    sid = new_id()
    d = os.path.join(SESSIONS, sid)
    os.makedirs(d, exist_ok=True)
    files = []
    strip = data_url_to_bytes(payload.get("strip"))
    if strip:
        with open(os.path.join(d, "strip.png"), "wb") as f: f.write(strip)
        files.append("strip.png")
    frames = payload.get("frames") or []
    for i, fr in enumerate(frames):
        b = data_url_to_bytes(fr)
        if b is None: continue
        name = f"frame-{i+1}.jpg"
        with open(os.path.join(d, name), "wb") as f: f.write(b)
        files.append(name)
    boom_name = None
    boom = payload.get("boomerang")
    if boom:
        bm = re.match(r"^data:(video/(?:webm|mp4));base64,", boom)
        if bm:
            boom_name = "boomerang." + bm.group(1).split("/")[1]
            with open(os.path.join(d, boom_name), "wb") as f:
                f.write(data_url_to_bytes(boom))
            files.append(boom_name)
    meta = {
        "id": sid,
        "createdAt": payload.get("createdAt") or datetime.datetime.utcnow().isoformat() + "Z",
        "savedAt": datetime.datetime.utcnow().isoformat() + "Z",
        "numPhotos": payload.get("numPhotos", len(frames)),
        "strip": "strip.png" if strip else None,
        "frames": [f for f in files if f.startswith("frame-")],
        **(payload.get("meta") or {}),
        **({"boomerangPath": f"{sid}/{boom_name}"} if boom_name else {}),
    }
    with open(os.path.join(d, "metadata.json"), "w") as f: json.dump(meta, f, indent=2)
    files.append("metadata.json")
    return {"id": sid, "dir": os.path.relpath(d, ROOT), "files": files}

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, code, body=b"", ctype="text/plain"):
        if isinstance(body, str): body = body.encode()
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD": self.wfile.write(body)
    def _json(self, code, obj): self._send(code, json.dumps(obj), "application/json")
    def do_OPTIONS(self): self._send(204)
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            return self._json(200, {"ok": True, "sessionsDir": os.path.relpath(SESSIONS, ROOT)})
        if path == "/api/sessions":
            try:
                out = []
                for sid in os.listdir(SESSIONS):
                    d = os.path.join(SESSIONS, sid)
                    if not os.path.isdir(d): continue
                    meta = {}
                    mp = os.path.join(d, "metadata.json")
                    if os.path.isfile(mp):
                        try: meta = json.load(open(mp))
                        except Exception: meta = {}
                    files = [f for f in os.listdir(d) if f != "metadata.json"]
                    frames = sorted(f for f in files if re.match(r"^frame-\d+\.jpg$", f))
                    boom_f = next((f for f in files if re.match(r"^boomerang\.(webm|mp4)$", f)), None)
                    out.append({
                        "id": sid,
                        "createdAt": meta.get("createdAt"),
                        "numPhotos": meta.get("numPhotos", len(frames)),
                        "background": meta.get("background"),
                        "strip": f"/sessions/{sid}/strip.png" if "strip.png" in files else None,
                        "boomerang": f"/sessions/{sid}/{boom_f}" if boom_f else None,
                        "frames": [f"/sessions/{sid}/{f}" for f in frames],
                        "meta": meta,
                    })
                out.sort(key=lambda s: (s.get("createdAt") or "", s["id"]), reverse=True)
                return self._json(200, {"ok": True, "sessions": out})
            except Exception as e:
                return self._json(500, {"ok": False, "error": str(e)})
        rel = "index.html" if path in ("/", "/photobooth.html") else unquote(path.lstrip("/"))
        fp = os.path.normpath(os.path.join(ROOT, rel))
        if not fp.startswith(ROOT): return self._send(403, "forbidden")
        if not os.path.isfile(fp): return self._send(404, "not found")
        ctype = "application/wasm" if fp.endswith(".wasm") else (mimetypes.guess_type(fp)[0] or "application/octet-stream")
        with open(fp, "rb") as f: self._send(200, f.read(), ctype)
    def do_POST(self):
        if urlparse(self.path).path != "/api/session": return self._send(404, "not found")
        n = int(self.headers.get("Content-Length", "0"))
        if n > MAX_BODY: return self._json(400, {"ok": False, "error": "body too large"})
        try:
            payload = json.loads(self.rfile.read(n).decode("utf-8"))
            res = save_session(payload)
            print(f"[saved] {res['id']} ({', '.join(res['files'])})")
            self._json(200, {"ok": True, **res})
        except Exception as e:
            self._json(400, {"ok": False, "error": str(e)})

if __name__ == "__main__":
    os.makedirs(SESSIONS, exist_ok=True)
    mimetypes.add_type("text/javascript", ".mjs")
    mimetypes.add_type("video/webm", ".webm")
    print(f"\n\U0001F4F8  Photobooth · local collection server (Python)")
    print(f"    open  ->  http://localhost:{PORT}/")
    print(f"    saves ->  {SESSIONS}/<id>/\n")
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    with socketserver.ThreadingTCPServer(("", PORT), Handler) as httpd:
        httpd.serve_forever()
