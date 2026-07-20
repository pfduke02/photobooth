# Photobooth — Optional Hardware Reference (later phases)

**You don't need any of this to build or enjoy the app.** V0 runs on your
existing laptop + webcam. This is a phased parts list for *if/when* you want to
level up into a physical booth. Prices are **approximate, mid-2026 USD**, from
web-search snippets — treat them as ballpark ranges and verify at purchase.

**The one big idea:** on a webcam booth, **lighting improves the photos more
than any camera upgrade at the same price.** A $30 light beats a $150 webcam in
a dim room. Spend on light first.

The app is already **arcade-button-ready**: it starts the countdown on the
**Space** key, and a cheap USB "Zero-Delay" encoder makes a physical arcade
button register as a keypress. So the button is nearly plug-and-play later.

---

## Phase 0 — V0 (already own)

Laptop/PC with a built-in webcam, a room with window light or lamps, and
something to raise the laptop to face height. Free wins, in order: (1) face a
window or lamp so light hits faces head-on; (2) raise the camera to eye level;
(3) plain wall/sheet behind the subject. **Buy: nothing.**

## Phase 1 — Better capture (cheap, high-impact)

For a 2×6 strip you do **not** need 4K. Each photo prints ~2×1.9"; at 300 DPI
that's ~570×570 px per cell. **1080p is the sweet spot** (headroom to crop);
720p works; 4K is wasted — put the money into light.

| Item | Representative pick | Approx price | Notes |
|---|---|---|---|
| Budget USB webcam | JLab JBuds Cam; Logitech Brio 300 | ~$25–40 | 1080p; fine in good light |
| **Value webcam** | **Logitech C920s Pro HD** | ~$55–70 | Best quality-per-dollar; buy this one if you buy one |
| Nicer webcam | Logitech C922 / Brio / MX Brio | ~$90–200 | Diminishing returns for a strip |
| **Ring light** | Neewer 10" USB ring light | ~$18–30 | #1 cheap quality win; light faces head-on |
| Softbox / LED panel | Neewer/Torjim softbox kit | ~$25–70 | Softer, more pro than a bare ring |
| Stand/mount | Webcam tripod + phone clip, or laptop riser | ~$12–40 | Get the camera to face height |

**Diffuse the light** (never a bare LED), use **two lights** (key at ~45° +
weaker fill) to kill shadows, and **match color temperature** (~5000–5600K).

*Minimum:* C920s (~$60) + a ring light (~$25) + a tripod (~$15) ≈ **$100**.

## Phase 2 — Tablet booth (portable, no laptop)

| Item | Representative pick | Approx price | Notes |
|---|---|---|---|
| Own an iPad? | any recent iPad | $0 | Best option — runs the web app in Safari |
| Cheapest new | Amazon Fire 7 / HD 8 | ~$60–100 | Weak front cam; fine as a display kiosk |
| Better value | Fire HD 10 / budget Android (Galaxy Tab A9) | ~$100–160 | Snappier; Android is friendlier for a real browser |
| Tabletop stand | weighted aluminum stand (Lamicall/UGREEN) | ~$15–30 | |
| Floor/tripod mount | tripod + tablet clamp | ~$25–50 | Cheaper than a locking kiosk |

Budget tablet front cameras are mediocre — you may still prefer the Phase-1
USB webcam plugged into the tablet (Android/newer iPads support UVC cams).

## Phase 3 — Kiosk + Raspberry Pi + arcade button (the "cool" build)

| Item | Representative pick | Approx price | Notes |
|---|---|---|---|
| **60mm LED arcade button** | EG STARTS / TAPDRA dome button | ~$8–15 (5-packs ~$12–20) | The satisfying "start" |
| **Zero-Delay USB encoder** | EG STARTS / Reyann | ~$10–15 | Button → keypress; no drivers/solder. **Skip on a Pi** (GPIO reads the button directly) |
| Simpler alt: USB foot pedal | iKKEGOL programmable pedal | ~$15–30 | Hidden under the table |
| Simpler alt: Stream Deck Pedal | Elgato | ~$90 | Overkill but bulletproof |
| Pi board only | Raspberry Pi 5 (4GB ~$60 / 8GB ~$80); Pi 4 4GB ~$55 | ~$55–80 | Still need case/PSU/microSD |
| **Pi starter kit** | CanaKit/Vilros (board+case+PSU+microSD) | Pi4 ~$90–120; Pi5 ~$130–180 | Easiest; boots out of the box |
| All-in-one | Raspberry Pi 400 (Pi in a keyboard) | ~$100 | Fewer parts to mount |
| Locking floor kiosk | Mount-It! tablet enclosure | ~$100–200 | The "real kiosk" look (verify price) |
| Budget standing | floor tripod + tablet/monitor clamp | ~$30–60 | Fine for supervised use |
| Backdrop stand | EMART pipe-and-drape | ~$30–70 | Reusable |
| Backdrop fabric | sequin/tension panel | ~$20–45 | Reads great on camera |
| Props kit | wedding/party props set | ~$10–20 | High fun-per-dollar |

## Phase 4 — Printing (eventual)

| Item | Representative pick | Approx price | Notes |
|---|---|---|---|
| **Canon SELPHY CP1500** | compact dye-sub, 4×6 | ~$150–180 | **Two 2×6 strips per 4×6 sheet, cut down the middle** |
| SELPHY media | KP-108IN (108 prints) | ~$36 (~$0.43/sheet → ~$0.20–0.25/strip) | Dye-sub: dry, smudge-proof |
| Pro strip printer | DNP DS-RX1HS / Mitsubishi | ~$800–900 + media | What rental booths use; overkill — rent if ever |
| Fun cheap alt | Fujifilm Instax Mini Link 3 | ~$105 (film ~$0.70–1/shot) | Small instant prints, not strips |

---

## Summary & bundles

**Bare-bones V0 + lighting** (existing laptop): budget cam ~$30 *or* C920s ~$60
+ ring light/softbox ~$25 + tripod ~$15 → **~$70–135**.

**Full kiosk** (standalone, standing): Pi 5 kit ~$150 *(or Fire HD 10 ~$130)* +
C920s ~$60 + light ~$40 + arcade button+encoder ~$25 + kiosk stand ~$150
*(or floor tripod ~$50)* + backdrop+fabric ~$80 + props ~$15 →
**~$470–520** (~$320–370 with the budget tripod). **+ printing** (SELPHY +
media ~$210) → **~$680–730**.

**Bottom line:** a genuinely good booth for **~$100**, portable for **~$250**,
full "cool" kiosk with printing for **~$700**. Spend early dollars on
**lighting** and buy the **C920s** as your one webcam.

### Sources
- [TechRadar — cheap webcams](https://www.techradar.com/news/best-cheap-webcams) · [WFH Lounge — C920 vs Brio](https://www.wfhlounge.com/blog/logitech-c920-vs-brio-4k-webcam-comparison)
- [Stuff — best Fire tablet 2026](https://www.stuff.tv/features/best-amazon-fire-tablet/)
- [TechGearLab — Canon SELPHY CP1500](https://www.techgearlab.com/reviews/small-and-home-office/photo-printer/canon-selphy-cp1500)
- [CanaKit — Raspberry Pi 5](https://www.canakit.com/raspberry-pi-5-8gb.html) · [Pi 400 kit](https://www.canakit.com/raspberry-pi-400-desktop-computer-kit.html)
- [Amazon — Zero-Delay encoder](https://www.amazon.com/zero-delay-usb-encoder/s?k=zero+delay+usb+encoder) · [60mm arcade buttons](https://www.amazon.com/EG-STARTS-Illuminated-Buttons-Operated/dp/B01M7PNCO9) · [Neewer ring light](https://www.amazon.com/Neewer-Brightness-Streaming-Photography-Flexible/dp/B08B642TF8) · [EMART backdrop](https://www.amazon.com/Backdrop-Photography-Background-Support-System/dp/B01H31M62I)
- [DNP DS-RX1HS](https://www.bhphotovideo.com/c/product/1264019-REG/dnp_ds_rx1hs_dye_sublimation_printer.html) · [Instax Mini Link 3](https://www.walmart.com/ip/Fujifilm-instax-Mini-Link-3-Printer-White/10121908281)

*Two figures I couldn't pull live and flagged: the DNP printer (~$800–900) and
the locking kiosk stand (~$100–200) — both optional/overkill, so the core
budget is unaffected.*
