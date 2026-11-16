"""Downloads fresh orbit data from CelesTrak into backend/data/ (active.txt and debris.txt).
Run by the daily GitHub Action; safe to run by hand:  python refresh_data.py
It refuses to overwrite the snapshot unless every group came back with a believable number of objects."""
import os
import sys

import httpx

HERE = os.path.dirname(os.path.abspath(__file__))
URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=tle"
DEBRIS_GROUPS = ["cosmos-2251-debris", "iridium-33-debris", "fengyun-1c-debris", "cosmos-1408-debris"]


def grab(group: str) -> str:
    r = httpx.get(URL.format(group), timeout=60, follow_redirects=True, headers={"User-Agent": "cassandra-orbit-refresh/1.0"})
    r.raise_for_status()
    return r.text


def count(text: str) -> int:
    return sum(1 for ln in text.splitlines() if ln.startswith("1 "))


active = grab("active")
if count(active) < 10000:
    sys.exit(f"active group looks wrong ({count(active)} objects); keeping the old snapshot")
debris = ""
for g in DEBRIS_GROUPS:
    text = grab(g)
    if count(text) < 1:
        sys.exit(f"{g} came back empty; keeping the old snapshot")
    debris += text.rstrip() + "\n"
if count(debris) < 1500:
    sys.exit(f"debris looks wrong ({count(debris)} objects); keeping the old snapshot")

with open(os.path.join(HERE, "data", "active.txt"), "w", encoding="utf8", newline="\n") as f:
    f.write(active)
with open(os.path.join(HERE, "data", "debris.txt"), "w", encoding="utf8", newline="\n") as f:
    f.write(debris)
print(f"active {count(active)}, debris {count(debris)}")
