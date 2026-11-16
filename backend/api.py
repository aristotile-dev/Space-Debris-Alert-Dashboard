"""Space Debris Alert API. Standalone: `uvicorn api:app --port 7861`. In the shared Space it is mounted at /spacedebris."""
from __future__ import annotations

import os
import time
from collections import defaultdict, deque

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

try:  # inside the Space this folder is a package; standalone it is the working directory
    from . import core, llm
except ImportError:  # pragma: no cover
    import core  # type: ignore
    import llm  # type: ignore

app = FastAPI(title="Space Debris Alert API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",") if o.strip()],
    allow_methods=["*"],
    allow_headers=["*"],
)

store = core.Store()
cache = core.ScanCache()

FEATURED = ["ISS (ZARYA)", "HST", "CSS (TIANHE)", "STARLINK-4328"]

_hits: dict = defaultdict(deque)


def limit(request: Request, bucket: str, count: int, window: int, message: str):
    ip = (request.headers.get("x-forwarded-for", "") or (request.client.host if request.client else "?")).split(",")[0].strip()
    q = _hits[(bucket, ip)]
    now = time.time()
    while q and now - q[0] > window:
        q.popleft()
    if len(q) >= count:
        raise HTTPException(status_code=429, detail=message)
    q.append(now)


class ScanBody(BaseModel):
    target_id: int
    threshold_km: float = Field(50.0, ge=5, le=200)
    source: str = Field("snapshot", pattern="^(snapshot|live)$")


class BriefBody(BaseModel):
    scan: dict
    style: str = Field("plain", pattern="^(plain|simple)$")


class ChatBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=500)
    scan: dict
    history: list[dict] = []


@app.get("/health")
def health():
    cat = store.snapshot
    return {
        "ok": True,
        "snapshot_objects": cat.size,
        "snapshot_debris": int(cat.kinds.sum()),
        "snapshot_epoch_utc": cat.latest_epoch.strftime("%Y-%m-%d %H:%M:%S"),
        "live_cached": store.live is not None,
        "live_age_s": int(time.time() - store.live.loaded_at) if store.live else None,
        "live_error": store.live_error,
        "ai": bool(os.getenv("GROQ_API_KEY")),
    }


@app.get("/targets")
def targets():
    out = []
    cat = store.snapshot
    for name in FEATURED:
        for i, n in enumerate(cat.names):
            if n == name:
                out.append({"id": int(cat.satnums[i]), "name": name})
                break
    return {"featured": out}


@app.get("/objects")
def objects(q: str = ""):
    q = q.strip().upper()
    if len(q) < 2:
        return {"results": []}
    cat = store.snapshot
    res = [{"id": int(cat.satnums[i]), "name": n + (" (debris)" if cat.kinds[i] == 1 else "")} for i, n in enumerate(cat.names) if q in n.upper()]
    res.sort(key=lambda r: (not r["name"].upper().startswith(q), len(r["name"])))
    return {"results": res[:8]}


@app.get("/cloud")
def cloud(source: str = "snapshot"):
    cat, note = store.get(source == "live")
    t0 = core.reference_time(cat)
    xyz, n_debris = core.cloud_at(cat, t0)
    return {"t0_utc": t0.strftime("%Y-%m-%d %H:%M:%S"), "source": cat.source, "note": note, "xyz_km": xyz, "n_debris": n_debris}


@app.post("/scan")
def scan(body: ScanBody, request: Request):
    limit(request, "scan", 8, 60, "Easy. Eight scans a minute is the limit. Try again in a bit.")
    cat, note = store.get(body.source == "live")
    t0 = core.reference_time(cat)
    key = (cat.version, body.target_id, round(body.threshold_km), t0.strftime("%Y%m%d%H%M"))
    hit = cache.get(key)
    if hit is not None:
        return {**hit, "note": note, "cached": True}
    try:
        result = core.scan(cat, body.target_id, round(body.threshold_km, 1), t0)
    except KeyError:
        raise HTTPException(status_code=404, detail="That object is not in the catalogue.")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    cache.put(key, result)
    return {**result, "note": note, "cached": False}


@app.post("/briefing")
def briefing(body: BriefBody, request: Request):
    limit(request, "ai", 20, 60, "Too many briefing requests. Wait a minute.")
    if "target" not in body.scan or "threats" not in body.scan:
        raise HTTPException(status_code=422, detail="That is not a scan result.")
    text, by = llm.briefing(body.scan, body.style)
    return {"text": text, "by": by}


@app.post("/chat")
def chat(body: ChatBody, request: Request):
    limit(request, "ai", 20, 60, "Too many messages. Wait a minute.")
    if "target" not in body.scan or "threats" not in body.scan:
        raise HTTPException(status_code=422, detail="That is not a scan result.")
    text, by = llm.chat(body.message, body.scan, body.history)
    return {"reply": text, "by": by}
