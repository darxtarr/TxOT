# IRONCLAD v0.5 — Validation Build

Canvas/DOM hybrid renderer for time tracking. No deps, no build step.

## Run it

```bash
# pick one:
npx serve .
python3 -m http.server 8080
```

Open `http://localhost:3000` (serve) or `:8080` (python) in a browser.

## What you're looking at

- **Canvas layer** renders the weekly grid and all entity rectangles
- **DOM pool** (15 recycled divs) hydrates near your cursor — the green borders
- Only entities within the flashlight radius get DOM nodes; everything else is canvas-only
- Drag any green-bordered entity to reposition it; it snaps to the 15-min grid on release

## Controls

| Control | What it does |
|---------|-------------|
| Entity slider | 50–5000 rectangles |
| Flashlight slider | Radius of DOM hydration zone |
| Quick buttons | Jump to 200 / 500 / 2k / 5k |

## Performance targets

| Metric | Target |
|--------|--------|
| FPS (idle) | 60 |
| Frame time | <16ms |
| Drag latency | <16ms |
| 2000 entities | No stutters |

## Architecture

Plain JS. No TypeScript compilation needed for validation. Will be typed after perf validation passes.

- **SoA** typed arrays for entity data (cache-friendly, zero GC)
- **Frame-stamp dedup** prevents duplicate processing of multi-bucket entities
- **Insertion sort** on small candidate sets (faster than Array.sort for N<100)
- **Pre-allocated buffers** throughout the hot path
- **textContent** stats updates (no innerHTML reparse)
