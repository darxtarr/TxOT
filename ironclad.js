/**
 * IRONCLAD ENGINE v0.5.3 — Validation Build
 *
 * Canvas/DOM hybrid renderer for time tracking on software-rendered CloudPCs.
 * No dependencies. No build step.
 *
 * Canvas is full content-height (1472px). The browser scrolls it natively.
 * No re-render on scroll — the baked texture is always correct.
 */

// ─── Config ─────────────────────────────────────────────────────────────────

const CONFIG = {
    // Layout (px)
    LEFT_GUTTER: 56,
    TOP_HEADER: 32,
    DAY_WIDTH: 180,
    HOUR_HEIGHT: 60,

    // Time — full 24h, scrollable
    DAYS: 7,
    START_HOUR: 0,
    END_HOUR: 24,

    // Engine
    FLASHLIGHT_RADIUS: 150,
    POOL_SIZE: 15,
    BUCKET_WIDTH: 200,
    MAX_ENTITIES: 10000,
    MAX_BUCKETS: 100,
};

const DAY_LABELS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
const HOURS = CONFIG.END_HOUR - CONFIG.START_HOUR; // 24
const SNAP_Y = CONFIG.HOUR_HEIGHT / 4; // 15-minute grid
const CONTENT_HEIGHT = CONFIG.TOP_HEADER + HOURS * CONFIG.HOUR_HEIGHT; // 1472px

// Task label fragments
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
        this.container.style.overflowY = 'scroll';
        this.container.style.overflowX = 'hidden';

        // Spacer — in normal flow, creates the scrollable height.
        this.spacer = document.createElement('div');
        this.spacer.style.cssText = `height:${CONTENT_HEIGHT}px;pointer-events:none;`;
        this.container.appendChild(this.spacer);

        // ── SoA entity storage ──
        this.count = 0;
        this.ids   = new Int32Array(CONFIG.MAX_ENTITIES);
        this.xs    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.ys    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.ws    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.hs    = new Float32Array(CONFIG.MAX_ENTITIES);
        this.types = new Uint8Array(CONFIG.MAX_ENTITIES);
        this.labels = new Array(CONFIG.MAX_ENTITIES);

        // ── Spatial index ──
        this.buckets = new Array(CONFIG.MAX_BUCKETS);
        for (let i = 0; i < CONFIG.MAX_BUCKETS; i++) this.buckets[i] = [];

        // ── Frame-stamp dedup ──
        this.frameStamp = new Uint32Array(CONFIG.MAX_ENTITIES);
        this.currentFrame = 0;

        // ── Pre-allocated candidate buffers ──
        this.candidateIdx  = new Int32Array(CONFIG.MAX_ENTITIES);
        this.candidateDist = new Float64Array(CONFIG.MAX_ENTITIES);
        this.candidateCount = 0;

        // ── DOM pool ──
        this.pool = [];

        // ── Canvas — full content-height, browser scrolls natively ──
        this.dpr = window.devicePixelRatio || 1;
        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText =
            'position:absolute;top:0;left:0;pointer-events:none;';
        this.container.appendChild(this.canvas);
        this.ctx = this.canvas.getContext('2d', { alpha: false });
        if (!this.ctx) throw new Error('Canvas 2D unavailable');

        // ── Scroll state ──
        this.scrollY = 0;

        // ── Input state ──
        // mouseX/mouseY are CONTENT-space (scroll-adjusted)
        this.mouseX = -9999;
        this.mouseY = -9999;
        this._lastVY = -9999; // viewport-relative Y, for scroll recalc
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

        // ── Stats panel (on body, not in scroll container) ──
        this._buildStatsPanel();

        // ── Init ──
        this._initPool();
        this._bindInput();
        this._resize();

        this._raf = (now) => {
            this._tick(now);
            requestAnimationFrame(this._raf);
        };

        window.addEventListener('resize', () => this._resize());
    }

    // ── Public ──────────────────────────────────────────────────────────

    start(n = 500) {
        this._generate(n);
        this.prevTime = performance.now();
        requestAnimationFrame(this._raf);
        // Scroll to 8am
        this.container.scrollTop = 8 * CONFIG.HOUR_HEIGHT;
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
    // Full content-height canvas. Bakes the entire 24h grid + all entities.
    // Browser scrolls the canvas natively — zero re-render on scroll.

    _render() {
        const W = this.canvas.width;
        const H = this.canvas.height;
        const ctx = this.ctx;
        const dpr = this.dpr;

        ctx.fillStyle = '#0e0e12';
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        ctx.scale(dpr, dpr);

        const gx = CONFIG.LEFT_GUTTER;
        const gy = CONFIG.TOP_HEADER;
        const dw = CONFIG.DAY_WIDTH;
        const hh = CONFIG.HOUR_HEIGHT;
        const gridR = gx + CONFIG.DAYS * dw;

        // Day headers
        ctx.fillStyle = '#999';
        ctx.font = '600 11px monospace';
        ctx.textAlign = 'center';
        for (let d = 0; d < CONFIG.DAYS; d++) {
            ctx.fillText(DAY_LABELS[d], gx + d * dw + dw * 0.5, gy - 10);
        }

        // Hour labels
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        for (let h = 0; h <= HOURS; h++) {
            ctx.fillStyle = '#555';
            const label = String(CONFIG.START_HOUR + h).padStart(2, '0') + ':00';
            ctx.fillText(label, gx - 8, gy + h * hh + 4);
        }

        // Hour lines
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
            ctx.lineTo(x, gy + HOURS * hh);
        }
        ctx.stroke();

        // Entities — full bake, no culling
        for (let i = 0; i < this.count; i++) {
            const t = this.types[i];
            ctx.fillStyle = TYPE_COLORS[t][0];
            ctx.fillRect(this.xs[i], this.ys[i], this.ws[i], this.hs[i]);
            ctx.strokeStyle = TYPE_COLORS[t][1];
            ctx.strokeRect(this.xs[i], this.ys[i], this.ws[i], this.hs[i]);
        }

        // Text pass — full bake
        const LINE_H = 14;
        const TEXT_PAD = 6;
        ctx.font = '600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
        ctx.textBaseline = 'top';

        for (let i = 0; i < this.count; i++) {
            const eh = this.hs[i];
            if (eh < 20) continue;

            const ex = this.xs[i];
            const ey = this.ys[i];
            const maxW = this.ws[i] - TEXT_PAD * 2;
            const lines = this.labels[i];
            let ty = ey + 4;

            ctx.fillStyle = '#ddd';
            ctx.fillText(lines[0], ex + TEXT_PAD, ty, maxW);
            ty += LINE_H;

            if (ty + LINE_H > ey + eh) continue;
            ctx.font = '10px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
            ctx.fillStyle = '#888';

            for (let l = 1; l < 5; l++) {
                if (ty + LINE_H > ey + eh) break;
                ctx.fillText('- ' + lines[l], ex + TEXT_PAD, ty, maxW);
                ty += LINE_H;
            }

            ctx.font = '600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif';
        }

        ctx.restore();
    }

    // ── Input ───────────────────────────────────────────────────────────

    _bindInput() {
        this.container.addEventListener('mousemove', (e) => {
            const r = this.container.getBoundingClientRect();
            this.mouseX = e.clientX - r.left;
            this._lastVY = e.clientY - r.top;
            this.mouseY = this._lastVY + this.container.scrollTop;

            if (this.dragIdx >= 0) {
                this.dragInputTime = performance.now();
                this.xs[this.dragIdx] = this.mouseX - this.dragOffX;
                this.ys[this.dragIdx] = this.mouseY - this.dragOffY;
                this.dirty = true;
            }
        });

        this.container.addEventListener('scroll', () => {
            this.scrollY = this.container.scrollTop;
            // Canvas is full-height — browser scrolls it natively, no re-render needed.
            // Only update content-space mouse position for flashlight.
            if (this._lastVY !== -9999) {
                this.mouseY = this._lastVY + this.scrollY;
                this.prevMY = -9999; // force flashlight update
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

            // Snap Y to 15-min grid
            const relY = this.ys[i] - CONFIG.TOP_HEADER;
            this.ys[i] = Math.round(relY / SNAP_Y) * SNAP_Y + CONFIG.TOP_HEADER;

            // Clamp Y within 24h
            this.ys[i] = Math.max(CONFIG.TOP_HEADER,
                Math.min(this.ys[i], CONFIG.TOP_HEADER + (HOURS - 1) * CONFIG.HOUR_HEIGHT));

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
        const w = Math.round(r.width * this.dpr);
        const h = Math.round(CONTENT_HEIGHT * this.dpr);
        // Guard: setting canvas dimensions clears the buffer
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.canvas.style.width = r.width + 'px';
            this.canvas.style.height = CONTENT_HEIGHT + 'px';
        }
        this.dirty = true;
    }

    // ── Stats ───────────────────────────────────────────────────────────

    _buildStatsPanel() {
        const el = document.createElement('div');
        el.className = 'perf-stats';
        document.body.appendChild(el);

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

            // 80% work hours (7-19), 20% full 24h
            let hour;
            if (Math.random() < 0.8) {
                hour = 7 + Math.random() * 12;
            } else {
                hour = Math.random() * 24;
            }

            const dur = 0.25 + Math.random() * 2.75;
            const clampedDur = Math.min(dur, 24 - hour);

            this.ids[i]   = i;
            this.xs[i]    = gx + col * dw + pad;
            this.ys[i]    = gy + hour * hh;
            this.ws[i]    = dw - pad * 2;
            this.hs[i]    = clampedDur * hh;
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
        this.prevMX = -9999;
        for (let i = 0; i < this.pool.length; i++) this.pool[i].style.display = 'none';
    }
}
