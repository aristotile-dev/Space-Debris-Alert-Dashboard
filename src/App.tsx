import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadDemo, runScan, searchObjects, getCloud, getBriefing, sendChat, wake } from "./api";
import type { Demo, Featured, Scan } from "./api";
import { makeCard } from "./card";

const Globe = lazy(() => import("./Globe"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmt = (n: number) => n.toLocaleString("en-US");
const short = (name: string) => name.replace(/ \(.*\)/, "");
const chip = (name: string) => short(name).replace(/-\d+$/, "");
const day = (utc: string) => new Date(utc.replace(" ", "T") + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const hhmm = (utc: string) => utc.slice(11, 16);

const Icon = {
  search: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="9" cy="9" r="5.5" /><path d="M13.5 13.5 17 17" /></svg>
  ),
  share: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10 3v9M6.5 6.5 10 3l3.5 3.5M4 11v4.5A1.5 1.5 0 0 0 5.5 17h9a1.5 1.5 0 0 0 1.5-1.5V11" /></svg>
  ),
  chat: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 4.5h12a1.5 1.5 0 0 1 1.5 1.5v6a1.5 1.5 0 0 1-1.5 1.5H9l-4 3v-3H4A1.5 1.5 0 0 1 2.5 12V6A1.5 1.5 0 0 1 4 4.5Z" /></svg>
  ),
  child: (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="M7.5 11.5c.7 1.2 4.3 1.2 5 0M7.5 8h.01M12.5 8h.01" /></svg>
  ),
};

interface ChatMsg { role: "user" | "assistant"; content: string }

export default function App() {
  const [demo, setDemo] = useState<Demo | null>(null);
  const [failed, setFailed] = useState(false);
  const [cloud, setCloud] = useState<Float32Array | null>(null);
  const demoCloud = useRef<Float32Array | null>(null);
  const liveCloud = useRef<Float32Array | null>(null);
  const [nDebris, setNDebris] = useState(0);
  const demoDebris = useRef(0);
  const liveDebris = useRef(0);
  const [scan, setScan] = useState<Scan | null>(null);
  const [featured, setFeatured] = useState<Featured[]>([]);
  const [target, setTarget] = useState<Featured | null>(null);
  const [threshold, setThreshold] = useState(50);
  const [source, setSource] = useState<"snapshot" | "live">("snapshot");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<{ text: string; by: string } | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [style, setStyle] = useState<"plain" | "simple">("plain");
  const [chatOpen, setChatOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Featured[]>([]);
  const [sharing, setSharing] = useState(false);
  const [selected, setSelected] = useState<number | null>(null);

  // first paint: the precomputed ISS scan, so the page is alive before the server wakes
  useEffect(() => {
    let off = false;
    loadDemo()
      .then((d) => {
        if (off) return;
        const f = new Float32Array(d.xyz_km);
        demoCloud.current = f;
        demoDebris.current = d.n_debris ?? 0;
        setNDebris(d.n_debris ?? 0);
        setDemo(d);
        setCloud(f);
        setScan(d.scan);
        setFeatured(d.featured);
        setTarget(d.featured[0] ?? null);
        setBrief({ text: d.briefing, by: "rules" });
        wake();
      })
      .catch(() => !off && setFailed(true));
    return () => { off = true; };
  }, []);

  const loadBrief = useCallback(async (s: Scan, st: "plain" | "simple") => {
    setBriefBusy(true);
    try {
      const r = await getBriefing(s, st);
      setBrief({ text: r.text, by: r.by });
    } catch {
      /* the rule-based briefing stays */
    } finally {
      setBriefBusy(false);
    }
  }, []);

  // upgrade the first briefing to the AI one once the server answers
  useEffect(() => {
    if (demo) loadBrief(demo.scan, "plain");
  }, [demo, loadBrief]);

  const run = useCallback(
    async (t: Featured | null = target, thr = threshold, src = source) => {
      if (!t || scanning) return;
      setError(null);
      setScanning(true);
      try {
        const [res] = await Promise.all([runScan(t.id, thr, src), sleep(1900)]);
        if (res.source === "live" && !liveCloud.current) {
          try {
            const c = await getCloud("live");
            liveCloud.current = new Float32Array(c.xyz_km);
            liveDebris.current = c.n_debris ?? 0;
          } catch { /* keep the snapshot cloud */ }
        }
        const useLive = res.source === "live" && !!liveCloud.current;
        setCloud(useLive ? liveCloud.current : demoCloud.current);
        setNDebris(useLive ? liveDebris.current : demoDebris.current);
        setSelected(null);
        setScan(res);
        const mapped = style;
        setBrief(null);
        loadBrief(res, mapped);
      } catch (e: any) {
        setError(e?.message || "The scan failed. Try again.");
      } finally {
        setScanning(false);
      }
    },
    [target, threshold, source, scanning, style, loadBrief]
  );

  // search the whole catalogue for any object
  useEffect(() => {
    if (q.trim().length < 2) { setResults([]); return; }
    const id = setTimeout(() => searchObjects(q).then((r) => setResults(r.results)).catch(() => setResults([])), 250);
    return () => clearTimeout(id);
  }, [q]);

  const pick = (t: Featured) => {
    setTarget(t);
    setQ("");
    setResults([]);
    run(t);
  };

  const band = useMemo<[number, number] | null>(() => (scan ? [scan.target.perigee_km - scan.threshold_km, scan.target.apogee_km + scan.threshold_km] : null), [scan]);

  const share = async () => {
    if (!scan || sharing) return;
    setSharing(true);
    try {
      const blob = await makeCard(scan);
      const file = new File([blob], "cassandra.png", { type: "image/png" });
      if (navigator.canShare?.({ files: [file] })) {
        try { await navigator.share({ files: [file], title: "Cassandra Orbit" }); return; } catch (e: any) { if (e?.name === "AbortError") return; }
      }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "cassandra.png";
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } finally {
      setSharing(false);
    }
  };

  const switchStyle = (st: "plain" | "simple") => {
    setStyle(st);
    if (scan) { setBrief(null); loadBrief(scan, st); }
  };

  if (failed) return <p style={{ padding: 40 }}>Could not load the scan data. Refresh to try again.</p>;
  if (!demo || !scan) return null;

  const name = short(scan.target.name);
  const chosen = scan.threats.find((x) => x.id === selected) ?? null;
  const red = scan.status === "RED";
  const sourcePill = scan.source === "live" ? { text: "Live orbits", date: "", warn: false } : { text: "Snapshot", date: ` · ${day(scan.data_epoch_utc)}`, warn: true };

  const briefBlock = (
    <>
      <p className={briefBusy ? "busy" : undefined} aria-busy={briefBusy}>{brief ? brief.text : "The analyst is writing the briefing…"}</p>
      <div className="row">
        <button className="tag" onClick={() => setChatOpen(true)}>{Icon.chat}Ask the analyst</button>
        <button className={"tag" + (style === "simple" ? " on" : "")} onClick={() => switchStyle(style === "simple" ? "plain" : "simple")} aria-pressed={style === "simple"}>{Icon.child}Explain it simply</button>
        <button className="tag" onClick={share} disabled={sharing}>{Icon.share}{sharing ? "Making card…" : "Share card"}</button>
      </div>
    </>
  );

  return (
    <div className="app">
      <header className="bar">
        <a className="brand" href="/" aria-label="Cassandra Orbit, home">
          <span className="orb" aria-hidden="true" />
          Cassandra Orbit
        </a>
        <nav aria-label="Links">
          <span className={"pill glass" + (sourcePill.warn ? " warn" : "")}><span className="dot" />{sourcePill.text}<span className="pd">{sourcePill.date}</span></span>
          <a className="pill glass hide-s" href="https://github.com/aristotile-dev/Space-Debris-Alert-Dashboard" target="_blank" rel="noreferrer">Source</a>
        </nav>
      </header>

      <main className="console">
        <section className="stage" aria-label="Orbit view">
          <Suspense fallback={null}>
            <Globe cloud={cloud} nDebris={nDebris} scan={scan} scanning={scanning} band={band} selectedId={selected} onPick={setSelected} />
          </Suspense>
          <div className="ask">
            <h1>Is the {name} safe?</h1>
            <div className={"status glass " + (scanning ? "busy" : red ? "red" : "green")} role="status" aria-live="polite">
              <span className="led" aria-hidden="true" />
              <span className="stxt">
                {scanning ? (
                  <>Scanning {fmt(scan.objects_total)} objects…</>
                ) : red ? (
                  <>
                    {fmt(scan.threat_count)} close call{scan.threat_count === 1 ? "" : "s"} inside {scan.threshold_km} km <em>in the next 24 h</em>
                  </>
                ) : (
                  <>
                    All clear inside {scan.threshold_km} km <em>for the next 24 h</em>
                  </>
                )}
              </span>
            </div>
            {chosen && !scanning && (
              <div className="chosen glass" role="status">
                <span className={"risk " + chosen.risk} aria-hidden="true" />
                <b>{chosen.name}</b>
                <span className="num">{chosen.distance_km} km · {chosen.rel_speed_kms} km/s · {hhmm(chosen.tca_utc)} UTC</span>
                <button className="x" onClick={() => setSelected(null)} aria-label="Clear selected orbit">Clear</button>
              </div>
            )}
          </div>
          <div className={"brief glass" + (brief ? "" : " load")}>{briefBlock}</div>
        </section>

        <aside className="panel" aria-label="Scan controls">
          <div className="card glass">
            <h2>Target</h2>
            <div className="chips" role="group" aria-label="Pick a satellite">
              {featured.map((f) => (
                <button key={f.id} className={"tag" + (target?.id === f.id ? " on" : "")} onClick={() => pick(f)} aria-pressed={target?.id === f.id} disabled={scanning}>
                  {chip(f.name)}
                </button>
              ))}
            </div>
            <div className="search">
              {Icon.search}
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Or search any of 18,000 objects" aria-label="Search the catalogue" />
              {results.length > 0 && (
                <div className="results" role="listbox">
                  {results.map((r) => (
                    <button key={r.id} role="option" aria-selected={false} onClick={() => pick(r)}>
                      {r.name}
                      <small>{r.id}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card glass">
            <div className="range">
              <div className="top"><label htmlFor="thr">Alert distance</label><b>{threshold} km</b></div>
              <input id="thr" type="range" min={10} max={200} step={5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
            </div>
            <div className="seg" role="group" aria-label="Orbit data">
              <button className={source === "snapshot" ? "on" : ""} onClick={() => setSource("snapshot")} aria-pressed={source === "snapshot"}>Snapshot</button>
              <button className={source === "live" ? "on" : ""} onClick={() => setSource("live")} aria-pressed={source === "live"}>Live</button>
            </div>
            <p className="hint">
              {source === "snapshot" ? `Fixed orbits from ${day(demo.scan.data_epoch_utc)}. Always works.` : "Today's orbits from CelesTrak."}
            </p>
          </div>

          <button className="go" onClick={() => run()} disabled={scanning || !target}>
            {scanning ? "Scanning…" : `Scan ${short(target?.name ?? "")}`}
          </button>
          {error && <p className="err" role="alert">{error}</p>}
          {scan.note && <p className="hint">{scan.note}</p>}

          <div className="card glass">
            <h2>Closest passes</h2>
            {scan.threats.length ? (
              <ul className="passes">
                {scan.threats.slice(0, 6).map((t) => (
                  <li key={t.id} className={selected === t.id ? "on" : ""}>
                    <button onClick={() => setSelected(selected === t.id ? null : t.id)} aria-pressed={selected === t.id} title="Show this orbit on the globe">
                      <span className={"risk " + t.risk} aria-hidden="true" />
                      <span className="pn">
                        <b>{t.name}</b>
                        <small>{hhmm(t.tca_utc)} UTC · {t.rel_speed_kms} km/s{t.kind === "debris" ? " · debris" : ""}</small>
                      </span>
                      <span className="km">{t.distance_km} km</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="hint">Nothing gets inside {scan.threshold_km} km. Try a bigger alert distance.</p>
            )}
            <dl className="facts">
              <div><dt>Checked</dt><dd>{fmt(scan.objects_total)}</dd></div>
              <div><dt>Skipped</dt><dd>{fmt(scan.objects_screened_out)}</dd></div>
              <div><dt>Refined</dt><dd>{fmt(scan.objects_refined)}</dd></div>
              <div><dt>Scan time</dt><dd>{scan.cached ? "cached" : `${scan.analysis_seconds}s`}</dd></div>
            </dl>
          </div>
        </aside>
        <div className={"brief glass brief-inline" + (brief ? "" : " load")} style={{ display: "none" }}>{briefBlock}</div>
      </main>

      <section className="below" aria-label="Details">
        <div className="tl card glass">
          <h2>The next 24 hours, pass by pass</h2>
          <Timeline scan={scan} selected={selected} onPick={(id) => { setSelected(id); document.scrollingElement?.scrollTo({ top: 0, behavior: "smooth" }); }} />
        </div>

        <div className="fn card glass">
          <h2>How {fmt(scan.objects_total)} objects become {fmt(scan.threat_count)} close call{scan.threat_count === 1 ? "" : "s"}</h2>
          <Funnel scan={scan} />
        </div>

        <details className="allpasses glass">
          <summary>Every close pass as a table ({fmt(scan.threats.length)}{scan.threat_count > scan.threats.length ? ` of ${fmt(scan.threat_count)}` : ""})</summary>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th scope="col">Object</th><th scope="col">Closest</th><th scope="col">When (UTC)</th><th scope="col">Closing speed</th><th scope="col">Risk</th></tr>
              </thead>
              <tbody>
                {scan.threats.map((t) => (
                  <tr key={t.id} className={selected === t.id ? "on" : ""} onClick={() => { setSelected(t.id); document.scrollingElement?.scrollTo({ top: 0, behavior: "smooth" }); }} tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter") { setSelected(t.id); document.scrollingElement?.scrollTo({ top: 0, behavior: "smooth" }); } }}>
                    <td>{t.name}{t.kind === "debris" && <span className="deb">debris</span>}</td>
                    <td className="num">{t.distance_km} km</td>
                    <td className="num">{t.tca_utc}</td>
                    <td className="num">{t.rel_speed_kms} km/s</td>
                    <td><span className={"risk " + t.risk} style={{ display: "inline-block", marginRight: 8, verticalAlign: "-1px" }} />{t.risk.toLowerCase()}</td>
                  </tr>
                ))}
                {!scan.threats.length && <tr><td colSpan={5}>No close passes inside {scan.threshold_km} km.</td></tr>}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <footer className="foot glass">
        <a className="brand" href="/" aria-label="Cassandra Orbit, home">
          <span className="orb" aria-hidden="true" />
          Cassandra Orbit
        </a>
        <p>Not a crystal ball: public orbit data, rough estimates. Globe's not to scale, positions are.</p>
        <nav aria-label="Credits">
          <a className="pill" href="https://github.com/aristotile-dev/Space-Debris-Alert-Dashboard" target="_blank" rel="noreferrer">Source</a>
          <a className="pill" href="https://celestrak.org" target="_blank" rel="noreferrer">CelesTrak data</a>
          <a className="pill" href="https://github.com/aristotile-dev" target="_blank" rel="noreferrer">Aristotile S</a>
        </nav>
      </footer>

      {chatOpen && <Chat scan={scan} onClose={() => setChatOpen(false)} />}
    </div>
  );
}

function Chat({ scan, onClose }: { scan: Scan; onClose: () => void }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const log = useRef<HTMLDivElement>(null);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: "smooth" }); }, [msgs, busy]);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);

  const send = async (text: string) => {
    text = text.trim();
    if (!text || busy) return;
    const next = [...msgs, { role: "user" as const, content: text }];
    setMsgs(next);
    setInput("");
    setBusy(true);
    try {
      const r = await sendChat(text, scan, msgs);
      setMsgs([...next, { role: "assistant", content: r.reply }]);
    } catch (e: any) {
      setMsgs([...next, { role: "assistant", content: e?.message || "That did not go through. Try again." }]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Ask the analyst">
        <header>
          <b>Space analyst</b>
          <button className="tag" onClick={onClose}>Close</button>
        </header>
        <div className="log" ref={log}>
          {!msgs.length && (
            <div className="msg ai">
              <p style={{ margin: "0 0 10px" }}>Ask about this scan: {short(scan.target.name)}, {scan.threat_count} close pass{scan.threat_count === 1 ? "" : "es"} inside {scan.threshold_km} km.</p>
              <div className="sugg">
                {["Is this dangerous?", "Why does closing speed matter?", "What would an operator do?"].map((s) => (
                  <button key={s} className="tag" onClick={() => send(s)}>{s}</button>
                ))}
              </div>
            </div>
          )}
          {msgs.map((m, i) => <div key={i} className={"msg " + (m.role === "user" ? "me" : "ai")}>{m.content}</div>)}
          {busy && <div className="msg ai">Thinking…</div>}
        </div>
        <form onSubmit={(e) => { e.preventDefault(); send(input); }}>
          <input autoFocus value={input} onChange={(e) => setInput(e.target.value)} placeholder="Ask about this scan" aria-label="Your question" />
          <button className="chrome" disabled={!input.trim() || busy}>Send</button>
        </form>
      </aside>
    </>
  );
}

/** The scan as the funnel it really is, drawn from this scan's own numbers (log scale so the small ends stay visible). */
function Funnel({ scan }: { scan: Scan }) {
  const stages = [
    { n: scan.objects_total, label: "Tracked objects", text: "Working satellites plus known debris, except the target itself." },
    { n: scan.objects_propagated, label: "Share its altitude", text: "Objects that never reach the target's altitude are skipped before any maths." },
    { n: scan.objects_refined, label: "Pass close by", text: "Flown 24 hours with SGP4, then the close ones re-checked second by second." },
    { n: scan.threat_count, label: `Inside ${scan.threshold_km} km`, text: "The close calls: the orbits on the globe and what the analyst explains." },
  ];
  const top = Math.log10(stages[0].n + 1);
  const h = stages.map((s) => Math.max(0.16, Math.log10(s.n + 1) / top));
  const pts = h.map((v, i) => `${(i / (stages.length - 1)) * 100},${50 - v * 46}`).concat([...h].reverse().map((v, i) => `${((stages.length - 1 - i) / (stages.length - 1)) * 100},${50 + v * 46}`));
  return (
    <ol className="funnel">
      <svg className="pipe" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="pipeg" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.5" />
            <stop offset="0.5" stopColor="#5ef2ff" stopOpacity="0.16" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.32" />
          </linearGradient>
        </defs>
        <polygon points={pts.join(" ")} fill="url(#pipeg)" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="0.5" vectorEffect="non-scaling-stroke" />
      </svg>
      {stages.map((s, i) => (
        <li key={s.label} className={i === stages.length - 1 ? "last" : ""}>
          <b className="num">{fmt(s.n)}</b>
          <h3>{s.label}</h3>
          <p>{s.text}</p>
        </li>
      ))}
    </ol>
  );
}

/** Every pass on one 24-hour strip: across is when it happens, up is how far away, a bigger bead is a faster pass. */
function Timeline({ scan, selected, onPick }: { scan: Scan; selected: number | null; onPick: (id: number) => void }) {
  const W = 1000, H = 270, L = 56, R = 18, T = 14, B = 42;
  const thr = scan.threshold_km;
  const xs = (sec: number) => L + (sec / 86400) * (W - L - R);
  const ys = (km: number) => T + (1 - Math.min(km, thr) / thr) * (H - T - B);
  const start = new Date(scan.window.start_utc.replace(" ", "T") + "Z");
  const at = (h: number) => new Date(start.getTime() + h * 3600000);
  const hourLabel = (h: number) => at(h).getUTCHours().toString().padStart(2, "0") + ":00";
  const dayMark = (h: number) => (at(h).getUTCHours() === 0 ? at(h).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }) : "");
  const hi = Math.min(25, thr), mid = Math.min(50, thr);
  return (
    <div className="tlwrap">
      <svg viewBox={`0 0 ${W} ${H}`} role="group" aria-label="Close passes over the next 24 hours">
        <rect x={L} y={ys(hi)} width={W - L - R} height={H - B - ys(hi)} fill="#ff6a1a" opacity="0.16" />
        {mid > hi && <rect x={L} y={ys(mid)} width={W - L - R} height={ys(hi) - ys(mid)} fill="#ffc24a" opacity="0.1" />}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line x1={L} x2={W - R} y1={T + f * (H - T - B)} y2={T + f * (H - T - B)} stroke="#fff" strokeOpacity="0.12" />
            <text x={L - 10} y={T + f * (H - T - B) + 4} textAnchor="end" className="tlt">{Math.round(thr * (1 - f))} km</text>
          </g>
        ))}
        {Array.from({ length: 9 }, (_, i) => i * 3).map((h) => (
          <g key={h}>
            <line x1={xs(h * 3600)} x2={xs(h * 3600)} y1={T} y2={H - B} stroke="#fff" strokeOpacity={h % 24 === 0 ? 0.3 : 0.08} />
            <text x={xs(h * 3600)} y={H - B + 18} textAnchor="middle" className="tlt">{hourLabel(h)}</text>
            {dayMark(h) && <text x={xs(h * 3600)} y={H - B + 32} textAnchor="middle" className="tlt d">{dayMark(h)}</text>}
          </g>
        ))}
        {scan.threats.map((t) => {
          const r = 4 + Math.min(t.rel_speed_kms, 14) * 0.55;
          const on = selected === t.id;
          const col = t.risk === "HIGH" ? "#ff6a1a" : t.risk === "MEDIUM" ? "#ffc24a" : "#5ef2ff";
          return (
            <g key={t.id} className={"bead" + (on ? " on" : "")} tabIndex={0} role="button" aria-label={`${t.name}, ${t.distance_km} kilometres at ${t.tca_utc} UTC, ${t.rel_speed_kms} kilometres per second`} onClick={() => onPick(t.id)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(t.id); } }}>
              <title>{`${t.name}: ${t.distance_km} km at ${t.tca_utc.slice(11, 16)} UTC, ${t.rel_speed_kms} km/s`}</title>
              {t.kind === "debris" ? (
                <rect x={xs(t.seconds_from_start) - r} y={ys(t.distance_km) - r} width={r * 2} height={r * 2} transform={`rotate(45 ${xs(t.seconds_from_start)} ${ys(t.distance_km)})`} fill={col} fillOpacity={on ? 1 : 0.8} stroke="#fff" strokeOpacity={on ? 1 : 0.55} strokeWidth={on ? 2.4 : 1} />
              ) : (
              <circle cx={xs(t.seconds_from_start)} cy={ys(t.distance_km)} r={r} fill={col} fillOpacity={on ? 1 : 0.8} stroke="#fff" strokeOpacity={on ? 1 : 0.55} strokeWidth={on ? 2.4 : 1} />
              )}
              {on && <circle cx={xs(t.seconds_from_start)} cy={ys(t.distance_km)} r={r + 7} fill="none" stroke="#fff" strokeOpacity="0.7" />}
            </g>
          );
        })}
      </svg>
      <p className="hint">Across: when it happens. Up: farther away. Bigger bead: faster pass. Tap a bead to see its orbit on the globe.</p>
    </div>
  );
}
