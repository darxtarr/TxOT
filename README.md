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

## Validation results (v0.5)

Tested 2025-02-07 on local machine and enterprise CloudPC (VDI, software-rendered).

**Local machine:** Rock solid 60fps across all entity counts and settings.

**CloudPC (VDI):**

| Scenario | FPS | Feel |
|----------|-----|------|
| Idle (any count) | 32 (VDI cap) | Solid |
| 500 entities, 150px radius | 32 | Solid |
| 2000 entities, 150px radius | 32 | Solid |
| 5000 entities, 150px radius | 32 | Solid |
| 5000 entities, 500px radius (~2500 candidates) | 14 | Noticeable lag |

**Conclusions:**
- The canvas/DOM hybrid approach **passes validation** on CloudPC
- 32fps is the VDI display ceiling — we hit it in all realistic scenarios
- ~10x headroom over real-world usage (500 entities smooth vs 50-100 expected)
- Only bottleneck: insertion sort at extreme candidate counts (2500+). Fix is trivial (cap scan at pool size) but unnecessary at real scale

**Verdict: Architecture holds. No pivot needed.**

## Architecture

Plain JS. No TypeScript compilation needed for validation. Will be typed after perf validation passes.

- **SoA** typed arrays for entity data (cache-friendly, zero GC)
- **Frame-stamp dedup** prevents duplicate processing of multi-bucket entities
- **Insertion sort** on small candidate sets (faster than Array.sort for N<100)
- **Pre-allocated buffers** throughout the hot path
- **textContent** stats updates (no innerHTML reparse)
