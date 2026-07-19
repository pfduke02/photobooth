"""Generate attractive 1280x720 photobooth backgrounds (license-free, procedural)."""
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import math, os, random

W, H = 1280, 720
OUT = "/root/photobooth/assets/backgrounds"
os.makedirs(OUT, exist_ok=True)
yy, xx = np.mgrid[0:H, 0:W]

def to_img(a): return Image.fromarray(np.clip(a, 0, 255).astype("uint8"), "RGB")
def save(img, name): img.convert("RGB").save(f"{OUT}/{name}", quality=88)

def vgrad(top, bottom):
    t = (yy / (H - 1))[..., None]
    return np.array(top, float) * (1 - t) + np.array(bottom, float) * t

def add_glow(img, cx, cy, r, color, strength=1.0):
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(layer).ellipse([cx - r, cy - r, cx + r, cy + r],
                                  fill=tuple(color) + (int(255 * strength),))
    layer = layer.filter(ImageFilter.GaussianBlur(r * 0.55))
    return Image.alpha_composite(img.convert("RGBA"), layer)

# 1) Studio — soft radial gray vignette (the flattering "pro" backdrop)
cx, cy = W * 0.5, H * 0.42
dd = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2); dd /= dd.max()
save(to_img(np.array([126, 130, 140]) * (1 - dd[..., None]) +
            np.array([32, 34, 42]) * dd[..., None]), "studio.jpg")

# 2) Sunset — purple-to-warm gradient with a soft sun
img = to_img(vgrad([46, 24, 78], [244, 146, 84]))
img = add_glow(img, W * 0.72, H * 0.34, 150, (255, 205, 130), 0.95)
save(img, "sunset.jpg")

# 3) Beach — sky / sea / sand bands with sun
arr = vgrad([120, 190, 235], [205, 232, 250])
sea, sand = int(H * 0.55), int(H * 0.72)
arr[sea:sand] = vgrad([26, 120, 160], [64, 172, 202])[sea:sand]
arr[sand:] = vgrad([232, 216, 172], [208, 188, 138])[sand:]
img = add_glow(to_img(arr), W * 0.28, H * 0.24, 95, (255, 244, 200), 0.9)
save(img, "beach.jpg")

# 4) Neon city — skyline silhouette, lit windows, bokeh
random.seed(4)
img = to_img(vgrad([10, 10, 28], [36, 20, 56]))
d = ImageDraw.Draw(img)
x = 0
while x < W:
    bw, bh = random.randint(46, 112), random.randint(120, 350)
    top = H - bh
    d.rectangle([x, top, x + bw, H], fill=(16, 16, 38))
    for wy in range(top + 12, H - 8, 22):
        for wx in range(x + 8, x + bw - 8, 18):
            if random.random() < 0.5:
                d.rectangle([wx, wy, wx + 6, wy + 10],
                            fill=random.choice([(120, 220, 255), (255, 140, 220), (255, 220, 120)]))
    x += bw + random.randint(6, 20)
img = add_glow(img, W * 0.5, H * 0.8, 320, (120, 40, 160), 0.45).convert("RGBA")
bk = Image.new("RGBA", (W, H), (0, 0, 0, 0)); bd = ImageDraw.Draw(bk)
for _ in range(60):
    r = random.randint(6, 26); px, py = random.randint(0, W), random.randint(0, int(H * 0.6))
    bd.ellipse([px - r, py - r, px + r, py + r],
               fill=random.choice([(120, 220, 255), (255, 140, 220), (255, 220, 120)]) + (90,))
save(Image.alpha_composite(img, bk.filter(ImageFilter.GaussianBlur(6))), "neon.jpg")

# 5) Bokeh — warm golden party lights
random.seed(9)
dd = np.sqrt((xx - W * 0.5) ** 2 + (yy - H * 0.5) ** 2); dd /= dd.max()
img = to_img(np.array([62, 42, 22]) * (1 - dd[..., None]) +
             np.array([14, 9, 6]) * dd[..., None]).convert("RGBA")
bk = Image.new("RGBA", (W, H), (0, 0, 0, 0)); bd = ImageDraw.Draw(bk)
for _ in range(90):
    r = random.randint(8, 40); px, py = random.randint(0, W), random.randint(0, H)
    bd.ellipse([px - r, py - r, px + r, py + r],
               fill=random.choice([(255, 210, 120), (255, 180, 90), (255, 236, 172)]) + (random.randint(40, 120),))
save(Image.alpha_composite(img, bk.filter(ImageFilter.GaussianBlur(7))), "bokeh.jpg")

# 6) Galaxy — nebula + stars
random.seed(3)
img = to_img(vgrad([6, 8, 20], [14, 10, 28])).convert("RGBA")
neb = Image.new("RGBA", (W, H), (0, 0, 0, 0)); nd = ImageDraw.Draw(neb)
for col, px, py, r in [((80, 40, 140), W * 0.4, H * 0.5, 260),
                       ((30, 80, 150), W * 0.62, H * 0.44, 220),
                       ((150, 50, 110), W * 0.5, H * 0.56, 180)]:
    nd.ellipse([px - r, py - r, px + r, py + r], fill=col + (70,))
img = Image.alpha_composite(img, neb.filter(ImageFilter.GaussianBlur(80)))
st = Image.new("RGBA", (W, H), (0, 0, 0, 0)); sd = ImageDraw.Draw(st)
for _ in range(320):
    px, py = random.randint(0, W), random.randint(0, H); r = random.choice([0, 0, 1, 1, 2])
    b = random.randint(160, 255)
    sd.ellipse([px - r, py - r, px + r, py + r], fill=(b, b, 255, random.randint(120, 255)))
save(Image.alpha_composite(img, st), "galaxy.jpg")

# 7) Wedding — elegant named backdrop. Everything sits inside the central 4:3
#    "safe zone" (x 200..1080) so the names survive the strip's center-crop,
#    and the middle is kept open so a subject standing in front doesn't cover them.
SERIF = "/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf"
SERIF_IT = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Italic.ttf"
def _font(p, s):
    try: return ImageFont.truetype(p, s)
    except Exception: return ImageFont.load_default()
def _tracked_w(d, text, font, tr):
    return sum((d.textbbox((0,0),c,font=font)[2]-d.textbbox((0,0),c,font=font)[0])+tr for c in text) - (tr if text else 0)
def _center(d, cx, y, text, font, fill, tr=0):
    x = cx - _tracked_w(d, text, font, tr)/2
    for c in text:
        d.text((x,y), c, font=font, fill=fill)
        x += (d.textbbox((0,0),c,font=font)[2]-d.textbbox((0,0),c,font=font)[0]) + tr
def _sprig(d, x, y, direction=1, color=(159,174,138)):
    pts=[(x+direction*(t/10)*72, y-math.sin((t/10)*math.pi)*7) for t in range(11)]
    d.line(pts, fill=color, width=2)
    for i in range(1,10,2):
        px,py=pts[i]
        d.ellipse([px-4,py-7,px+4,py-1], fill=color)
        d.ellipse([px-4,py+1,px+4,py+7], fill=color)

wimg = to_img(vgrad([247,241,232],[240,226,222]))                 # cream -> blush
wcx,wcy = W/2,H/2; wdd = np.sqrt((xx-wcx)**2+(yy-wcy)**2); wdd/=wdd.max()
wimg = to_img(np.array(wimg).astype(float)*(1-0.12*wdd[...,None]))  # soft vignette
d = ImageDraw.Draw(wimg)
GOLD=(194,161,90); CHAR=(74,64,56)
d.rounded_rectangle([200,40,1080,680], radius=18, outline=GOLD, width=3)
d.rounded_rectangle([211,51,1069,669], radius=13, outline=GOLD, width=1)
_center(d, 640, 84,  "THE WEDDING OF", _font(SERIF,26), GOLD, tr=10)
_center(d, 640, 120, "Lisa & Pete",     _font(SERIF_IT,98), CHAR, tr=2)
d.line([(505,252),(600,252)], fill=GOLD, width=2)
d.line([(680,252),(775,252)], fill=GOLD, width=2)
d.polygon([(640,244),(650,252),(640,260),(630,252)], fill=GOLD)
_sprig(d, 498, 252, -1); _sprig(d, 782, 252, 1)
_center(d, 640, 612, "NOVEMBER 7TH · 2026", _font(SERIF,30), CHAR, tr=8)
save(wimg, "wedding.jpg")

print("generated:", sorted(os.listdir(OUT)))
