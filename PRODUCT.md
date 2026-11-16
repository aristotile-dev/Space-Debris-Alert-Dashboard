# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Confirmed by the user: React + Vite + TypeScript frontend on Vercel, FastAPI backend as a folder inside the existing Hugging Face Space `totz07/wafer-defect-api` (the `projects/<name>/api.py` pattern, mounted at `/<name>`), moving off Streamlit. Today the app is one Streamlit file (`app.py`) deployed on Streamlit Cloud.

## Users

Two audiences at once, per the user: (1) a portfolio viewer (recruiter, engineer) who opens the live link and should be impressed within seconds; (2) the project standing on its own as a real, interesting product for space-curious people. The task in both cases: pick a satellite, run a scan, understand whether it is in danger in the next 24 hours.

## Product Purpose

A space traffic alert tool. It takes orbital elements (TLEs) for 18,000+ tracked objects (working satellites plus known debris from the big breakups), propagates them over the next 24 hours, and finds objects that pass within a chosen distance of a target satellite (ISS, Hubble, a Starlink). It flags GREEN or RED, lists the threats, shows the closest approach in 3D, and gives a plain recommendation. Success: a first-time visitor understands the situation and is impressed ("wow factor", the user's words), and the numbers are physically sound.

## Positioning

The mechanism a neighbour could not copy-paste: a real physics scan (Skyfield/SGP4 propagation of the whole catalogue, 1-minute steps over 24 h) run live against a chosen satellite, shown as an actual orbit scene, with the threat explained in plain language. The earlier version is a form plus a table.

## Operating Context

Data source: CelesTrak `active` TLE group (`https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle`). A bundled snapshot `active.txt` (13,163 objects, epoch late Oct 2025) is the offline fallback, so the app always works. The current analysis loops over objects in Python and takes about 17 s for the ISS; it should be vectorised so a scan feels instant. Targets today: ISS (25544), Hubble (20580), Starlink-4328 (51094). Alert threshold slider 10 to 500 km (default 100). Risk rule today: under 25 km is HIGH-RISK (maneuver recommended), under 50 km MEDIUM, otherwise monitor.

## Capabilities and Constraints

Existing, to preserve: hybrid data (local backup plus live fetch), 24 h conjunction scan at 1-minute steps, threshold slider, target picker, GREEN/RED status, threat table (name, id, closest distance, time of closest approach UTC), 3D plot of the closest approach, insight and recommendation text, metrics (analysis time, objects checked, alerts found).

New (user wants a plan, not decided): an LLM layer. The user answered "we have to plan what we can do", so the AI scope is open; Groq or Gemini are the available providers (no Claude API key). Open decisions: what the AI does, and whether a chat is included.

Constraints: free hosting only (Vercel frontend, HF Space CPU backend); no heavy model needed; conjunction distance here is an approximation from TLE data (sampled at 1-minute steps, no covariance), so copy must not present it as an operational collision probability.

## Brand Commitments

Name today: "Cassandra Orbit" (renamed from "Cassandra Orbit Dashboard"; the repo keeps its name). The user chose a new visual world for this project, not the Waferscope lime/pink family. Gen-Z, bold voice, plain language, no jargon dumps. Layout rules carried from the series: fits the first screen at about 1534x740, no voids and no congestion, smooth responsiveness, a loader at the start.

## Evidence on Hand

`active.txt` (the original TLE snapshot, 13,163 objects; now replaced by a fresher snapshot plus a debris file), `app.py` (working analysis logic), two screenshots of the Streamlit app, the live Streamlit URL `https://space-alert-dashboard-try1.streamlit.app/` (currently redirecting). No testimonials, user numbers or benchmarks exist; none may be invented. README raw image links point at an old GitHub account (`ARISTOTILE-GIT`) and must be replaced.

## Product Principles

1. The scan is the product: show a real run, with real numbers, in the first seconds.
2. Honest physics: label approximations, never imply operational collision probabilities.
3. Always works: the bundled snapshot keeps the app alive when live data fails.
4. Plain language first, physics detail one click away.
5. Fast enough to feel live: a scan should take seconds, not tens of seconds.

## Accessibility & Inclusion

No product-specific standard was named. Treat WCAG AA contrast, visible focus, reduced-motion support and keyboard operation as the baseline; the 3D scene needs a non-visual equivalent (the threat table and written briefing).
