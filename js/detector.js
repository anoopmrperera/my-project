/*
 * Decides, frame by frame, whether the pen is moving.
 *
 * It receives a signal level in decibels (from the microphone or motion sensors)
 * about 20 times a second. For the first 2 seconds it learns the background
 * level ("noise floor"). After that, anything clearly louder than the floor
 * (by `marginDb`) counts as writing. A small hysteresis stops flickering.
 */
class ActivityDetector {
  constructor(marginDb, levelStepMs = 100) {
    this.margin = marginDb;
    this.hyst = Math.min(3, marginDb / 3);
    this.step = levelStepMs;
    this.calMs = 2000;
    this.cal = [];
    this.floor = null;
    this.active = false;
    this.openStart = null;
    this.segments = [];
    this.levels = []; // level above floor (dB) per step, null = no data / calibrating
    this.lastT = 0;
  }

  get calibrating() { return this.floor === null; }

  push(t, db) {
    if (!isFinite(db)) return;
    this.lastT = t;

    if (this.floor === null) {
      this.cal.push(db);
      if (t >= this.calMs && this.cal.length >= 5) {
        const s = [...this.cal].sort((a, b) => a - b);
        // A low percentile ignores the odd bump during calibration.
        this.floor = s[Math.floor(s.length * 0.3)];
      }
      return;
    }

    const rel = db - this.floor;
    if (!this.active && rel > this.margin) {
      this.active = true;
      this.openStart = t;
    } else if (this.active && rel < this.margin - this.hyst) {
      this.active = false;
      this.segments.push([this.openStart, t]);
      this.openStart = null;
    }

    // Track slow changes in background noise: follow drops quickly, rises slowly,
    // and never adapt upward while writing.
    if (db < this.floor) this.floor += (db - this.floor) * 0.05;
    else if (!this.active) this.floor += Math.min(db - this.floor, this.margin / 2) * 0.002;

    const i = Math.floor(t / this.step);
    const v = Math.max(-20, Math.min(80, Math.round(rel * 10) / 10));
    while (this.levels.length < i) this.levels.push(null);
    this.levels[i] = this.levels[i] == null ? v : Math.max(this.levels[i], v);
  }

  /** Segments including the one still open, for live display. */
  liveSegments(t) {
    return this.active ? [...this.segments, [this.openStart, t]] : this.segments;
  }

  finish(t) {
    if (this.active) {
      this.segments.push([this.openStart, t]);
      this.active = false;
      this.openStart = null;
    }
    return { segments: this.segments.map(([s, e]) => [Math.round(s), Math.round(e)]), levels: this.levels };
  }
}
