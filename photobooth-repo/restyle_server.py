#!/usr/bin/env python3
"""
Photobooth restyle sidecar (Phase 2B) — a tiny local model server.

The booth (running on localhost) POSTs one "hero" frame here during the review
screen and gets back a restyled version. Two tiers of styles:

  classical (OpenCV, always available, ~100-300 ms):
    oil      — oil painting (cv2.xphoto.oilPainting)
    sketch   — pencil sketch (cv2.pencilSketch)
    cartoon  — bilateral smoothing + bold edges

  neural (ONNX fast-neural-style, auto-downloaded on first run, ~0.3-1 s):
    mosaic, candy — the classic PyTorch fast_neural_style models. They ship
    with a FIXED 224x224 input; being fully convolutional, we patch the graph
    input to dynamic H/W once after download and run at real resolution.

Run:
    pip3 install -r requirements-restyle.txt
    python3 restyle_server.py            # http://127.0.0.1:8123

API:
    GET  /health   -> {ok, styles:[...], neural:{mosaic:"ready"|...}}
    POST /restyle  {image:<dataURL>, style:"oil"} -> {ok, image:<dataURL>, ms}

Latency budget: input is downscaled to <=800 px (classical) / <=640 px
(neural) on the long side before styling — a strip cell is ~1080 px wide at
export, so the upscale is invisible in print and the review stays snappy.
"""
import base64, io, os, re, threading, time, urllib.request

import numpy as np
import cv2
from PIL import Image
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

PORT = int(os.environ.get("RESTYLE_PORT", "8123"))
ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(ROOT, "models")

# ---- neural models (ONNX zoo; ~6.7 MB each) --------------------------------
NEURAL = {
    "mosaic": "https://media.githubusercontent.com/media/onnx/models/main/validated/vision/style_transfer/fast_neural_style/model/mosaic-9.onnx",
    "candy":  "https://media.githubusercontent.com/media/onnx/models/main/validated/vision/style_transfer/fast_neural_style/model/candy-9.onnx",
}
neural_sessions = {}          # name -> onnxruntime.InferenceSession
neural_status = {n: "loading" for n in NEURAL}

def _patch_dynamic(src, dst):
    """fns models declare 1x3x224x224; they're conv-only, so make H/W dynamic."""
    import onnx
    m = onnx.load(src)
    d = m.graph.input[0].type.tensor_type.shape.dim
    d[0].dim_param, d[2].dim_param, d[3].dim_param = "n", "h", "w"
    for o in m.graph.output:
        od = o.type.tensor_type.shape.dim
        for i in range(len(od)):
            od[i].dim_param = f"d{i}"
    onnx.save(m, dst)

def _load_neural():
    try:
        import onnxruntime as ort
        ort.set_default_logger_severity(3)
    except Exception:
        for n in NEURAL: neural_status[n] = "onnxruntime not installed"
        return
    os.makedirs(MODEL_DIR, exist_ok=True)
    for name, url in NEURAL.items():
        dyn = os.path.join(MODEL_DIR, f"{name}-dyn.onnx")
        raw = os.path.join(MODEL_DIR, f"{name}-9.onnx")
        try:
            if not os.path.exists(dyn):
                if not os.path.exists(raw):
                    print(f"[restyle] downloading {name} model…")
                    urllib.request.urlretrieve(url, raw + ".part")
                    os.replace(raw + ".part", raw)
                _patch_dynamic(raw, dyn)
            so = ort.SessionOptions(); so.log_severity_level = 3
            neural_sessions[name] = ort.InferenceSession(dyn, so, providers=["CPUExecutionProvider"])
            neural_status[name] = "ready"
            print(f"[restyle] neural style ready: {name}")
        except Exception as e:
            neural_status[name] = f"unavailable ({type(e).__name__})"
            print(f"[restyle] {name} not available: {e}")

# ---- image helpers ----------------------------------------------------------
DATAURL_RE = re.compile(r"^data:image/(png|jpe?g);base64,(.+)$", re.S)

def dataurl_to_bgr(du):
    m = DATAURL_RE.match(du or "")
    if not m: raise ValueError("expected a PNG/JPEG data URL")
    img = Image.open(io.BytesIO(base64.b64decode(m.group(2)))).convert("RGB")
    return cv2.cvtColor(np.array(img), cv2.COLOR_RGB2BGR)

def bgr_to_dataurl(bgr, q=90):
    ok, buf = cv2.imencode(".jpg", bgr, [cv2.IMWRITE_JPEG_QUALITY, q])
    if not ok: raise RuntimeError("encode failed")
    return "data:image/jpeg;base64," + base64.b64encode(buf.tobytes()).decode()

def shrink(bgr, longest):
    h, w = bgr.shape[:2]
    s = longest / max(h, w)
    if s >= 1: return bgr
    return cv2.resize(bgr, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)

# ---- styles -----------------------------------------------------------------
def style_oil(bgr):
    return cv2.xphoto.oilPainting(shrink(bgr, 800), 7, 1)

def style_sketch(bgr):
    gray, _ = cv2.pencilSketch(shrink(bgr, 800), sigma_s=60, sigma_r=0.07, shade_factor=0.06)
    return cv2.cvtColor(gray, cv2.COLOR_GRAY2BGR)

def style_cartoon(bgr):
    img = shrink(bgr, 800)
    color = img
    for _ in range(2):
        color = cv2.bilateralFilter(color, 9, 75, 75)
    hsv = cv2.cvtColor(color, cv2.COLOR_BGR2HSV).astype(np.int16)
    hsv[..., 1] = np.clip(hsv[..., 1] * 1.25, 0, 255)          # saturation pop
    color = cv2.cvtColor(hsv.astype(np.uint8), cv2.COLOR_HSV2BGR)
    gray = cv2.medianBlur(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), 7)
    edges = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 9, 2)
    return cv2.bitwise_and(color, color, mask=edges)

def style_neural(name):
    def run(bgr):
        sess = neural_sessions.get(name)
        if sess is None: raise RuntimeError(f"{name} model not loaded yet")
        img = shrink(bgr, 640)
        h, w = img.shape[:2]
        img = img[: h // 4 * 4, : w // 4 * 4]                   # stride-4 safe
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32)
        x = rgb.transpose(2, 0, 1)[None]                        # 1x3xHxW, 0..255
        y = sess.run(None, {sess.get_inputs()[0].name: x})[0][0]
        out = np.clip(y.transpose(1, 2, 0), 0, 255).astype(np.uint8)
        return cv2.cvtColor(out, cv2.COLOR_RGB2BGR)
    return run

STYLES = {
    "oil":     ("Oil paint",  style_oil),
    "sketch":  ("Pencil",     style_sketch),
    "cartoon": ("Cartoon",    style_cartoon),
    "mosaic":  ("Mosaic",     style_neural("mosaic")),
    "candy":   ("Candy",      style_neural("candy")),
}

# ---- API --------------------------------------------------------------------
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])

class RestyleReq(BaseModel):
    image: str
    style: str

@app.get("/health")
def health():
    ready = [k for k, (label, _) in STYLES.items()
             if k not in NEURAL or neural_status.get(k) == "ready"]
    return {"ok": True, "styles": [{"id": k, "name": STYLES[k][0]} for k in ready],
            "neural": neural_status}

@app.post("/restyle")
def restyle(req: RestyleReq):
    if req.style not in STYLES:
        return {"ok": False, "error": f"unknown style '{req.style}'"}
    try:
        t0 = time.time()
        bgr = dataurl_to_bgr(req.image)
        out = STYLES[req.style][1](bgr)
        ms = int((time.time() - t0) * 1000)
        return {"ok": True, "image": bgr_to_dataurl(out), "ms": ms, "style": req.style}
    except Exception as e:
        return {"ok": False, "error": str(e)}

if __name__ == "__main__":
    threading.Thread(target=_load_neural, daemon=True).start()
    print(f"[restyle] sidecar on http://127.0.0.1:{PORT}  (classical styles ready now; neural load in background)")
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
