(() => {
  'use strict';

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const LIVE_WINDOW_MS = 30000;
  const LEVEL_STEP_MS = 100;
  const HINTS = {
    mic: "Place the phone screen-up on the desk, about a hand's width from your paper. Tap Start, stay quiet for 2 seconds, then write.",
    motion: 'Strap the phone firmly to the forearm of your writing hand. Tap Start, keep your hand still for 2 seconds, then write.',
  };

  let settings = Store.loadSettings();
  const marginFor = (sens) => 22 - 2 * sens; // dB above background; sensitivity 6 -> 10 dB

  /* ---------------------------------------------------------------- tabs */
  let currentTab = 'record';
  function showTab(name) {
    currentTab = name;
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
    $$('.panel').forEach((p) => p.classList.toggle('active', p.id === 'tab-' + name));
    if (name === 'sessions') renderSessions();
    if (name === 'compare') renderCompare();
    if (name === 'record') redrawRecord();
    window.scrollTo({ top: 0 });
  }
  $$('.tab').forEach((b) => b.addEventListener('click', () => {
    if (rec.running && b.dataset.tab !== 'record') {
      toast('Stop the recording first.');
      return;
    }
    showTab(b.dataset.tab);
  }));

  /* ------------------------------------------------------------ settings */
  const sensInput = $('#sensitivity');
  const sensOut = $('#sens-out');
  const pauseSelect = $('#pause-threshold');
  sensInput.value = settings.sensitivity;
  sensOut.textContent = `${settings.sensitivity} / 10`;
  pauseSelect.value = String(settings.pauseMs);
  if (!pauseSelect.value) { pauseSelect.value = '1000'; settings.pauseMs = 1000; }

  sensInput.addEventListener('input', () => {
    settings.sensitivity = Number(sensInput.value);
    sensOut.textContent = `${settings.sensitivity} / 10`;
    Store.saveSettings(settings);
    if (rec.running) {
      rec.det.margin = marginFor(settings.sensitivity);
      rec.det.hyst = Math.min(3, rec.det.margin / 3);
      rec.margin = rec.det.margin;
    }
  });
  pauseSelect.addEventListener('change', () => {
    settings.pauseMs = Number(pauseSelect.value);
    Store.saveSettings(settings);
    if (pending) showResult(pending);
    updateSessionCount();
  });

  $$('input[name="mode"]').forEach((r) => {
    r.checked = r.value === settings.mode;
    r.addEventListener('change', () => {
      if (!r.checked) return;
      settings.mode = r.value;
      Store.saveSettings(settings);
      $('#hint').textContent = HINTS[settings.mode];
    });
  });
  $('#hint').textContent = HINTS[settings.mode];

  /* ----------------------------------------------------------- recording */
  const rec = { running: false, starting: false };
  let pending = null; // finished, not yet saved
  const startBtn = $('#start-btn');
  const statusEl = $('#status');

  startBtn.addEventListener('click', () => (rec.running ? stopRecording() : startRecording()));

  async function startRecording() {
    if (rec.starting) return;
    if (pending && !confirm('Discard the unsaved session and start a new one?')) return;
    clearError();
    pending = null;
    $('#result').hidden = true;

    if (!window.isSecureContext) {
      showError('The page must be opened over https (for example from the GitHub Pages link) to use the sensors.');
      return;
    }

    rec.starting = true;
    startBtn.disabled = true;
    const mode = settings.mode;
    const margin = marginFor(settings.sensitivity);
    const det = new ActivityDetector(margin, LEVEL_STEP_MS);
    let t0 = performance.now();
    const onLevel = (db) => det.push(performance.now() - t0, db);

    let src;
    try {
      // On iPhone the permission prompt must come straight from the tap, so this is the first await.
      src = mode === 'mic'
        ? await Sensors.startMic(onLevel)
        : await Sensors.startMotion(onLevel, () => showError('No motion data is arriving. This browser or device may not share its motion sensors. Try microphone mode.'));
    } catch (e) {
      rec.starting = false;
      startBtn.disabled = false;
      showError(friendlyError(e, mode));
      return;
    }
    t0 = performance.now();

    Object.assign(rec, {
      running: true, starting: false, src, det, mode, margin, t0,
      createdAt: Date.now(), hiddenMs: 0, hiddenAt: null,
    });
    startBtn.disabled = false;
    startBtn.textContent = 'Stop';
    startBtn.classList.add('stop');
    $('.mode-switch').classList.add('locked');
    requestWakeLock();
    rec.raf = requestAnimationFrame(liveLoop);
  }

  function stopRecording() {
    if (!rec.running) return;
    const t = performance.now() - rec.t0;
    rec.running = false;
    cancelAnimationFrame(rec.raf);
    rec.src.stop();
    releaseWakeLock();
    if (rec.hiddenAt != null) rec.hiddenMs += performance.now() - rec.hiddenAt;
    const { segments, levels } = rec.det.finish(t);

    startBtn.textContent = 'Start';
    startBtn.classList.remove('stop');
    $('.mode-switch').classList.remove('locked');
    setStatus('idle', 'Ready');
    $('#live-current').textContent = 'Stopped';

    pending = {
      id: 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      version: 1,
      createdAt: rec.createdAt,
      mode: rec.mode,
      durationMs: Math.round(t),
      marginDb: rec.margin,
      levelStepMs: LEVEL_STEP_MS,
      hiddenMs: Math.round(rec.hiddenMs),
      segments,
      levels,
    };
    drawLive(t);
    showResult(pending, true);
  }

  function liveLoop() {
    if (!rec.running) return;
    const t = performance.now() - rec.t0;
    const det = rec.det;
    $('#timer').textContent = Fmt.clock(t);

    const segs = det.liveSegments(t);
    const sum = Analysis.summarize(segs, settings.pauseMs);
    const clean = Analysis.clean(segs);
    const lastEnd = clean.length ? clean[clean.length - 1][1] : null;
    const gap = lastEnd == null ? null : t - lastEnd;

    if (det.calibrating) {
      setStatus('calibrating', rec.mode === 'mic' ? 'Listening… stay quiet' : 'Hold still…');
      $('#live-current').textContent = 'Calibrating';
    } else if (det.active) {
      setStatus('writing', 'Pen moving');
      $('#live-current').textContent = 'Writing';
    } else {
      setStatus('quiet', 'Quiet');
      $('#live-current').textContent = gap == null ? 'Waiting' : gap >= settings.pauseMs ? 'Pause ' + Fmt.dur(gap) : 'Writing';
    }
    $('#live-writing').textContent = Fmt.dur(sum.writingMs || 0);
    $('#live-pauses').textContent = String(sum.pauseCount || 0);

    drawLive(t, sum.bursts);
    rec.raf = requestAnimationFrame(liveLoop);
  }

  function drawLive(t, bursts) {
    const det = rec.det;
    if (!det) return;
    if (!bursts) bursts = Analysis.bursts(det.segments, settings.pauseMs);
    const end = Math.max(LIVE_WINDOW_MS, t);
    Charts.timeline($('#live-chart'), {
      levels: det.levels, stepMs: LEVEL_STEP_MS, bursts, start: end - LIVE_WINDOW_MS, end,
      margin: det.margin, now: rec.running ? t : null,
    });
  }

  function setStatus(cls, text) {
    if (statusEl.dataset.cls !== cls || statusEl.textContent !== text) {
      statusEl.className = 'status ' + cls;
      statusEl.dataset.cls = cls;
      statusEl.textContent = text;
    }
  }

  function friendlyError(e, mode) {
    const name = e && e.name;
    if (mode === 'mic') {
      if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone access was blocked. Allow the microphone for this page in your browser settings, then tap Start again.';
      if (name === 'NotFoundError') return 'No microphone was found on this device.';
      if (name === 'NotReadableError') return 'The microphone is busy. Close other apps that use it (calls, voice recorder) and try again.';
    }
    return (e && e.message) || 'Something went wrong while starting the sensor.';
  }

  /* wake lock: keep the screen on while recording */
  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator) rec.wake = await navigator.wakeLock.request('screen');
    } catch (e) { rec.wake = null; }
  }
  function releaseWakeLock() {
    try { rec.wake && rec.wake.release(); } catch (e) { /* ignore */ }
    rec.wake = null;
  }
  document.addEventListener('visibilitychange', () => {
    if (!rec.running) return;
    if (document.hidden) {
      rec.hiddenAt = performance.now();
    } else {
      if (rec.hiddenAt != null) rec.hiddenMs += performance.now() - rec.hiddenAt;
      rec.hiddenAt = null;
      requestWakeLock();
    }
  });

  /* ------------------------------------------------------ result & saving */
  function showResult(session, fresh) {
    const sum = Analysis.summarize(session.segments, settings.pauseMs);
    $('#result-summary').innerHTML = summaryHTML(sum, session);
    const card = $('#result');
    card.hidden = false;
    drawSessionChart($('#result-chart'), session, sum);
    if (fresh) {
      $('#save-form').reset();
      $('#save-name').value = defaultName('other');
      $('#save-name').dataset.auto = '1';
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function defaultName(kind) {
    const list = Store.loadSessions();
    if (kind === 'other') return `Session ${list.length + 1}`;
    return `${Fmt.kind(kind)} ${list.filter((s) => s.kind === kind).length + 1}`;
  }

  $('#save-name').addEventListener('input', (e) => { e.target.dataset.auto = ''; });
  $$('input[name="kind"]').forEach((r) => r.addEventListener('change', () => {
    const nameEl = $('#save-name');
    if (nameEl.dataset.auto === '1' || !nameEl.value.trim()) {
      nameEl.value = defaultName(r.value);
      nameEl.dataset.auto = '1';
    }
  }));

  $('#save-form').addEventListener('submit', (e) => {
    e.preventDefault();
    if (!pending) return;
    const kind = ($('input[name="kind"]:checked') || {}).value || 'other';
    const session = Object.assign({}, pending, {
      name: $('#save-name').value.trim() || defaultName(kind),
      kind,
      note: $('#save-note').value.trim(),
    });
    if (!Store.addSession(session)) {
      showError('Could not save: the browser storage is full or disabled (private browsing?). Delete old sessions or save a backup file first.');
      return;
    }
    pending = null;
    $('#result').hidden = true;
    resetLive();
    updateSessionCount();
    toast(`Saved “${session.name}”`);
  });

  $('#discard-btn').addEventListener('click', () => {
    if (!confirm('Discard this session? It will not be saved.')) return;
    pending = null;
    $('#result').hidden = true;
    resetLive();
  });

  function resetLive() {
    rec.det = null;
    $('#timer').textContent = '0:00';
    $('#live-writing').textContent = '0 s';
    $('#live-pauses').textContent = '0';
    $('#live-current').textContent = '–';
    Charts.timeline($('#live-chart'), { levels: [], bursts: [], start: 0, end: LIVE_WINDOW_MS, margin: marginFor(settings.sensitivity) });
  }

  function redrawRecord() {
    if (rec.det) drawLive(rec.running ? performance.now() - rec.t0 : rec.det.lastT);
    else resetLive();
    if (pending && !$('#result').hidden) drawSessionChart($('#result-chart'), pending);
  }

  function drawSessionChart(canvas, session, sum) {
    sum = sum || Analysis.summarize(session.segments, settings.pauseMs);
    Charts.timeline(canvas, {
      levels: session.levels, stepMs: session.levelStepMs || LEVEL_STEP_MS, bursts: sum.bursts,
      start: 0, end: Math.max(session.durationMs, 5000), margin: session.marginDb,
    });
  }

  /* ---------------------------------------------------- summary markup */
  function summaryHTML(s, session) {
    const warnings = [];
    if (session && session.hiddenMs > 1000) {
      warnings.push(`The screen was off or the app was in the background for about ${Fmt.dur(session.hiddenMs)}; that part may show up as a pause.`);
    }
    const warnHTML = warnings.map((w) => `<p class="extra">⚠️ ${esc(w)}</p>`).join('');
    if (s.empty) {
      return `<p class="empty-summary">No writing was detected. Try a quieter room, a pencil or ballpoint on a hard table, or raise the sensitivity in Settings.</p>${warnHTML}`;
    }
    const share = Math.round(s.writingShare * 100);
    const pauseInfo = s.pauseCount
      ? `<div class="sub">middle value ${Fmt.dur(s.medianPauseMs)}</div>`
      : '<div class="sub">no pauses</div>';
    return `
      <div class="metrics">
        <div class="metric"><div class="label">Total time</div><div class="value">${Fmt.dur(s.totalMs)}</div><div class="sub">first to last stroke</div></div>
        <div class="metric"><div class="label">Number of pauses</div><div class="value">${s.pauseCount}</div><div class="sub">${s.pausesPerMin.toFixed(1)} per minute</div></div>
        <div class="metric wide">
          <div class="label">Writing vs pausing</div>
          <div class="share-bar" role="img" aria-label="${share}% writing"><span style="width:${share}%"></span></div>
          <div class="sub">Writing <b>${Fmt.dur(s.writingMs)}</b> (${share}%) · Pausing <b>${Fmt.dur(s.pausingMs)}</b> (${100 - share}%)</div>
        </div>
        <div class="metric"><div class="label">Average pause</div><div class="value">${s.pauseCount ? Fmt.dur(s.avgPauseMs) : '–'}</div>${pauseInfo}</div>
        <div class="metric"><div class="label">Longest pause</div><div class="value">${s.pauseCount ? Fmt.dur(s.longestPauseMs) : '–'}</div><div class="sub">${s.longPauseCount} over 3 s</div></div>
        <div class="metric wide">
          <div class="label">Rhythm steadiness</div>
          <div class="value">${s.steadiness ?? '–'}<span class="sub"> / 100</span></div>
          <div class="sub">${esc(s.steadinessWord)}. High = bursts and pauses of even length; low = stop-and-go.</div>
        </div>
      </div>
      <p class="extra">${s.burstCount} writing ${s.burstCount === 1 ? 'burst' : 'bursts'}, ${Fmt.dur(s.avgBurstMs)} long on average. A pause here means a break of at least ${Fmt.dur(settings.pauseMs)}.</p>
      ${warnHTML}`;
  }

  /* ------------------------------------------------------------ sessions */
  let detailId = null;

  function updateSessionCount() {
    const n = Store.loadSessions().length;
    $('#session-count').textContent = n ? String(n) : '';
  }

  function renderSessions() {
    if (detailId && Store.loadSessions().some((s) => s.id === detailId)) {
      renderDetail(detailId);
      return;
    }
    detailId = null;
    $('#session-detail').hidden = true;
    $('#sessions-list-view').hidden = false;
    const list = Store.loadSessions();
    updateSessionCount();
    const box = $('#sessions-list');
    if (!list.length) {
      box.innerHTML = `<div class="card empty"><p>No saved sessions yet.</p><p class="muted">Record a session on the Record tab and tap “Save session”.</p></div>`;
      return;
    }
    box.innerHTML = list.map((s) => {
      const sum = Analysis.summarize(s.segments, settings.pauseMs);
      const stats = sum.empty
        ? 'no writing detected'
        : `${Fmt.dur(sum.totalMs)} · ${sum.pauseCount} pauses · steadiness ${sum.steadiness ?? '–'}`;
      return `
        <button class="card session-item" data-id="${esc(s.id)}">
          <div class="top"><span class="name">${esc(s.name)}</span><span class="badge ${esc(s.kind)}">${Fmt.kind(s.kind)}</span></div>
          <div class="meta">${esc(Fmt.date(s.createdAt))} · ${s.mode === 'motion' ? 'Motion' : 'Microphone'}</div>
          <div class="meta">${stats}</div>
        </button>`;
    }).join('');
    $$('.session-item', box).forEach((el) => el.addEventListener('click', () => renderDetail(el.dataset.id)));
  }

  function renderDetail(id) {
    const s = Store.loadSessions().find((x) => x.id === id);
    if (!s) { detailId = null; renderSessions(); return; }
    detailId = id;
    const sum = Analysis.summarize(s.segments, settings.pauseMs);
    $('#sessions-list-view').hidden = true;
    const box = $('#session-detail');
    box.hidden = false;
    box.innerHTML = `
      <button class="btn small back" id="detail-back">‹ All sessions</button>
      <div class="card">
        <div class="detail-head">
          <h2>${esc(s.name)}</h2>
          <span class="badge ${esc(s.kind)}">${Fmt.kind(s.kind)}</span>
        </div>
        ${s.note ? `<p class="detail-note">${esc(s.note)}</p>` : ''}
        <p class="muted small">${esc(Fmt.date(s.createdAt))} · ${s.mode === 'motion' ? 'Motion sensors' : 'Microphone'} · recorded for ${Fmt.dur(s.durationMs)}</p>
        ${summaryHTML(sum, s)}
        <canvas id="detail-chart" class="chart chart-full"></canvas>
        <label class="field">Type
          <select id="detail-kind">
            <option value="copied">Copied</option>
            <option value="composed">Composed</option>
            <option value="other">Other</option>
          </select>
        </label>
        <div class="btn-row">
          <button class="btn primary" id="detail-compare">Compare…</button>
          <button class="btn" id="detail-csv">Download CSV</button>
          <button class="btn danger" id="detail-delete">Delete</button>
        </div>
      </div>`;
    drawSessionChart($('#detail-chart'), s, sum);
    const kindSel = $('#detail-kind');
    kindSel.value = s.kind || 'other';
    kindSel.addEventListener('change', () => { Store.updateSession(id, { kind: kindSel.value }); renderDetail(id); });
    $('#detail-back').addEventListener('click', () => { detailId = null; renderSessions(); });
    $('#detail-delete').addEventListener('click', () => {
      if (!confirm(`Delete “${s.name}”? This cannot be undone.`)) return;
      Store.deleteSession(id);
      if (cmp.a === id) cmp.a = null;
      if (cmp.b === id) cmp.b = null;
      detailId = null;
      renderSessions();
      toast('Session deleted');
    });
    $('#detail-csv').addEventListener('click', () => downloadCSV(s));
    $('#detail-compare').addEventListener('click', () => {
      cmp.a = id;
      if (cmp.b === id) cmp.b = null;
      showTab('compare');
    });
    window.scrollTo({ top: 0 });
  }

  function downloadCSV(s) {
    const sum = Analysis.summarize(s.segments, settings.pauseMs);
    const rows = [['type', 'start_s', 'end_s', 'duration_s']];
    const f = (ms) => (ms / 1000).toFixed(2);
    const events = [
      ...sum.bursts.map(([a, b]) => ['burst', a, b]),
      ...sum.pauses.map(([a, b]) => ['pause', a, b]),
    ].sort((x, y) => x[1] - y[1]);
    for (const [type, a, b] of events) rows.push([type, f(a), f(b), f(b - a)]);
    download(`${slug(s.name)}.csv`, rows.map((r) => r.join(',')).join('\n'), 'text/csv');
  }

  $('#export-all').addEventListener('click', () => {
    const list = Store.loadSessions();
    if (!list.length) { toast('Nothing to back up yet.'); return; }
    const data = { app: 'writing-rhythm-recorder', exportedAt: new Date().toISOString(), sessions: list };
    download(`writing-rhythm-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json');
  });

  $('#import-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const items = Array.isArray(data) ? data : data.sessions;
      if (!Array.isArray(items)) throw new Error('bad file');
      const added = Store.importSessions(items);
      if (added < 0) toast('Could not save: browser storage is full.');
      else toast(added ? `Loaded ${added} session${added === 1 ? '' : 's'}` : 'No new sessions in that file');
      renderSessions();
    } catch (err) {
      toast('That file is not a Writing Rhythm backup.');
    }
  });

  function download(filename, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const slug = (s) => (s || 'session').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'session';

  /* ------------------------------------------------------------- compare */
  const cmp = { a: null, b: null };
  const selA = $('#cmp-a');
  const selB = $('#cmp-b');
  selA.addEventListener('change', () => { cmp.a = selA.value; renderCompare(); });
  selB.addEventListener('change', () => { cmp.b = selB.value; renderCompare(); });

  function pickDefaults(list) {
    const has = (id) => id && list.some((s) => s.id === id);
    if (!has(cmp.a)) cmp.a = null;
    if (!has(cmp.b)) cmp.b = null;
    if (!cmp.a) {
      const copied = list.find((s) => s.kind === 'copied' && s.id !== cmp.b);
      cmp.a = (copied || list.find((s) => s.id !== cmp.b && s !== list[0]) || list.find((s) => s.id !== cmp.b)).id;
    }
    if (!cmp.b || cmp.b === cmp.a) {
      const composed = list.find((s) => s.kind === 'composed' && s.id !== cmp.a);
      cmp.b = (composed || list.find((s) => s.id !== cmp.a)).id;
    }
  }

  function renderCompare() {
    const list = Store.loadSessions();
    const enough = list.length >= 2;
    $('#compare-empty').hidden = enough;
    $('#compare-view').hidden = !enough;
    if (!enough) return;
    pickDefaults(list);

    const opt = (s) => `<option value="${esc(s.id)}">${esc(s.name)} (${Fmt.kind(s.kind)})</option>`;
    selA.innerHTML = list.map(opt).join('');
    selB.innerHTML = list.map(opt).join('');
    selA.value = cmp.a;
    selB.value = cmp.b;

    const A = list.find((s) => s.id === cmp.a);
    const B = list.find((s) => s.id === cmp.b);
    const sa = Analysis.summarize(A.segments, settings.pauseMs);
    const sb = Analysis.summarize(B.segments, settings.pauseMs);

    $('#cmp-notes').innerHTML = compareNotes(sa, sb).map((n) => `<li>${n}</li>`).join('');

    // Strips on a shared time scale, both starting at the first stroke.
    $('#strip-a-name').textContent = A.name;
    $('#strip-b-name').textContent = B.name;
    const span = Math.max(sa.totalMs || 0, sb.totalMs || 0, 5000);
    const c = Charts.colors();
    const shift = (sum) => sum.bursts.map(([s, e]) => [s - sum.startMs, e - sum.startMs]);
    Charts.timeline($('#strip-a'), { bursts: sa.empty ? [] : shift(sa), start: 0, end: span, showLevel: false, color: c.a });
    Charts.timeline($('#strip-b'), { bursts: sb.empty ? [] : shift(sb), start: 0, end: span, showLevel: false, color: c.b });

    // Numbers table
    const val = (s, fn) => (s.empty ? '–' : fn(s));
    const rows = [
      ['Total time', (s) => Fmt.dur(s.totalMs)],
      ['Writing time', (s) => Fmt.dur(s.writingMs)],
      ['Pausing time', (s) => Fmt.dur(s.pausingMs)],
      ['Share spent writing', (s) => Fmt.pct(s.writingShare)],
      ['Number of pauses', (s) => String(s.pauseCount)],
      ['Pauses per minute', (s) => s.pausesPerMin.toFixed(1)],
      ['Average pause', (s) => (s.pauseCount ? Fmt.dur(s.avgPauseMs) : '–')],
      ['Middle pause length', (s) => (s.pauseCount ? Fmt.dur(s.medianPauseMs) : '–')],
      ['Longest pause', (s) => (s.pauseCount ? Fmt.dur(s.longestPauseMs) : '–')],
      ['Pauses over 3 s', (s) => String(s.longPauseCount)],
      ['Average burst', (s) => Fmt.dur(s.avgBurstMs)],
      ['Rhythm steadiness', (s) => (s.steadiness == null ? '–' : `${s.steadiness} / 100`)],
    ];
    $('#cmp-table').innerHTML = `
      <thead><tr><th></th><th><span class="tag tag-a">A</span></th><th><span class="tag tag-b">B</span></th></tr></thead>
      <tbody>${rows.map(([label, fn]) => `<tr><td>${label}</td><td>${val(sa, fn)}</td><td>${val(sb, fn)}</td></tr>`).join('')}</tbody>`;

    // Pause-length histogram
    const ba = sa.empty ? [] : sa.buckets;
    const bb = sb.empty ? [] : sb.buckets;
    const labels = (ba.length ? ba : bb).map((x) => x.label);
    const max = Math.max(1, ...ba.map((x) => x.count), ...bb.map((x) => x.count));
    const bar = (cls, n) => `<div class="hist-bar ${cls}"><span style="width:${(n / max) * 85}%"></span><em>${n}</em></div>`;
    $('#cmp-hist').innerHTML = labels.length
      ? labels.map((l, i) => `
        <div class="hist-row"><span class="bucket">${l}</span>
          <div class="hist-bars">${bar('a', ba[i] ? ba[i].count : 0)}${bar('b', bb[i] ? bb[i].count : 0)}</div>
        </div>`).join('') + '<p class="muted small">Number of pauses of each length. Thinking while writing often shows up as more long pauses.</p>'
      : '<p class="muted">No pauses to show.</p>';
  }

  function compareNotes(a, b) {
    const A = '<span class="tag tag-a">A</span>';
    const B = '<span class="tag tag-b">B</span>';
    if (a.empty || b.empty) return ['One of the sessions has no detected writing, so there is nothing to compare.'];
    const notes = [];
    const which = (x, y) => (x > y ? [A, B, x, y] : [B, A, y, x]);

    if (a.pauseCount && b.pauseCount) {
      const [hi, lo, x, y] = which(a.avgPauseMs, b.avgPauseMs);
      const r = x / y;
      if (r >= 1.25) notes.push(`${hi} paused about <b>${r.toFixed(1)}× longer</b> on average than ${lo} (${Fmt.dur(x)} vs ${Fmt.dur(y)}).`);
      else notes.push(`The average pause was about the same length (${Fmt.dur(a.avgPauseMs)} vs ${Fmt.dur(b.avgPauseMs)}).`);

      const [hi2, , x2, y2] = which(a.longestPauseMs, b.longestPauseMs);
      if (x2 / y2 >= 1.5) notes.push(`The longest single pause was in ${hi2}: ${Fmt.dur(x2)} (the other's longest was ${Fmt.dur(y2)}).`);
    } else if (a.pauseCount !== b.pauseCount) {
      notes.push(`${a.pauseCount ? B : A} had no pauses at all.`);
    }

    {
      const [hi, lo, x, y] = which(a.pausesPerMin, b.pausesPerMin);
      if (x - y >= 1 && (!y || x / y >= 1.25)) notes.push(`${hi} stopped more often: ${x.toFixed(1)} pauses per minute vs ${y.toFixed(1)} for ${lo}.`);
    }
    {
      const [hi, , x, y] = which(a.writingShare, b.writingShare);
      if (x - y >= 0.08) notes.push(`${hi} spent more of its time actually writing (${Fmt.pct(x)} vs ${Fmt.pct(y)}).`);
    }
    if (a.steadiness != null && b.steadiness != null) {
      const [hi, , x, y] = which(a.steadiness, b.steadiness);
      if (x - y >= 8) notes.push(`${hi} had the steadier rhythm (steadiness ${x} vs ${y}).`);
      else notes.push(`Both rhythms were similarly steady (${a.steadiness} vs ${b.steadiness}).`);
    }
    if (Math.abs(a.totalMs - b.totalMs) / Math.max(a.totalMs, b.totalMs) > 0.5) {
      notes.push('The two sessions are very different in length, which makes the comparison less fair. Try writing passages of similar length.');
    }
    return notes;
  }

  /* -------------------------------------------------------------- misc */
  function showError(msg) {
    const el = $('#error');
    el.textContent = msg;
    el.hidden = false;
  }
  function clearError() { $('#error').hidden = true; }

  let toastTimer;
  function toast(msg) {
    let el = $('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
  }

  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (currentTab === 'record') redrawRecord();
      if (currentTab === 'sessions' && detailId) {
        const s = Store.loadSessions().find((x) => x.id === detailId);
        if (s) drawSessionChart($('#detail-chart'), s);
      }
      if (currentTab === 'compare') renderCompare();
    }, 150);
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => window.dispatchEvent(new Event('resize')));

  window.addEventListener('beforeunload', (e) => {
    if (rec.running || pending) { e.preventDefault(); e.returnValue = ''; }
  });

  updateSessionCount();
  resetLive();
})();
