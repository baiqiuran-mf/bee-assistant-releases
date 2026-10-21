import json, subprocess, sys, os, urllib.request

LIB = "E:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills/library"
OUT = "E:/WorkBuddy-Projects/wa-assistant/_lib"

nodes = [
    ("ZgJvhAfjLTjWk1UF9upmYI", "session.js"),
    ("eddLV5nsF2Tdu72YBgs0tU", "db.js"),
    ("fLhrLAvIvcM89ooB4mq67E", "doc.test.js"),
    ("0Mf1rjQ2W9NjK9Wi4hScmw", "customerDoc.js"),
    ("X5RSD0j7BbCeUYvQDG3gtY", "config.yaml"),
    ("RGhbHoAPPeiNljpL2vR391", "ids.js"),
]

for nid, fname in nodes:
    p = subprocess.run(
        [sys.executable, os.path.join(LIB, "drive", "get_download_link.py"), "--node-id", nid],
        capture_output=True, text=True, encoding="utf-8", cwd=LIB)
    url = None
    for line in p.stdout.splitlines():
        if line.startswith("KS_DRIVE_DOWNLOAD "):
            url = json.loads(line[len("KS_DRIVE_DOWNLOAD "):])["download_url"]
    if not url:
        print("FAIL link", fname, p.stdout[:200], p.stderr[:200])
        continue
    dest = os.path.join(OUT, fname)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        f.write(r.read())
    print("OK", fname, os.path.getsize(dest))
