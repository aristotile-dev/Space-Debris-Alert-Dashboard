import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/michroma/400.css";
import "@fontsource-variable/sora";
import "@fontsource-variable/martian-mono";
import "./styles.css";
import App from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

/** Keep the opening screen up until the fonts and the first view are ready, so nothing jumps or swaps as it opens. */
function openSite() {
  const boot = document.getElementById("boot");
  if (!boot) return;
  const started = performance.now();
  const fonts = Promise.race([
    Promise.all(["400 20px Michroma", "400 16px Sora", "400 12px 'Martian Mono Variable'"].map((f) => document.fonts.load(f).catch(() => null))),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
  const ready = new Promise<void>((resolve) => {
    const tick = () => {
      if (document.querySelector("#root .console")) return setTimeout(resolve, 150);
      setTimeout(tick, 60);
    };
    tick();
  });
  Promise.all([fonts, Promise.race([ready, new Promise((r) => setTimeout(r, 5000))])]).then(() => {
    const wait = Math.max(0, 700 - (performance.now() - started));
    setTimeout(() => {
      boot.classList.add("done");
      setTimeout(() => boot.remove(), 650);
    }, wait);
  });
}
openSite();
