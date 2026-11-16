"""Writes ../public/demo.json: a precomputed ISS scan and the whole catalogue's positions, so the page is alive
before the API wakes up. Run after changing the snapshot or the scan code:  python make_demo.py"""
import json
import os

import core
import llm

store = core.Store()
cat = store.snapshot
t0 = core.reference_time(cat)
scan = core.scan(cat, 25544, 50.0, t0)
xyz, n_debris = core.cloud_at(cat, t0)
out = {
    "t0_utc": t0.strftime("%Y-%m-%d %H:%M:%S"),
    "scan": scan,
    "briefing": llm.rule_briefing(scan),
    "xyz_km": xyz,
    "n_debris": n_debris,
    "featured": [],
}
for name in ["ISS (ZARYA)", "HST", "CSS (TIANHE)", "STARLINK-4328"]:
    for i, n in enumerate(cat.names):
        if n == name:
            out["featured"].append({"id": int(cat.satnums[i]), "name": name})
            break
dest = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "demo.json")
os.makedirs(os.path.dirname(dest), exist_ok=True)
with open(dest, "w", encoding="utf8") as f:
    json.dump(out, f, separators=(",", ":"))
print("wrote", os.path.getsize(dest) // 1024, "KB;", scan["threat_count"], "threats;", len(out["xyz_km"]) // 3, "objects")
