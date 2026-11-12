/* Canvas drawing for the live chart, full-session timeline and comparison strips. */
const Charts = (() => {
  function colors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      accent: v('--accent'), soft: v('--accent-soft'), burst: v('--burst'), pause: v('--pause'),
      thresh: v('--thresh'), muted: v('--muted'), border: v('--border'), a: v('--a'), b: v('--b'),
    };
  }

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function tickStep(spanMs, widthPx) {
    const steps = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200, 1800, 3600].map((s) => s * 1000);
    for (const s of steps) if ((s / spanMs) * widthPx >= 56) return s;
    return steps[steps.length - 1];
  }

  /**
   * opts: { levels, stepMs, bursts, start, end, margin, origin, showLevel, color, now }
   *  - start/end: visible time window (ms)
   *  - origin: time shown as 0:00 on the axis
   *  - now: when live, the pause band extends to here
   */
  function timeline(canvas, opts) {
    const { ctx, w, h } = setup(canvas);
    if (!w || !h) return;
    const c = colors();
    const {
      levels = null, stepMs = 100, bursts = [], start = 0, margin = 10, origin = 0,
      showLevel = true, color = c.burst, now = null,
    } = opts;
    const end = Math.max(opts.end, start + 1000);
    const span = end - start;
    const X = (t) => ((t - start) / span) * w;

    const axisH = 16;
    const bandH = showLevel ? 20 : h - axisH - 2;
    const bandTop = h - axisH - bandH;
    const levelTop = 4;
    const levelH = bandTop - 8 - levelTop;

    // --- signal level ---
    if (showLevel && levels && levelH > 10) {
      const lo = -6;
      const hi = Math.max(margin + 24, 30);
      const Y = (v) => levelTop + levelH - ((Math.min(hi, Math.max(lo, v)) - lo) / (hi - lo)) * levelH;
      const i0 = Math.max(0, Math.floor(start / stepMs));
      const i1 = Math.min(levels.length - 1, Math.ceil(end / stepMs));
      const runs = [];
      let run = null;
      for (let i = i0; i <= i1; i++) {
        const v = levels[i];
        if (v == null) { run = null; continue; }
        if (!run) { run = []; runs.push(run); }
        run.push([X(i * stepMs + stepMs / 2), Y(v)]);
      }
      const base = Y(lo);
      for (const r of runs) {
        ctx.beginPath();
        ctx.moveTo(r[0][0], base);
        r.forEach(([x, y]) => ctx.lineTo(x, y));
        ctx.lineTo(r[r.length - 1][0], base);
        ctx.closePath();
        ctx.fillStyle = c.soft;
        ctx.fill();
        ctx.beginPath();
        r.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.strokeStyle = c.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // threshold
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = c.thresh;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, Y(margin));
      ctx.lineTo(w, Y(margin));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // --- bursts & pauses band ---
    if (bursts.length) {
      const first = bursts[0][0];
      const last = now != null ? Math.max(now, bursts[bursts.length - 1][1]) : bursts[bursts.length - 1][1];
      ctx.fillStyle = c.pause;
      roundRect(ctx, X(first), bandTop, Math.max(1, X(last) - X(first)), bandH, 4);
      ctx.fill();
      ctx.fillStyle = color;
      for (const [s, e] of bursts) {
        if (e < start || s > end) continue;
        roundRect(ctx, X(s), bandTop, Math.max(1.5, X(e) - X(s)), bandH, 3);
        ctx.fill();
      }
    } else {
      ctx.strokeStyle = c.border;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(0.5, bandTop + 0.5, w - 1, bandH - 1);
      ctx.setLineDash([]);
    }

    // --- time axis ---
    ctx.fillStyle = c.muted;
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'bottom';
    const step = tickStep(span, w);
    const firstTick = Math.ceil((start - origin) / step) * step + origin;
    for (let t = firstTick; t <= end; t += step) {
      const x = X(t);
      const label = Fmt.clock(t - origin);
      ctx.textAlign = x < 12 ? 'left' : x > w - 12 ? 'right' : 'center';
      ctx.fillText(label, x, h);
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  return { timeline, colors };
})();
