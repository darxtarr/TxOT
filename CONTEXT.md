# IRONCLAD ENGINE - Technical Brief & Context

## Project Overview

**Purpose**: Build a time tracking + team scheduling web app for CloudPC environments (5-20 users) with ZERO GPU assistance. Must be fast enough locally to survive the double network hop (local → CloudPC → server).

**Why**: Prevent another half-assed SharePoint portal from being commissioned. Show what a fast, usable interface looks like.

**Reference UI**: Tempo Timesheets for Jira - week view with drag-and-drop task scheduling.

## Critical Constraints

1. **Target Hardware**: Anemic CloudPCs with software rendering only
2. **Backend**: Messy enterprise data sources (ServiceNow, custom APIs, 10-60s query times)
3. **Architecture**: Self-contained EC2 server with nightly ETL sync, fast WebSocket connection to clients
4. **Team Size**: 5-20 concurrent users
5. **Philosophy**: "Think twice, code once" - minimal dependencies, surgical implementations

## Current Phase: VALIDATION

**Goal**: Prove the canvas/DOM hybrid rendering approach works on CloudPC before building the full system.

**Success Metrics**:
- 60fps idle on local machine
- <16ms drag latency
- No stutters with 2000-5000 rectangles
- If it's not instant locally, it won't work in VDI

## Architectural Decisions Made

### Rendering Strategy: "The Two-Layer Approach"

1. **Canvas (Bedrock Layer)**: Static background, grid, and passive entity rendering
   - DPR-aware for Retina displays
   - Only redraws on data change or resize (dirty flag)
   - Optimized for batch rendering (Structure of Arrays)

2. **DOM Pool (Interactive Layer)**: Fixed set of recycled DOM nodes for interaction
   - "Flashlight" hydration: only entities near mouse cursor get DOM proxies
   - Pool size: 15 nodes (configurable)
   - Zero GC pressure from DOM creation/destruction

### Data Structure: Structure of Arrays (SoA)
```typescript
// Instead of Entity[] (Array of Structures)
private ids: Int32Array;
private xs: Float32Array;
private ys: Float32Array;
private ws: Float32Array;
private hs: Float32Array;
private types: Uint8Array;
```

**Why**: Cache-friendly iteration, no pointer chasing, easy to batch operations.

### Spatial Indexing: Bucket-based for Wide Layouts

- X-axis bucketing (timeline apps are horizontally dominant)
- Bucket width: 200px (approximately 1 day column)
- Entities indexed into all buckets they span (not center-point)
- Rebuild on drag-drop only (not during drag)

### Key Insights from Multi-Model Review

**From GPT**: 
- Frame stamp deduplication for multi-bucket entities
- Camera abstraction for view transforms
- Lifecycle management (ResizeObserver)

**From Gemini**:
- Intrusive linked lists for spatial hash (head[] + next[] arrays)
- "Transient drag layer" - don't rebuild index during drag
- Zero-allocation philosophy

**From Sonnet (Me)**:
- Squared distance checks (no sqrt)
- Insertion sort for small candidate sets (<100 items)
- Incremental index updates instead of full rebuilds
- Delta checks on mouse movement

**Critical Corrections**:
- Center-point indexing is WRONG for wide entities - must span buckets
- Map<number, Int32Array> in hot loop is slow - use flat arrays
- Full index rebuild on mouseUp is acceptable for 5k entities (~2-4ms)

## UI Requirements

### View Layout
- Week view (7 days including weekend for OOH work)
- 15-minute grid granularity
- Hour-based Y-axis (08:00 - 18:00 typical work hours)
- Day-based X-axis columns

### Interaction Patterns
- Drag tasks from backlog/list into calendar slots
- Resize task duration by dragging edges
- Snap to 15-minute grid on drop
- Visual feedback during drag (optimistic UI)

### Data Model (Minimal for PoC)
```typescript
interface Task {
    id: number;
    x: number;      // World X position (day offset)
    y: number;      // World Y position (time offset)
    w: number;      // Width (typically 1 day column - 20px padding)
    h: number;      // Height (duration in pixels)
    type: number;   // Task type (0=Task, 1=Event, 2=Milestone)
    // Future: title, assignee, project, etc.
}
```

## Backend Architecture (Future Phase)
```
Enterprise Hell (ServiceNow, etc.)
         ↓ Nightly ETL
    EC2 Server (Fast DB + WebSocket)
         ↓ Real-time sync
    IRONCLAD Clients (CloudPCs)
```

### Server-Client Protocol (Planned)
```typescript
// Server → Client
type ServerEvent = 
  | { type: 'snapshot', tasks: Task[] }
  | { type: 'task_moved', id: number, x: number, y: number, userId: number }
  | { type: 'task_created', task: Task }
  | { type: 'task_deleted', id: number }

// Client → Server
type ClientCommand =
  | { type: 'move_task', id: number, x: number, y: number }
  | { type: 'resize_task', id: number, w: number, h: number }
```

### Backend Tech Stack (Preference)
- SQLite + Litestream (Boutique choice: simple, fast, S3 backup)
- WebSocket server in Bun/Deno
- No CRDT needed - server arbitrates conflicts (last write wins)

## Current Implementation: v0.5 (Validation Build)

Single file: `ironclad.js` (no build step, no deps).

### Validated & Working
- Canvas rendering with DPR awareness
- DOM pool with SDF flashlight hydration (edge-distance, not center-distance)
- Spatial bucketing (X-axis, flat arrays, frame-stamp dedup)
- Pre-allocated candidate buffers (zero hot-path allocation)
- Insertion sort for small candidate sets
- Drag and drop with grid snap (15-min Y, day-column X)
- Performance instrumentation (FPS, frame time, candidate count, drag latency)
- Text labels per entity (title + 4 bullet lines)
- Arrow rAF callback (no .bind() per frame)
- textContent stats (no innerHTML churn)

### Known Issue
- Text labels render at wrong coordinates (position mismatch with entity rects). Under investigation.

### Attempted & Reverted
- 24h scrollable day view (3 attempts, all had scroll issues). Reverted to 10h (8am-6pm).
  Scroll will be revisited after validation is complete.

## Product Vision

### What this becomes
A time tracker + team scheduler. "Bloomberg terminal in a browser" — always-on, stateful,
information-dense, built for power users. Not a web app with pages.

### Page layout — Quake-style panels
Screen real estate is critical (1920x1080 minus non-fullscreened VDI = ~1600x900 effective).

- **Calendar** is the main stage, always visible. Week view on load, collapses to single day
  during active work (for Outlook visual continuity — vertical days). Week view available
  via hotkey for planning.
- **Panels slide in on demand** from any edge (top/bottom/left/right) at Yakuake speed (~200-300ms).
  They overlay the calendar when open, consume zero space when closed.
  - Service list — hotkey or labelled button to invoke
  - Task stockpile (staging area) — all open tasks, auto-sorted by urgency
  - Detail pane — click or mod+click on any entity to inspect/edit
  - Full calendar — if collapsed to single day, hotkey restores full week

### Task lifecycle
```
Double-click service → creates task (pre-scoped to service) → Staging
                                                                 ↓
Team member picks task (or plans future work) → drags to Calendar slot
                                                                 ↓
                                                          Active / Scheduled
```

### Data model
- **Service** — reference entity. "Who pays for the time." Contains metadata that
  auto-populates new tasks. A service can have many tasks.
- **Task** — the unit of work. Must reference at least one service.
  Many-to-many: one CVE can affect multiple services, one service can have multiple tasks.
- **Staging** — not a backend state, just "task without a scheduled time."
  Task is in staging until dragged to a calendar slot.
- **Not a full ticketing system** — no subtasks or process pipelines (yet).

### Staging auto-sort
Tasks in staging auto-sort by urgency. Higher priority and "expiring soon" tasks
bubble toward the top-left. Gives the team a natural "grab the next thing" workflow.
Note: auto-sort means the spatial index needs periodic rebuilds even without user input
(timer or server-push trigger).

### Flashlight — full viewport
The SDF flashlight is not limited to the calendar. ALL interactive elements across
the entire page (services, staging tasks, buttons, panels) are flashlight-hydrated.
This enables seamless cross-zone drag (staging → calendar) without DOM zone handoffs.

The exception is text input: `<input>` and `<textarea>` are real DOM elements that
materialize on focus (search, task titles, descriptions, notes). Everything else
is canvas + flashlight.

## Backend (exists in ../txxt)

The backend is already built in the sibling repo `txxt`:
- **Server**: Rust/axum, single binary, serves static frontend + REST API + WebSocket
- **Storage**: redb (embedded, single-file, no external service)
- **Auth**: JWT (currently dev-mode, insecure by design until hardening phase)
- **API**: REST under /api/* + WebSocket at /api/ws for real-time sync
- **Data model**: Task (id, title, description, status, priority, category, tags,
  due_date, assigned_to, timestamps), User, Service

The Clay/WASM frontend was dropped (team pushback on ecosystem complexity).
txxt2 (IRONCLAD) replaces it with vanilla JS — same philosophy, accessible stack.

## Code Style

- No external dependencies — EVER
- Typed arrays for perf-critical data
- Comments explain WHY not WHAT
- Plain JS for now. TypeScript AFTER validation passes.
- "Think twice, code once"
