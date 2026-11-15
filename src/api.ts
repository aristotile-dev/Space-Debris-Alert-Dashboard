export interface Threat {
  name: string;
  id: number;
  distance_km: number;
  tca_utc: string;
  seconds_from_start: number;
  rel_speed_kms: number;
  risk: "HIGH" | "MEDIUM" | "LOW";
  altitude_km: number;
}

export interface SceneEvent {
  id: number;
  name: string;
  path: number[]; // one full orbit, units of 10 km, flat x y z
  period_min: number;
  marker: number[]; // km
  target_marker: number[]; // km
}

export interface Scan {
  target: { id: number; name: string; perigee_km: number; apogee_km: number; period_min: number };
  threshold_km: number;
  status: "GREEN" | "RED";
  objects_total: number;
  objects_screened_out: number;
  objects_propagated: number;
  objects_refined: number;
  co_moving_ignored: number;
  threats: Threat[];
  threat_count: number;
  analysis_seconds: number;
  window: { start_utc: string; end_utc: string };
  source: "snapshot" | "live";
  data_epoch_utc: string;
  scene: { events: SceneEvent[] } | null;
  target_ring: number[];
  note?: string | null;
  cached?: boolean;
}

export interface Featured { id: number; name: string }
export interface Demo { t0_utc: string; scan: Scan; briefing: string; xyz_km: number[]; featured: Featured[] }

const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined) || "https://totz07-wafer-defect-api.hf.space/spacedebris";

async function call<T>(path: string, init?: RequestInit, timeoutMs = 60000): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + path, { ...init, signal: ctl.signal, headers: { "Content-Type": "application/json", ...(init?.headers || {}) } });
    if (!r.ok) {
      let detail = "Something went wrong.";
      try { detail = (await r.json()).detail || detail; } catch { /* keep default */ }
      throw new Error(detail);
    }
    return (await r.json()) as T;
  } catch (e: any) {
    if (e?.name === "AbortError") throw new Error("The server took too long. If it was asleep, try again in a few seconds.");
    if (e instanceof TypeError) throw new Error("Could not reach the server. If it was asleep, try again in a few seconds.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export const loadDemo = async (): Promise<Demo> => (await fetch("/demo.json")).json();
export const runScan = (target_id: number, threshold_km: number, source: "snapshot" | "live") =>
  call<Scan>("/scan", { method: "POST", body: JSON.stringify({ target_id, threshold_km, source }) }, 90000);
export const searchObjects = (q: string) => call<{ results: Featured[] }>(`/objects?q=${encodeURIComponent(q)}`, undefined, 15000);
export const getCloud = (source: "snapshot" | "live") => call<{ t0_utc: string; xyz_km: number[]; note?: string | null }>(`/cloud?source=${source}`, undefined, 30000);
export const getBriefing = (scan: Scan, style: "plain" | "simple") =>
  call<{ text: string; by: string }>("/briefing", { method: "POST", body: JSON.stringify({ scan: slim(scan), style }) }, 45000);
export const sendChat = (message: string, scan: Scan, history: { role: string; content: string }[]) =>
  call<{ reply: string; by: string }>("/chat", { method: "POST", body: JSON.stringify({ message, scan: slim(scan), history }) }, 45000);

/** The model never needs the 3D path points; keep the request small. */
function slim(scan: Scan) {
  const { scene: _s, target_ring: _r, ...rest } = scan;
  return { ...rest, threats: scan.threats.slice(0, 8) };
}

/** Wakes a sleeping server in the background so the first scan is not the one that pays for it. */
export const wake = () => call<unknown>("/health", undefined, 45000).catch(() => null);
