/*
 * Turns raw "pen active" segments into bursts, pauses and summary numbers.
 *
 * Raw segments: [[startMs, endMs], ...] moments where the sensor signal was above
 * the threshold. Short gaps (between letters and words) are folded into bursts;
 * a pause is any gap of at least `pauseMs`.
 */
const Analysis = (() => {
  const MICRO_GAP_MS = 150;   // gaps shorter than this are just noise in the signal
  const MIN_BLIP_MS = 100;    // isolated blips shorter than this are ignored (clicks, bumps)
  const LONG_PAUSE_MS = 3000; // "long pause" for the extra counter

  function mergeGaps(segs, maxGap) {
    const out = [];
    for (const [s, e] of segs) {
      const last = out[out.length - 1];
      if (last && s - last[1] < maxGap) last[1] = Math.max(last[1], e);
      else out.push([s, e]);
    }
    return out;
  }

  function clean(segs) {
    const sorted = segs.filter((x) => x[1] > x[0]).map((x) => [x[0], x[1]]).sort((a, b) => a[0] - b[0]);
    return mergeGaps(sorted, MICRO_GAP_MS).filter(([s, e]) => e - s >= MIN_BLIP_MS);
  }

  function bursts(segs, pauseMs) {
    return mergeGaps(clean(segs), pauseMs);
  }

  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const mean = (a) => (a.length ? sum(a) / a.length : 0);
  function median(a) {
    if (!a.length) return 0;
    const s = [...a].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  function cv(a) {
    if (a.length < 2) return null;
    const m = mean(a);
    if (!m) return null;
    const sd = Math.sqrt(mean(a.map((x) => (x - m) ** 2)));
    return sd / m;
  }

  /** Pause-length buckets starting at the pause threshold: e.g. 1–2 s, 2–5 s, 5–10 s, over 10 s. */
  function pauseBuckets(pauseMs) {
    const edges = [pauseMs, ...[2000, 5000, 10000].filter((x) => x > pauseMs)];
    return edges.map((min, i) => {
      const max = edges[i + 1] ?? Infinity;
      return { min, max, label: max === Infinity ? `over ${fmtSec(min)}` : `${fmtSec(min, true)}–${fmtSec(max)}` };
    });
  }

  function steadinessWord(score) {
    if (score == null) return 'Not enough pauses yet';
    if (score >= 70) return 'Very steady';
    if (score >= 55) return 'Fairly steady';
    if (score >= 40) return 'Uneven';
    return 'Very uneven';
  }

  /**
   * @param {Array} segs raw segments
   * @param {number} pauseMs pause threshold
   */
  function summarize(segs, pauseMs) {
    const b = bursts(segs, pauseMs);
    if (!b.length) {
      return { empty: true, bursts: [], pauses: [], totalMs: 0, writingMs: 0, pausingMs: 0, pauseCount: 0 };
    }
    const start = b[0][0];
    const end = b[b.length - 1][1];
    const burstDur = b.map(([s, e]) => e - s);
    const pauses = [];
    for (let i = 1; i < b.length; i++) pauses.push([b[i - 1][1], b[i][0]]);
    const pauseDur = pauses.map(([s, e]) => e - s);

    const totalMs = end - start;
    const writingMs = sum(burstDur);
    const pausingMs = totalMs - writingMs;

    const cvB = cv(burstDur);
    const cvP = cv(pauseDur);
    let steadiness = null;
    if (pauseDur.length >= 3 && cvB != null && cvP != null) {
      steadiness = Math.round(100 / (1 + (cvB + cvP) / 2));
    }

    const buckets = pauseBuckets(pauseMs).map((bk) => ({
      label: bk.label,
      count: pauseDur.filter((d) => d >= bk.min && d < bk.max).length,
    }));

    return {
      empty: false,
      bursts: b,
      pauses,
      startMs: start,
      endMs: end,
      totalMs,
      writingMs,
      pausingMs,
      writingShare: totalMs ? writingMs / totalMs : 0,
      pauseCount: pauses.length,
      pausesPerMin: totalMs ? pauses.length / (totalMs / 60000) : 0,
      avgPauseMs: mean(pauseDur),
      medianPauseMs: median(pauseDur),
      longestPauseMs: pauseDur.length ? Math.max(...pauseDur) : 0,
      longPauseCount: pauseDur.filter((d) => d >= LONG_PAUSE_MS).length,
      burstCount: b.length,
      avgBurstMs: mean(burstDur),
      cvBursts: cvB,
      cvPauses: cvP,
      steadiness,
      steadinessWord: steadinessWord(steadiness),
      buckets,
    };
  }

  function fmtSec(ms, bare) {
    const s = ms / 1000;
    return (Number.isInteger(s) ? s : s.toFixed(1)) + (bare ? '' : ' s');
  }

  return { clean, bursts, summarize, LONG_PAUSE_MS };
})();

/* Shared formatting helpers */
const Fmt = {
  /** "4.2 s", "1 min 05 s" */
  dur(ms) {
    if (ms == null || isNaN(ms)) return '–';
    const s = ms / 1000;
    if (s < 10) return s.toFixed(1) + ' s';
    if (s < 60) return Math.round(s) + ' s';
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return r === 60 ? `${m + 1} min` : `${m} min ${String(r).padStart(2, '0')} s`;
  },
  /** "1:05" */
  clock(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  },
  pct(x) { return Math.round(x * 100) + '%'; },
  date(ts) {
    return new Date(ts).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  },
  kind(k) { return { copied: 'Copied', composed: 'Composed' }[k] || 'Other'; },
};
