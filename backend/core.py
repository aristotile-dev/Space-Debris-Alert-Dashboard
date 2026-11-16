"""Conjunction scan: propagate the catalogue with SGP4 and find who passes close to a target.

Two ideas make it fast enough to feel live:
  1. An altitude-shell filter. An object whose orbit never comes within `threshold` km of the target's altitude
     band can never come within `threshold` km of the target, so it is dropped before any propagation.
  2. Batched propagation with `SatrecArray` (C code), in chunks, instead of a Python loop per object.
"""
from __future__ import annotations

import math
import os
import threading
import time
from collections import OrderedDict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import numpy as np
from sgp4.api import Satrec, SatrecArray

HERE = os.path.dirname(os.path.abspath(__file__))
SNAPSHOT_PATH = os.path.join(HERE, "data", "active.txt")
DEBRIS_PATH = os.path.join(HERE, "data", "debris.txt")
CT = "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=tle"
LIVE_URL = CT.format("active")
# the big known breakups and collisions: real debris, not working satellites
DEBRIS_GROUPS = ["cosmos-2251-debris", "iridium-33-debris", "fengyun-1c-debris", "cosmos-1408-debris"]
import tempfile

LIVE_CACHE = os.path.join(tempfile.gettempdir(), "spacedebris_active_live.txt")
LIVE_RETRY_S = 600  # after a failed fetch, do not hit CelesTrak again for ten minutes
LIVE_MIN_INTERVAL_S = 2 * 3600  # CelesTrak asks clients not to poll more often than every two hours

EARTH_RADIUS_KM = 6378.135
STEPS = 1441  # 24 h at one-minute steps, both ends included
CHUNK = 400
CO_MOVING_KM = 5.0  # an object that never strays further than this from the target travels with it (docked, tethered)


@dataclass
class Catalogue:
    names: list
    satnums: np.ndarray
    sats: list
    perigee_km: np.ndarray
    apogee_km: np.ndarray
    epoch_jd: np.ndarray
    kinds: np.ndarray  # 0 = working satellite, 1 = debris
    source: str  # "snapshot" or "live"
    loaded_at: float
    version: str

    def index_of(self, satnum: int):
        hits = np.nonzero(self.satnums == satnum)[0]
        return int(hits[0]) if hits.size else None

    @property
    def size(self) -> int:
        return len(self.sats)

    @property
    def latest_epoch(self) -> datetime:
        jd = float(np.max(self.epoch_jd))
        return jd_to_datetime(jd)


def jd_to_datetime(jd: float) -> datetime:
    return datetime(2000, 1, 1, 12, tzinfo=timezone.utc) + timedelta(days=jd - 2451545.0)


def datetime_to_jd(dt: datetime) -> float:
    return 2451545.0 + (dt - datetime(2000, 1, 1, 12, tzinfo=timezone.utc)).total_seconds() / 86400.0


def parse_tle(text: str, source: str, kind: int = 0) -> Catalogue:
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    names, nums, sats, per, apo, epochs = [], [], [], [], [], []
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if not (l1.startswith("1 ") and l2.startswith("2 ")):
            i += 1
            continue
        i += 3
        try:
            sat = Satrec.twoline2rv(l1, l2)
        except Exception:
            continue
        if sat.error != 0 or not math.isfinite(sat.alta):
            continue
        names.append(name.strip())
        nums.append(sat.satnum)
        sats.append(sat)
        per.append((sat.altp + 1.0) * EARTH_RADIUS_KM)
        apo.append((sat.alta + 1.0) * EARTH_RADIUS_KM)
        epochs.append(sat.jdsatepoch + sat.jdsatepochF)
    return Catalogue(
        names=names,
        satnums=np.array(nums, dtype=np.int64),
        sats=sats,
        perigee_km=np.array(per),
        apogee_km=np.array(apo),
        epoch_jd=np.array(epochs),
        kinds=np.full(len(sats), kind, dtype=np.int8),
        source=source,
        loaded_at=time.time(),
        version=f"{source}-{len(sats)}-{int(max(epochs)) if epochs else 0}-{int(time.time())}",
    )


def merge(parts: list, source: str) -> Catalogue:
    """Satellites first, debris after; an object that appears in two groups is kept once."""
    seen: set = set()
    names, nums, sats, per, apo, ep, kinds = [], [], [], [], [], [], []
    for c in parts:
        for i in range(c.size):
            n = int(c.satnums[i])
            if n in seen:
                continue
            seen.add(n)
            names.append(c.names[i]); nums.append(n); sats.append(c.sats[i])
            per.append(c.perigee_km[i]); apo.append(c.apogee_km[i]); ep.append(c.epoch_jd[i]); kinds.append(int(c.kinds[i]))
    return Catalogue(
        names=names, satnums=np.array(nums, dtype=np.int64), sats=sats, perigee_km=np.array(per), apogee_km=np.array(apo),
        epoch_jd=np.array(ep), kinds=np.array(kinds, dtype=np.int8), source=source, loaded_at=time.time(),
        version=f"{source}-{len(sats)}-{int(max(ep)) if ep else 0}-{int(time.time())}",
    )


class Store:
    """Holds the bundled snapshot (satellites plus debris) and, when asked, a live copy refreshed at most every two hours."""

    def __init__(self):
        with open(SNAPSHOT_PATH, "r", encoding="utf8") as f:
            sat = parse_tle(f.read(), "snapshot", 0)
        parts = [sat]
        if os.path.exists(DEBRIS_PATH):
            with open(DEBRIS_PATH, "r", encoding="utf8") as f:
                parts.append(parse_tle(f.read(), "snapshot", 1))
        self.snapshot = merge(parts, "snapshot")
        self.live: Catalogue | None = None
        self.live_error: str | None = None
        self.last_try = 0.0
        self._lock = threading.Lock()
        self._load_cached_live()

    def _load_cached_live(self):
        try:
            fa, fd = LIVE_CACHE + ".active", LIVE_CACHE + ".debris"
            if os.path.exists(fa) and time.time() - os.path.getmtime(fa) < LIVE_MIN_INTERVAL_S:
                with open(fa, "r", encoding="utf8") as f:
                    parts = [parse_tle(f.read(), "live", 0)]
                if os.path.exists(fd):
                    with open(fd, "r", encoding="utf8") as f:
                        parts.append(parse_tle(f.read(), "live", 1))
                cat = merge(parts, "live")
                if cat.size > 1000:
                    cat.loaded_at = os.path.getmtime(fa)
                    self.live = cat
        except Exception:
            pass

    def get(self, want_live: bool) -> tuple[Catalogue, str | None]:
        """Return (catalogue, note). `note` explains a fallback to the snapshot."""
        if not want_live:
            return self.snapshot, None
        with self._lock:
            fresh = self.live is not None and time.time() - self.live.loaded_at < LIVE_MIN_INTERVAL_S
            if not fresh and time.time() - self.last_try < LIVE_RETRY_S and self.live_error:
                if self.live is None:
                    return self.snapshot, "Live data is not reachable right now, so this scan uses the bundled snapshot."
                return self.live, None
            if not fresh:
                self.last_try = time.time()
                try:
                    import httpx

                    def grab(url: str) -> str:
                        r = httpx.get(url, timeout=25, follow_redirects=True, headers={"User-Agent": "cassandra-orbit/1.0"})
                        r.raise_for_status()
                        return r.text

                    active_text = grab(LIVE_URL)
                    parts = [parse_tle(active_text, "live", 0)]
                    if parts[0].size < 1000:
                        raise ValueError("live feed returned too few objects")
                    debris_text = ""
                    for g in DEBRIS_GROUPS:  # a missing debris group never fails the scan
                        try:
                            debris_text += grab(CT.format(g)) + "\n"
                        except Exception:  # noqa: BLE001
                            pass
                    if debris_text.strip():
                        parts.append(parse_tle(debris_text, "live", 1))
                    self.live = merge(parts, "live")
                    self.live_error = None
                    try:
                        with open(LIVE_CACHE + ".active", "w", encoding="utf8") as f:
                            f.write(active_text)
                        with open(LIVE_CACHE + ".debris", "w", encoding="utf8") as f:
                            f.write(debris_text)
                    except Exception:
                        pass
                except Exception as e:  # noqa: BLE001
                    self.live_error = str(e)[:160]
                    if self.live is None:
                        return self.snapshot, "Live data is not reachable right now, so this scan uses the bundled snapshot."
            return self.live, None


def _positions(sats: list, jd: np.ndarray, fr: np.ndarray, velocity: bool = False):
    arr = SatrecArray(sats)
    e, r, v = arr.sgp4(jd, fr)
    return (r, v, e) if velocity else (r, e)


def reference_time(cat: Catalogue) -> datetime:
    """Live data starts from now. A snapshot starts from its own newest epoch, because TLEs go stale fast."""
    if cat.source == "live":
        return datetime.now(timezone.utc).replace(second=0, microsecond=0)
    return cat.latest_epoch.replace(second=0, microsecond=0)


def _grid(t0: datetime, steps: int = STEPS):
    jd0 = datetime_to_jd(t0)
    whole = math.floor(jd0)
    frac0 = jd0 - whole
    jd = np.full(steps, float(whole))
    fr = frac0 + np.arange(steps) / 1440.0
    return jd, fr


def cloud_at(cat: Catalogue, t0: datetime) -> tuple:
    """Every object's position at t0 as a flat list of whole kilometres (x, y, z, ...), satellites first and the debris last, plus the debris count."""
    jd, fr = _grid(t0, 1)
    out = np.full((cat.size, 3), np.nan)
    for s in range(0, cat.size, 2000):
        r, e = _positions(cat.sats[s : s + 2000], jd, fr)
        out[s : s + 2000] = r[:, 0, :]
    ok = np.isfinite(out).all(axis=1)
    flat = np.rint(out[ok]).astype(int).ravel()
    return flat.tolist(), int((cat.kinds[ok] == 1).sum())


def risk_label(distance_km: float) -> str:
    if distance_km < 25:
        return "HIGH"
    if distance_km < 50:
        return "MEDIUM"
    return "LOW"


def scan(cat: Catalogue, target_id: int, threshold_km: float, t0: datetime) -> dict:
    """24 h scan. Coarse pass on a 2-minute grid, a straight-line closest-approach estimate between samples
    (relative position and velocity), then an exact one-second SGP4 refinement for the few that could matter."""
    started = time.time()
    ti = cat.index_of(target_id)
    if ti is None:
        raise KeyError(target_id)
    target = cat.sats[ti]

    whole = float(math.floor(datetime_to_jd(t0)))
    frac0 = datetime_to_jd(t0) - whole

    def grid(seconds: np.ndarray):
        return np.full(seconds.shape, whole), frac0 + seconds / 86400.0

    # the target on a one-second grid for the whole window, used for the exact refinement
    secs_full = np.arange(0, 86400 + 1, dtype=float)
    e, tr_full, tv_full = target.sgp4_array(*grid(secs_full))
    if e.any() or not np.isfinite(tr_full).all():
        raise ValueError("target could not be propagated")
    COARSE = 120
    ci = np.arange(0, 86400 + 1, COARSE)
    tpos_c, tvel_c = tr_full[ci], tv_full[ci]
    cjd, cfr = grid(ci.astype(float))

    # 1. altitude-shell filter
    t_low, t_high = float(cat.perigee_km[ti]), float(cat.apogee_km[ti])
    keep = (cat.perigee_km - threshold_km <= t_high) & (cat.apogee_km + threshold_km >= t_low)
    keep[ti] = False
    candidates = np.nonzero(keep)[0]

    # 2. batched coarse propagation and the straight-line closest-approach estimate
    margin = threshold_km + 40.0
    refine = []  # (catalogue index, coarse sample index)
    co_moving = 0
    for s in range(0, len(candidates), CHUNK):
        idx = candidates[s : s + CHUNK]
        r, v, err = _positions([cat.sats[i] for i in idx], cjd, cfr, velocity=True)
        rel = r - tpos_c[None]
        w = v - tvel_c[None]
        dist = np.linalg.norm(rel, axis=2)
        dist = np.where(np.isfinite(dist), dist, np.inf)
        w2 = np.maximum((w * w).sum(axis=2), 1e-9)
        tau = np.clip(-(rel * w).sum(axis=2) / w2, -COARSE / 2, COARSE / 2)
        miss = np.linalg.norm(rel + w * tau[..., None], axis=2)
        miss = np.where(np.isfinite(miss), miss, np.inf)
        best = miss.min(axis=1)
        far = np.where(np.isfinite(dist), dist, -1).max(axis=1)
        for k in np.nonzero(best < margin)[0]:
            if far[k] < CO_MOVING_KM:
                co_moving += 1
                continue
            refine.append((int(idx[k]), int(miss[k].argmin())))

    # 3. exact refinement: one-second SGP4 around the best coarse sample
    hits = []
    for i, j in refine:
        centre = j * COARSE
        lo, hi = max(0, centre - 90), min(86400, centre + 90)
        secs = np.arange(lo, hi + 1, dtype=float)
        e, r, v = cat.sats[i].sgp4_array(*grid(secs))
        if e.any():
            continue
        d = np.linalg.norm(r - tr_full[lo : hi + 1], axis=1)
        m = int(d.argmin())
        if d[m] < threshold_km:
            rel_speed = float(np.linalg.norm(v[m] - tv_full[lo + m]))
            hits.append((float(d[m]), i, lo + m, rel_speed))

    hits.sort(key=lambda h: h[0])
    threats = []
    for dist, i, sec, rel in hits:
        tca = t0 + timedelta(seconds=sec)
        threats.append(
            {
                "name": cat.names[i],
                "id": int(cat.satnums[i]),
                "distance_km": round(dist, 2),
                "tca_utc": tca.strftime("%Y-%m-%d %H:%M:%S"),
                "seconds_from_start": int(sec),
                "rel_speed_kms": round(rel, 2),
                "risk": risk_label(dist),
                "kind": "debris" if cat.kinds[i] == 1 else "satellite",
                "altitude_km": round(float(np.linalg.norm(tr_full[sec]) - EARTH_RADIUS_KM), 0),
            }
        )

    # 4. closed orbit rings for the 3D scene: one full period each, starting at the closest approach (units of 10 km)
    RING_POINTS = 120

    def ring(sat, start_sec: float):
        period_s = 2 * math.pi / max(sat.no_kozai, 1e-6) * 60.0  # no_kozai is rad/min
        secs = start_sec + np.arange(RING_POINTS) * (period_s / RING_POINTS)
        _, rr, _ = sat.sgp4_array(*grid(secs))
        ok = np.isfinite(rr).all(axis=1)
        return np.rint(rr[ok] * 0.1).astype(int).ravel().tolist(), period_s / 60.0

    scene = None
    first = threats[0]["seconds_from_start"] if threats else 0
    target_ring, target_period = ring(target, float(first))
    if threats:
        scene = {"events": []}
        for th in threats[:8]:
            i = cat.index_of(th["id"])
            c = th["seconds_from_start"]
            path, period = ring(cat.sats[i], float(c))
            _, mk, _ = cat.sats[i].sgp4_array(*grid(np.array([float(c)])))
            scene["events"].append(
                {
                    "id": th["id"],
                    "name": th["name"],
                    "path": path,
                    "period_min": round(period, 1),
                    "marker": np.rint(mk[0]).astype(int).tolist(),
                    "target_marker": np.rint(tr_full[c]).astype(int).tolist(),
                }
            )

    elapsed = time.time() - started
    return {
        "target": {"id": target_id, "name": cat.names[ti], "perigee_km": round(t_low, 0), "apogee_km": round(t_high, 0), "period_min": round(target_period, 1)},
        "threshold_km": threshold_km,
        "status": "RED" if threats else "GREEN",
        "objects_total": cat.size - 1,
        "objects_screened_out": int(cat.size - 1 - len(candidates)),
        "objects_propagated": int(len(candidates)),
        "objects_refined": len(refine),
        "co_moving_ignored": co_moving,
        "objects_debris": int(cat.kinds.sum()),
        "threat_debris": int(sum(1 for h in hits if cat.kinds[h[1]] == 1)),
        "threats": threats[:50],
        "threat_count": len(threats),
        "analysis_seconds": round(elapsed, 2),
        "window": {"start_utc": t0.strftime("%Y-%m-%d %H:%M:%S"), "end_utc": (t0 + timedelta(days=1)).strftime("%Y-%m-%d %H:%M:%S")},
        "source": cat.source,
        "data_epoch_utc": cat.latest_epoch.strftime("%Y-%m-%d %H:%M:%S"),
        "scene": scene,
        "target_ring": target_ring,
    }


class ScanCache:
    def __init__(self, size: int = 64):
        self.size = size
        self.data: OrderedDict = OrderedDict()
        self.lock = threading.Lock()

    def get(self, key):
        with self.lock:
            if key in self.data:
                self.data.move_to_end(key)
                return self.data[key]
        return None

    def put(self, key, value):
        with self.lock:
            self.data[key] = value
            self.data.move_to_end(key)
            while len(self.data) > self.size:
                self.data.popitem(last=False)
