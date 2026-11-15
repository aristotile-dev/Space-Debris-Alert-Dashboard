# Design

The visual world of Cassandra Orbit: **Y2K chrome-future**. A glass Earth inside a 2000s space-age console. One surface, the orbit console, carries it.

## Scene

Someone opens the link on a laptop, usually in the evening, and wants a verdict fast. A deep ultramarine ground, glass capsules and one bright tangerine alert read on any screen in any light, and the glass Earth is the only large shape on the page.

## Color

Strategy: **committed**. Ultramarine owns the page, aqua is the interactive color, tangerine appears only when something is wrong.

| Role | Token | Value |
|---|---|---|
| Ground, deepest | `--abyss` | `#03062a` |
| Ground | `--navy` | `#060d4a` |
| Ground, mid | `--ultra` | `#0c1a9a` |
| Brand, bright | `--cobalt` | `#2447ff` |
| Interactive, selected | `--aqua` | `#5ef2ff` |
| Text on glass | `--ice` | `#d9f6ff` |
| Body text | `--text` | `#eaf2ff` |
| Secondary text | `--text-2` | `#b9c8f2` |
| Chrome light / mid / dark | `--chrome-1` `--chrome-2` `--chrome-3` | `#f3f7ff` `#b9c6e6` `#7886b0` |
| All clear | `--mint` | `#7dffd6` |
| Alert (only for threats) | `--tangerine` | `#ff6a1a` |
| Ink on light controls | `--ink` | `#04093a` |

Rule: tangerine never decorates. It marks a conjunction, a threat orbit, a HIGH risk dot, nothing else. Medium risk is amber `#ffc24a`, low risk is aqua.

## Typography

- **Display: Michroma** (400, self-hosted, extended techno caps). The question headline, the brand, capsule labels, the scan button. Sentence case for the headline, uppercase with `0.08em` to `0.14em` tracking for small labels and the button.
- **UI: Sora variable.** Body, chips, buttons, table cells.
- **Readouts: Martian Mono variable** with tabular numerals. Distances, times, speeds, counts. Never used as decoration.
- Scale: headline `clamp(24px, 3vw, 48px)`, body 14 to 15px, labels 11 to 13px. Body measure stays under 70ch.

## Surfaces and depth

- **Glass capsule** (`.glass`): a white to transparent top light over translucent ultramarine, a 1px white-30% border, an inner top highlight, a soft inner bottom shade, a deep offset shadow, `backdrop-filter: blur(16px) saturate(160%)`. The glass is the world's material, so it appears on every panel and nowhere else.
- **Chrome** (`.chrome`, the selected segment, the slider thumb): a vertical silver gradient with a hard horizon at 50%, the way early-2000s metal buttons were drawn.
- **Aqua pill** (`.go`, the selected chip): a glossy aqua gradient with a bright top edge and a hard bottom lip, pressed state drops 2px.
- Radii: one small family. 14px for cards, 10px for chips, buttons, status and pills, 8px for the segmented control. Only LEDs and orbs are round.

## Components

- **Status capsule**: an LED (green, tangerine blinking, or aqua scanning) plus one sentence. It is the answer, so it sits directly under the headline.
- **Chips and segments**: pill chips for targets, a two-way segmented control for snapshot and live.
- **Slider**: a recessed groove with a chrome orb thumb.
- **Pass row**: risk dot, object name, mono time and speed, mono distance on the right.
- **Table**: a glass block, display-face column heads, mono numbers.
- **Chat drawer**: a solid ultramarine sheet, rounded 28px, chrome sent bubbles and glass reply bubbles.

## The globe

Three.js, no textures. A glass sphere (fresnel rim, one specular highlight), a 15-degree lat/long grid, a dim atmosphere. **The Earth is drawn at 62% of true size so the orbits and the debris shell stay readable; every position is true.** The catalogue is a point cloud; the target's altitude band lights aqua, and a white sweep expands from the target while a scan runs. The target orbit is a glossy aqua tube, threat orbits are thinner tangerine tubes, the closest approach is a pulsing tangerine marker with a pill label that flips sides at the screen edge.

## Motion

One authored moment: the scan. The camera glides in on load, then the catalogue sweeps aqua to white while the status LED blinks, and settles into the result. Everything else is a short exponential ease-out. Reduced motion removes the fly-in, the sweep pulse and the blink.

## Layout

- Desktop (above 1000px): a full-bleed globe stage on the left, a 344 to 424px control column on the right, a 58px top bar. At 1534x740 the whole answer and every control fit without scrolling.
- Below 1000px: stage, briefing, then controls, in one column.
- Below the fold: every close pass in a table, how the scan works, the honesty note.

## Rules

- No eyebrow labels above headings, no numbered sections, no gradient text.
- Glow is reserved for LEDs and risk dots (status lights), not for panels.
- Copy is plain, sentence case, controls name their action ("Scan ISS"), and every number that is an estimate says so.
