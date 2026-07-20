#!/usr/bin/env python3
"""Photobooth · sync.py — one command, two things:

1. Mirror every CLOUD session into  sessions/<id>/  (strip.png, frame-N.jpg,
   metadata.json) — idempotent, only downloads what's missing.
2. Maintain a flat  strips/  folder: every photostrip as a single PNG named
   like  2026-07-19_154641_wedding_11fa0c.png  — the "just show me the strips"
   summary, no digging through session folders.

    python3 sync.py

Zero dependencies (stdlib only). If the network is down, step 1 is skipped
with a warning and step 2 still re-organizes whatever is already local.

Google Drive tip: keep this whole folder inside your Google Drive folder and
the Drive desktop app backs up every sync automatically.
"""
import glob as globmod, json, os, re, shlex, shutil, sys, urllib.request

URL  = "https://xjnqnxorqhobikyzshrt.supabase.co"
ANON = ("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
        "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhqbnFueG9ycWhvYmlreXpzaHJ0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ0NDkyMjUsImV4cCI6MjEwMDAyNTIyNX0."
        "ihY85rnHCWyg7MknipFU9_bI2syCPYbwpQurVIe0scA")

ROOT   = os.path.dirname(os.path.abspath(__file__))
OUT    = os.path.join(ROOT, "sessions")
STRIPS = os.path.join(ROOT, "strips")
DRIVE_FOLDER_NAME = "Photobooth Strips"   # Google Drive folder to receive strip copies

def fetch(url, headers=None):
    req = urllib.request.Request(url, headers=headers or {})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def sync_cloud():
    rows = json.loads(fetch(
        f"{URL}/rest/v1/sessions?select=*&order=created_at.asc",
        {"apikey": ANON, "Authorization": "Bearer " + ANON}))
    print(f"cloud sessions: {len(rows)}")
    downloaded = 0
    for s in rows:
        d = os.path.join(OUT, s["id"])
        os.makedirs(d, exist_ok=True)
        paths = ([s["strip_path"]] if s.get("strip_path") else []) + (s.get("frame_paths") or [])
        boom_path = (s.get("meta") or {}).get("boomerangPath")
        if boom_path:
            paths = paths + [boom_path]
        pulled = []
        for p in paths:
            fp = os.path.join(d, os.path.basename(p))
            if os.path.exists(fp):
                continue
            try:
                data = fetch(f"{URL}/storage/v1/object/public/sessions/{p}")
            except Exception as e:
                print(f"  ! {s['id']}/{os.path.basename(p)}: {e}", file=sys.stderr)
                continue
            with open(fp, "wb") as f:
                f.write(data)
            pulled.append(os.path.basename(p))
            downloaded += 1
        mfp = os.path.join(d, "metadata.json")
        if not os.path.exists(mfp):
            with open(mfp, "w") as f:
                json.dump(s, f, indent=2)
        if pulled:
            print(f"  + {s['id']}: {', '.join(pulled)}")
    print(f"cloud sync done — {downloaded} new file(s)")

def _strip_name(sid, meta):
    """2026-07-19_154641_wedding_11fa0c.png — sortable, self-describing."""
    created = meta.get("created_at") or meta.get("createdAt") or ""
    day = created[:10] if re.match(r"^\d{4}-\d{2}-\d{2}", created) else sid[:10]
    hms = re.sub(r"\D", "", created[11:19]) or "000000"
    theme = (meta.get("strip_theme") or meta.get("stripTheme")
             or (meta.get("meta") or {}).get("stripTheme") or "classic")
    shortid = sid.split("_")[-1][:6]
    return f"{day}_{hms}_{theme}_{shortid}.png"

def flatten_strips():
    os.makedirs(STRIPS, exist_ok=True)
    added = 0
    total = 0
    if not os.path.isdir(OUT):
        print("no sessions/ folder yet — run again once a session is synced")
        return
    for sid in sorted(os.listdir(OUT)):
        src = os.path.join(OUT, sid, "strip.png")
        if not os.path.isfile(src):
            continue
        total += 1
        meta = {}
        try:
            with open(os.path.join(OUT, sid, "metadata.json")) as f:
                meta = json.load(f)
        except Exception:
            pass
        dst = os.path.join(STRIPS, _strip_name(sid, meta))
        if not os.path.exists(dst):
            shutil.copy2(src, dst)
            print(f"  + strips/{os.path.basename(dst)}")
            added += 1
    print(f"strips/ summary — {total} strip(s) total, {added} newly added")

def find_drive_strips_dir():
    """Locate the local mirror of the '{DRIVE_FOLDER_NAME}' Google Drive folder
    (Google Drive for desktop). Returns a path or None."""
    home = os.path.expanduser("~")
    pats = [
        os.path.join(home, "Library", "CloudStorage", "GoogleDrive-*", "My Drive", DRIVE_FOLDER_NAME),
        os.path.join(home, "Google Drive", "My Drive", DRIVE_FOLDER_NAME),
        os.path.join(home, "Google Drive", DRIVE_FOLDER_NAME),
    ]
    for p in pats:
        for c in globmod.glob(p):
            if os.path.isdir(c):
                return c
    return None

def copy_to_gdrive():
    """Copy every strip into the Google Drive folder — Drive for desktop then
    auto-syncs them to drive.google.com. Only copies what's missing."""
    d = find_drive_strips_dir()
    if not d:
        print(f'(google drive copy skipped — no "{DRIVE_FOLDER_NAME}" folder found locally; '
              f'install Google Drive for desktop, or drag strips/ into the folder on drive.google.com once)')
        return
    if not os.path.isdir(STRIPS):
        return
    added = 0
    for f in sorted(os.listdir(STRIPS)):
        if not f.lower().endswith(".png"):
            continue
        dst = os.path.join(d, f)
        if os.path.exists(dst):
            continue
        shutil.copy2(os.path.join(STRIPS, f), dst)
        print(f"  ↑ gdrive: {f}")
        added += 1
    print(f'google drive "{DRIVE_FOLDER_NAME}" — {added} new strip(s) copied (auto-syncs up)')

PLIST_ID = "com.photobooth.sync"

def install_auto():
    """Register this script with macOS launchd: runs every 30 minutes and at
    login, so new strips flow to sessions/, strips/, and Google Drive
    automatically while the Mac is on (it catches up after sleep)."""
    if sys.platform != "darwin":
        print("--install-auto is for macOS (launchd) only."); return
    agents = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents")
    os.makedirs(agents, exist_ok=True)
    plist = os.path.join(agents, PLIST_ID + ".plist")
    log = os.path.join(ROOT, "sync.log")
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{PLIST_ID}</string>
  <key>ProgramArguments</key><array>
    <string>{sys.executable}</string>
    <string>{os.path.abspath(__file__)}</string>
  </array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>{log}</string>
  <key>StandardErrorPath</key><string>{log}</string>
</dict></plist>
"""
    with open(plist, "w") as f:
        f.write(xml)
    os.system(f"launchctl unload {shlex.quote(plist)} 2>/dev/null")
    os.system(f"launchctl load {shlex.quote(plist)}")
    print(f"auto-sync installed ✓  (every 30 min + at login; log: {log})")
    print(f"turn off anytime:  python3 {os.path.abspath(__file__)} --uninstall-auto")

def uninstall_auto():
    if sys.platform != "darwin":
        print("--uninstall-auto is for macOS only."); return
    plist = os.path.join(os.path.expanduser("~"), "Library", "LaunchAgents", PLIST_ID + ".plist")
    os.system(f"launchctl unload {shlex.quote(plist)} 2>/dev/null")
    if os.path.exists(plist):
        os.remove(plist)
    print("auto-sync removed.")

if __name__ == "__main__":
    if "--install-auto" in sys.argv:
        install_auto(); sys.exit(0)
    if "--uninstall-auto" in sys.argv:
        uninstall_auto(); sys.exit(0)
    # keep the auto-run log from growing unbounded
    try:
        lg = os.path.join(ROOT, "sync.log")
        if os.path.exists(lg) and os.path.getsize(lg) > 2_000_000:
            open(lg, "w").close()
    except Exception:
        pass
    try:
        sync_cloud()
    except Exception as e:
        print(f"(cloud sync skipped: {e})", file=sys.stderr)
    flatten_strips()
    copy_to_gdrive()
