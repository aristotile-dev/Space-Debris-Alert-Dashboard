import type { Scan } from "./api";

function wrap(g: CanvasRenderingContext2D, text: string, x: number, y: number, maxW: number, lh: number, maxLines = 99) {
  const words = text.split(" ");
  let line = "";
  let n = 0;
  for (const w of words) {
    const test = line ? line + " " + w : w;
    if (g.measureText(test).width > maxW && line) {
      g.fillText(line, x, y);
      y += lh;
      line = w;
      if (++n >= maxLines) return y;
    } else line = test;
  }
  if (line) g.fillText(line, x, y);
  return y + lh;
}

/** The close-call card: a 4:5 image made from the current scan, for sharing. */
export async function makeCard(scan: Scan): Promise<Blob> {
  await Promise.all(["400 40px Michroma", "600 30px Sora", "500 24px 'Martian Mono Variable'"].map((f) => document.fonts.load(f).catch(() => null)));
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d")!;
  const bg = g.createRadialGradient(W * 0.3, H * 0.32, 80, W * 0.4, H * 0.45, H * 0.95);
  bg.addColorStop(0, "#2243f0");
  bg.addColorStop(0.4, "#0d1ba8");
  bg.addColorStop(1, "#03062a");
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(217,246,255,${0.15 + rnd() * 0.5})`;
    g.beginPath();
    g.arc(rnd() * W, rnd() * H, 0.6 + rnd() * 1.6, 0, 7);
    g.fill();
  }

  // glass Earth with the two orbits that meet
  const cx = W / 2, cy = 560, R = 250;
  const earth = g.createRadialGradient(cx - 90, cy - 110, 20, cx, cy, R);
  earth.addColorStop(0, "#7fa4ff");
  earth.addColorStop(0.55, "#1f46f0");
  earth.addColorStop(1, "#050d5c");
  g.fillStyle = earth;
  g.beginPath();
  g.arc(cx, cy, R, 0, 7);
  g.fill();
  g.strokeStyle = "rgba(94,242,255,0.28)";
  g.lineWidth = 1.5;
  for (let i = -3; i <= 3; i++) {
    g.beginPath();
    g.ellipse(cx, cy, R, R * Math.abs(Math.cos((i * Math.PI) / 8)) * 0.12 + 0.01, 0, 0, 7);
    g.stroke();
  }
  g.strokeStyle = "rgba(94,242,255,0.8)";
  g.lineWidth = 3;
  g.beginPath();
  g.arc(cx, cy, R, 0, 7);
  g.stroke();
  g.strokeStyle = "#8ff7ff";
  g.lineWidth = 9;
  g.beginPath();
  g.ellipse(cx, cy, R + 70, (R + 70) * 0.34, -0.42, 0, 7);
  g.stroke();
  const hit = scan.threats.length > 0;
  if (hit) {
    g.strokeStyle = "#ff8a3d";
    g.lineWidth = 6;
    g.beginPath();
    g.ellipse(cx, cy, R + 70, (R + 70) * 0.34, 0.5, 0, 7);
    g.stroke();
    const px = cx + 120, py = cy + 112;
    const halo = g.createRadialGradient(px, py, 4, px, py, 54);
    halo.addColorStop(0, "rgba(255,106,26,1)");
    halo.addColorStop(1, "rgba(255,106,26,0)");
    g.fillStyle = halo;
    g.beginPath();
    g.arc(px, py, 54, 0, 7);
    g.fill();
    g.fillStyle = "#ff6a1a";
    g.beginPath();
    g.arc(px, py, 14, 0, 7);
    g.fill();
  }

  const name = scan.target.name.replace(/ \(.*\)/, "");
  g.fillStyle = "#eaf2ff";
  g.textBaseline = "alphabetic";
  g.font = "400 60px Michroma, 'Arial Black', sans-serif";
  const y1 = wrap(g, `Is the ${name} safe?`, 70, 960, W - 140, 76, 2);
  g.font = "600 40px Sora, system-ui, sans-serif";
  g.fillStyle = hit ? "#ffb48a" : "#7dffd6";
  g.fillText(hit ? `${scan.threat_count} close call${scan.threat_count === 1 ? "" : "s"} inside ${scan.threshold_km} km in 24 h` : `All clear inside ${scan.threshold_km} km for 24 h`, 70, y1 + 12);
  g.font = "400 30px Sora, system-ui, sans-serif";
  g.fillStyle = "#cdd9ff";
  if (hit) {
    const t = scan.threats[0];
    wrap(g, `Closest: ${t.name}, ${t.distance_km} km away at ${t.tca_utc.slice(11, 16)} UTC, passing at ${t.rel_speed_kms} km/s.`, 70, y1 + 70, W - 140, 42, 3);
  } else {
    wrap(g, `Nothing in ${scan.objects_total.toLocaleString("en-US")} tracked objects gets that close in the next 24 hours.`, 70, y1 + 70, W - 140, 42, 3);
  }
  g.font = "500 22px 'Martian Mono Variable', monospace";
  g.fillStyle = "#9fb4ee";
  g.fillText(`CASSANDRA ORBIT  ·  ${scan.window.start_utc.slice(0, 10)}  ·  ${scan.source === "live" ? "live orbits" : "orbit snapshot"}`, 70, H - 74);
  g.font = "400 20px Sora, system-ui, sans-serif";
  g.fillText("An estimate from public orbital elements, not a collision probability.", 70, H - 38);

  return new Promise((resolve, reject) => c.toBlob((b) => (b ? resolve(b) : reject(new Error("card failed"))), "image/png"));
}
