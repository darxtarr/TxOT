/**
 * IRONCLAD ENGINE v0.5 — Validation Build
 *
 * Canvas/DOM hybrid renderer for time tracking on software-rendered CloudPCs.
 * No dependencies. No build step.
 *
 * Fixed from multi-model review:
 *  - Frame-stamp dedup for multi-bucket entities
 *  - Pre-allocated candidate arrays (zero hot-path allocation)
 *  - Flat array spatial index (no Map in hot loop)
 *  - Arrow rAF callback (no .bind() per frame)
 *  - Per-frame drag latency (not cumulative)
 *  - textContent stats (no innerHTML churn)
 *  - Grid snap derived from HOUR_HEIGHT, not magic numbers
 */

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
    // Layout (px)
    LEFT_GUTTER: 56,
    TOP_HEADER: 32,
    DAY_WIDTH: 180,
    HOUR_HEIGHT: 60,

    // Time
    DAYS: 7,
    START_HOUR: 8,
    END_HOUR: 18,

    // Engine
    FLASHLIGHT_RADIUS: 150,
    POOL_SIZE: 15,
    BUCKET_WIDTH: 200,
    MAX_ENTITIES: 10000,
    MAX_BUCKETS: 100,
};

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const HOURS = CONFIG.END_HOUR - CONFIG.START_HOUR;
const SNAP_Y = CONFIG.HOUR_HEIGHT / 4; // 15-minute grid

// Task label fragments — verbose on purpose, text is dead weight we measure
const LABEL_VERBS = ['Review', 'Update', 'Fix', 'Deploy', 'Test', 'Write', 'Plan', 'Design', 'Debug', 'Refactor'];
const LABEL_NOUNS = ['API docs', 'homepage', 'auth flow', 'dashboard', 'CI pipeline', 'database', 'UI tests', 'sprint plan', 'onboarding', 'backlog'];
const LABEL_REASONS = [
    'Needs sign-off from stakeholders before EOD Friday',
    'Blocked until the upstream API migration completes',
    'Critical path item for the Q3 release milestone',
    'Compliance requirement from the latest security audit',
    'Technical debt accumulated over the last three sprints',
    'Dependency on the shared component library upgrade',
    'Performance regression flagged in last week\'s report',
    'Requested by product owner during sprint planning',
];
const LABEL_BULLETS = [
    'Verify all edge cases against the test matrix',
    'Update the integration tests for new endpoints',
    'Cross-reference with the ServiceNow ticket backlog',
    'Coordinate with DevOps on the deployment window',
    'Document any breaking changes in the changelog',
    'Run load tests against staging before merge',
    'Get peer review from at least two team members',
    'Sync with the design system token updates',
    'Check backwards compatibility with legacy clients',
    'Validate against the accessibility requirements',
];

// Entity type colors: [fill, stroke]
const TYPE_COLORS = [
    ['#1e3a5f', '#3a7bd5'], // Task — blue
    ['#1a4a3a', '#2d9b7a'], // Event — teal
    ['#4a3a1a', '#b4882d'], // Milestone — amber
];

// ─── Engine ─────────────────────────────────────────────────────────────────

class IroncladEngine {
    constructor(containerId) {
        const el = document.getElementById(containerId);
        if (!el) throw new Error(`#${containerId} not found`);
        this.container = el;
        this.container.style.position = 'relative';
        this.container.style.overflow = 'hidden';

        // ── SoA entity storage ──
        this.count = 0;
        this.ids   = new Int32Array(CONFIG.MAX_ENTITIES);
        this.xs    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.ys    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.ws    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.hs    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.types = new Uint8Array(CONFIG.MAX_ENTITIES);
        this.labels = new Array(CONFIG.MAX_ENTITIES); // strings can't live in typed arrays

        // ── Spatial index: array-of-arrays, reused via length reset ──
        this.buckets = new Array(CONFIG.MAX_BUCKETS);
        for (let i = 0; i < CONFIG.MAX_BUCKETS; i++) this.buckets[i] = [];

        // ── Frame-stamp dedup (entities spanning multiple buckets) ──
        this.frameStamp = new Uint32Array(CONFIG.MAX_ENTITIES);
        this.currentFrame = 0;

        // ── Pre-allocated candidate buffers (zero alloc in hot path) ──
        this.candidateIdx  = new Int32Array(CONFIG.MAX_ENTITIES);
        this.candidateDist = new Float64Array(CONFIG.MAX_ENTITIES);
        this.candidateCount = 0;

        // ── DOM pool ──
        this.pool = [];

        // ── Canvas ──
        this.dpr = window.devicePixelRatio || 1;
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        if (!this.ctx) throw new Error('Canvas 2D unavailable');

        // ── Input state ──
        this.mouseX = -9999;
        this.mouseY = -9999;
        this.prevMX = -9999;
        this.prevMY = -9999;
        this.dirty = true;

        // ── Drag state ──
        this.dragIdx = -1;
        this.dragOffX = 0;
        this.dragOffY = 0;
        this.dragInputTime = 0;

        // ── Perf ring buffer ──
        this.frameTimes = new Float64Array(60);
        this.ftHead = 0;
        this.ftCount = 0;
        this.prevTime = 0;
        this.stats = { fps: 0, frameTime: 0, candidates: 0, dragLatency: 0 };

        // ── Stats panel ──
        this._buildStatsPanel();

        // ── Init ──
        this._initPool();
        this._bindInput();
        this._resize();

        // Arrow function — bound once, reused every frame
        this._raf = (now) => {
            this._tick(now);
            requestAnimationFrame(this._raf);
        };

        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => this._resize()).observe(this.container);
        }
        window.addEventListener('resize', () => this._resize());
    }

    // ── Public ──────────────────────────────────────────────────────────

    start(n = 500) {
        this._generate(n);
        this.prevTime = performance.now();
        requestAnimationFrame(this._raf);
    }

    setEntityCount(n) {
        this._generate(Math.max(1, Math.min(n | 0, CONFIG.MAX_ENTITIES)));
    }

    setFlashlightRadius(r) {
        CONFIG.FLASHLIGHT_RADIUS = Math.max(20, Math.min(r | 0, 600));
    }

    // ── Pool ────────────────────────────────────────────────────────────

    _initPool() {
        for (let i = 0; i < CONFIG.POOL_SIZE; i++) {
            const d = document.createElement('div');
            d.className = 'proxy';
            d.style.cssText =
                'position:absolute;display:none;box-sizing:border-box;' +
                'border:2px solid #00ffcc;background:rgba(0,255,204,0.06);' +
                'cursor:grab;z-index:10;will-change:transform;' +
                'border-radius:3px;';
            this.container.appendChild(d);
            this.pool.push(d);
        }
    }

    // ── Spatial index ───────────────────────────────────────────────────

    _rebuildIndex() {
        for (let b = 0; b < CONFIG.MAX_BUCKETS; b++) this.buckets[b].length = 0;

        for (let i = 0; i < this.count; i++) {
            const b0 = (this.xs[i] / CONFIG.BUCKET_WIDTH) | 0;
            const b1 = ((this.xs[i] + this.ws[i]) / CONFIG.BUCKET_WIDTH) | 0;
            for (let b = b0; b <= b1; b++) {
                if (b >= 0 && b < CONFIG.MAX_BUCKETS) this.buckets[b].push(i);
            }
        }
    }

    // ── Tick ────────────────────────────────────────────────────────────

    _tick(now) {
        const dt = now - this.prevTime;
        this.prevTime = now;

        this.frameTimes[this.ftHead] = dt;
        this.ftHead = (this.ftHead + 1) % 60;
        if (this.ftCount < 60) this.ftCount++;

        const moved = this.mouseX !== this.prevMX || this.mouseY !== this.prevMY;
        if (moved || this.dragIdx >= 0) {
            this._flashlight();
            this.prevMX = this.mouseX;
            this.prevMY = this.mouseY;
        }

        if (this.dirty) {
            this._render();
            this.dirty = false;
        }

        if (this.dragIdx >= 0 && this.dragInputTime > 0) {
            this.stats.dragLatency = performance.now() - this.dragInputTime;
        }

        this._showStats();
    }

    // ── Flashlight ──────────────────────────────────────────────────────

    _flashlight() {
        this.candidateCount = 0;
        this.currentFrame++;

        const rSq = CONFIG.FLASHLIGHT_RADIUS * CONFIG.FLASHLIGHT_RADIUS;
        const cb = (this.mouseX / CONFIG.BUCKET_WIDTH) | 0;

        for (let b = cb - 1; b <= cb + 1; b++) {
            if (b < 0 || b >= CONFIG.MAX_BUCKETS) continue;
            const bk = this.buckets[b];
            for (let j = 0, len = bk.length; j < len; j++) {
                const i = bk[j];

                if (this.frameStamp[i] === this.currentFrame) continue;
                this.frameStamp[i] = this.currentFrame;

                const dx = (this.xs[i] + this.ws[i] * 0.5) - this.mouseX;
                const dy = (this.ys[i] + this.hs[i] * 0.5) - this.mouseY;
                const dSq = dx * dx + dy * dy;

                if (dSq <= rSq) {
                    const c = this.candidateCount++;
                    this.candidateIdx[c] = i;
                    this.candidateDist[c] = dSq;
                }
            }
        }

        this.stats.candidates = this.candidateCount;

        // Insertion sort — typically <50 candidates
        for (let i = 1; i < this.candidateCount; i++) {
            const kd = this.candidateDist[i];
            const ki = this.candidateIdx[i];
            let j = i - 1;
            while (j >= 0 && this.candidateDist[j] > kd) {
                this.candidateDist[j + 1] = this.candidateDist[j];
                this.candidateIdx[j + 1] = this.candidateIdx[j];
                j--;
            }
            this.candidateDist[j + 1] = kd;
            this.candidateIdx[j + 1] = ki;
        }

        const n = Math.min(this.candidateCount, CONFIG.POOL_SIZE);
        for (let i = 0; i < CONFIG.POOL_SIZE; i++) {
            const p = this.pool[i];
            if (i < n) {
                const idx = this.candidateIdx[i];
                if (p.dataset.idx !== String(idx)) {
                    p.dataset.idx = String(idx);
                    p.style.width = this.ws[idx] + 'px';
                    p.style.height = this.hs[idx] + 'px';
                }
                p.style.transform = `translate(${this.xs[idx]}px,${this.ys[idx]}px)`;
                if (p.style.display !== 'block') p.style.display = 'block';
            } else {
                if (p.style.display !== 'none') p.style.display = 'none';
            }
        }
    }

    // ── Canvas render ───────────────────────────────────────────────────

    _render() {
        const W = this.canvas.width;
        const H = this.canvas.height;
        const ctx = this.ctx;
        const dpr = this.dpr;

        ctx.fillStyle = '#0e0e12';
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.scale(dpr, dpr);

        const lw = W / dpr;
        const lh = H / dpr;
        const gx = CONFIG.LEFT_GUTTER;
        const gy = CONFIG.TOP_HEADER;
        const dw = CONFIG.DAY_WIDTH;
        const hh = CONFIG.HOUR_HEIGHT;
        const gridR = gx + CONFIG.DAYS * dw;
        const gridB = gy + HOURS * hh;

        // Day headers
        ctx.fillStyle = '#999';
        ctx.font = '600 11px monospace';
        ctx.textAlign = 'center';
        for (let d = 0; d < CONFIG.DAYS; d++) {
            ctx.fillText(DAY_LABELS[d], gx + d * dw + dw * 0.5, gy - 10);
        }

        // Hour labels
        ctx.fillStyle = '#555';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        for (let h = 0; h <= HOURS; h++) {
            const label = String(CONFIG.START_HOUR + h).padStart(2, '0') + ':00';
            ctx.fillText(label, gx - 8, gy + h * hh + 4);
        }

        // Hour grid lines
        ctx.strokeStyle = '#252530';
        ctx.lineWidth = 1;
        ctx.beginPath();
        for (let h = 0; h <= HOURS; h++) {
            const y = gy + h * hh + 0.5;
            ctx.moveTo(gx, y);
            ctx.lineTo(gridR, y);
        }
        ctx.stroke();

        // 15-min sub-lines
        ctx.strokeStyle = '#18181f';
        ctx.beginPath();
        for (let h = 0; h < HOURS; h++) {
            for (let q = 1; q < 4; q++) {
                const y = gy + h * hh + q * SNAP_Y + 0.5;
                ctx.moveTo(gx, y);
                ctx.lineTo(gridR, y);
            }
        }
        ctx.stroke();

        // Day dividers
        ctx.strokeStyle = '#252530';
        ctx.beginPath();
        for (let d = 0; d <= CONFIG.DAYS; d++) {
            const x = gx + d * dw + 0.5;
            ctx.moveTo(x, gy);
            ctx.lineTo(x, gridB);
        }
        ctx.stroke();

        // Entities — rects first, then text (fewer fillStyle flips)
        for (let i = 0; i < this.count; i++) {
            const ey = this.ys[i];
            if (ey > lh || ey + this.hs[i] < 0) continue;

            const t = this.types[i];
            ctx.fillStyle = TYPE_COLORS[t][0];
            ctx.fillRect(this.xs[i], ey, this.ws[i], this.hs[i]);
            ctx.strokeStyle = TYPE_COLORS[t][1];
            ctx.strokeRect(this.xs[i], ey, this.ws[i], this.hs[i]);
        }

        // Text pass — separate loop, font set once
        // Each entity has [title, bullet, bullet, bullet, bullet]
        // Lines rendered based on available height (~15px per line)
        const LINE_H = 14;
        const TEXT_PAD = 6;
        ctx.font = '600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
        ctx.textBaseline = 'top';

        for (let i = 0; i < this.count; i++) {
            const ey = this.ys[i];
            const eh = this.hs[i];
            if (ey > lh || ey + eh < 0) continue;
            if (eh < 20) continue;

            const ex = this.xs[i];
            const maxW = this.ws[i] - TEXT_PAD * 2;
            const lines = this.labels[i];
            let ty = ey + 4;

            // Title (bold weight already set)
            ctx.fillStyle = '#ddd';
            ctx.fillText(lines[0], ex + TEXT_PAD, ty, maxW);
            ty += LINE_H;

            // Bullets — dimmer, normal weight
            if (ty + LINE_H > ey + eh) continue;
            ctx.font = '10px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
            ctx.fillStyle = '#888';

            for (let l = 1; l < 5; l++) {
                if (ty + LINE_H > ey + eh) break;
                ctx.fillText('- ' + lines[l], ex + TEXT_PAD, ty, maxW);
                ty += LINE_H;
            }

            // Reset bold for next entity's title
            ctx.font = '600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
        }

        ctx.restore();
    }

    // ── Input ───────────────────────────────────────────────────────────

    _bindInput() {
        this.container.addEventListener('mousemove', (e) => {
            const r = this.container.getBoundingClientRect();
            this.mouseX = e.clientX - r.left;
            this.mouseY = e.clientY - r.top;

            if (this.dragIdx >= 0) {
                this.dragInputTime = performance.now();
                this.xs[this.dragIdx] = this.mouseX - this.dragOffX;
                this.ys[this.dragIdx] = this.mouseY - this.dragOffY;
                this.dirty = true;
            }
        });

        this.container.addEventListener('mousedown', (e) => {
            const t = e.target;
            if (!t.classList || !t.classList.contains('proxy')) return;
            const idx = parseInt(t.dataset.idx);
            if (isNaN(idx) || idx < 0 || idx >= this.count) return;

            this.dragIdx = idx;
            this.dragOffX = this.mouseX - this.xs[idx];
            this.dragOffY = this.mouseY - this.ys[idx];
            t.style.cursor = 'grabbing';
            e.preventDefault();
        });

        window.addEventListener('mouseup', () => {
            if (this.dragIdx < 0) return;
            const i = this.dragIdx;

            // Snap Y to 15-min grid, relative to header offset
            const relY = this.ys[i] - CONFIG.TOP_HEADER;
            this.ys[i] = Math.round(relY / SNAP_Y) * SNAP_Y + CONFIG.TOP_HEADER;

            // Snap X to day column
            const col = Math.round((this.xs[i] - CONFIG.LEFT_GUTTER - 10) / CONFIG.DAY_WIDTH);
            const clamped = Math.max(0, Math.min(col, CONFIG.DAYS - 1));
            this.xs[i] = CONFIG.LEFT_GUTTER + clamped * CONFIG.DAY_WIDTH + 10;

            this._rebuildIndex();
            this.dirty = true;
            this.dragIdx = -1;
            this.dragInputTime = 0;
            for (let p = 0; p < this.pool.length; p++) this.pool[p].style.cursor = 'grab';
        });
    }

    // ── Resize ──────────────────────────────────────────────────────────

    _resize() {
        const r = this.container.getBoundingClientRect();
        this.canvas.width = r.width * this.dpr;
        this.canvas.height = r.height * this.dpr;
        this.canvas.style.width = r.width + 'px';
        this.canvas.style.height = r.height + 'px';
        this.dirty = true;
    }

    // ── Stats ───────────────────────────────────────────────────────────

    _buildStatsPanel() {
        const el = document.createElement('div');
        el.className = 'perf-stats';
        this.container.appendChild(el);

        this._spans = {};
        for (const k of ['fps', 'frame', 'entities', 'candidates', 'drag']) {
            const s = document.createElement('div');
            el.appendChild(s);
            this._spans[k] = s;
        }
    }

    _showStats() {
        let sum = 0;
        for (let i = 0; i < this.ftCount; i++) sum += this.frameTimes[i];
        const avg = this.ftCount > 0 ? sum / this.ftCount : 16.67;

        this.stats.fps = Math.round(1000 / avg);
        this.stats.frameTime = Math.round(avg * 10) / 10;

        const s = this._spans;
        s.fps.textContent        = 'FPS: ' + this.stats.fps;
        s.frame.textContent      = 'Frame: ' + this.stats.frameTime + 'ms';
        s.entities.textContent   = 'Entities: ' + this.count;
        s.candidates.textContent = 'Near cursor: ' + this.stats.candidates;
        s.drag.textContent = this.dragIdx >= 0
            ? 'Drag: ' + this.stats.dragLatency.toFixed(1) + 'ms'
            : 'Drag: idle';
    }

    // ── Data generation ─────────────────────────────────────────────────

    _generate(count) {
        const gx = CONFIG.LEFT_GUTTER;
        const gy = CONFIG.TOP_HEADER;
        const dw = CONFIG.DAY_WIDTH;
        const hh = CONFIG.HOUR_HEIGHT;
        const pad = 10;

        for (let i = 0; i < count; i++) {
            const col = (Math.random() * CONFIG.DAYS) | 0;
            const hour = Math.random() * (HOURS - 1);
            const dur = 0.25 + Math.random() * 2.75; // 15min — 3h

            this.ids[i]   = i;
            this.xs[i]    = gx + col * dw + pad;
            this.ys[i]    = gy + hour * hh;
            this.ws[i]    = dw - pad * 2;
            this.hs[i]    = dur * hh;
            this.types[i] = (Math.random() * 3) | 0;

            const verb = LABEL_VERBS[(Math.random() * LABEL_VERBS.length) | 0];
            const noun = LABEL_NOUNS[(Math.random() * LABEL_NOUNS.length) | 0];
            const reason = LABEL_REASONS[(Math.random() * LABEL_REASONS.length) | 0];
            this.labels[i] = [
                verb + ' ' + noun + ': ' + reason,
                LABEL_BULLETS[(Math.random() * LABEL_BULLETS.length) | 0],
                LABEL_BULLETS[(Math.random() * LABEL_BULLETS.length) | 0],
                LABEL_BULLETS[(Math.random() * LABEL_BULLETS.length) | 0],
                LABEL_BULLETS[(Math.random() * LABEL_BULLETS.length) | 0],
            ];
        }

        this.count = count;
        this._rebuildIndex();
        this.dirty = true;

        // Force flashlight refresh on next frame
        this.prevMX = -9999;
        // Hide stale proxies
        for (let i = 0; i < this.pool.length; i++) this.pool[i].style.display = 'none';
    }
}
