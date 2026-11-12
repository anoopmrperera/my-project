/*
 * Signal sources. Each one calls onLevel(dB) about every 50 ms and returns
 * an object with stop(). No audio or motion data is stored, only the level.
 */
const Sensors = (() => {
  const FRAME_MS = 50;

  /** Microphone: loudness of the high-pitched "scratch" band, where pen-on-paper sound lives. */
  async function startMic(onLevel) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser cannot use the microphone. Open the page in Safari or Chrome over https.');
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    if (ctx.state === 'suspended') await ctx.resume();

    const src = ctx.createMediaStreamSource(stream);
    // Two high-pass stages: cut voices, hum and table thumps, keep the scratch.
    const hp1 = ctx.createBiquadFilter();
    hp1.type = 'highpass';
    hp1.frequency.value = 2000;
    const hp2 = ctx.createBiquadFilter();
    hp2.type = 'highpass';
    hp2.frequency.value = 2000;
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0;
    // Some browsers only process nodes that lead to the speakers; a silent gain keeps it running.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(hp1).connect(hp2).connect(analyser).connect(mute).connect(ctx.destination);

    const useFloat = typeof analyser.getFloatTimeDomainData === 'function';
    const fbuf = new Float32Array(analyser.fftSize);
    const bbuf = new Uint8Array(analyser.fftSize);

    const timer = setInterval(() => {
      let acc = 0;
      if (useFloat) {
        analyser.getFloatTimeDomainData(fbuf);
        for (let i = 0; i < fbuf.length; i++) acc += fbuf[i] * fbuf[i];
      } else {
        analyser.getByteTimeDomainData(bbuf);
        for (let i = 0; i < bbuf.length; i++) {
          const v = (bbuf[i] - 128) / 128;
          acc += v * v;
        }
      }
      const rms = Math.sqrt(acc / analyser.fftSize);
      onLevel(20 * Math.log10(rms + 1e-7));
    }, FRAME_MS);

    return {
      stop() {
        clearInterval(timer);
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
      },
    };
  }

  /**
   * Motion: strength of small, quick hand movements (acceleration without
   * gravity plus rotation speed). Must be started directly from a tap on iPhone.
   */
  async function startMotion(onLevel, onNoData) {
    if (typeof DeviceMotionEvent === 'undefined') {
      throw new Error('This device has no motion sensors available to the browser.');
    }
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const answer = await DeviceMotionEvent.requestPermission();
      if (answer !== 'granted') throw new Error('Motion access was not allowed. Tap Start again and choose "Allow".');
    }

    let sumSq = 0;
    let n = 0;
    let gotAny = false;
    const g = { x: 0, y: 0, z: 0, init: false };

    function handler(e) {
      let x, y, z;
      const a = e.acceleration;
      if (a && a.x != null) {
        x = a.x; y = a.y; z = a.z;
      } else if (e.accelerationIncludingGravity && e.accelerationIncludingGravity.x != null) {
        // Estimate gravity with a slow filter and remove it.
        const ag = e.accelerationIncludingGravity;
        if (!g.init) { g.x = ag.x; g.y = ag.y; g.z = ag.z; g.init = true; }
        g.x += (ag.x - g.x) * 0.1; g.y += (ag.y - g.y) * 0.1; g.z += (ag.z - g.z) * 0.1;
        x = ag.x - g.x; y = ag.y - g.y; z = ag.z - g.z;
      } else {
        return;
      }
      const r = e.rotationRate || {};
      const rot = Math.sqrt((r.alpha || 0) ** 2 + (r.beta || 0) ** 2 + (r.gamma || 0) ** 2); // deg/s
      const v = Math.sqrt(x * x + y * y + z * z) + rot / 60;
      sumSq += v * v;
      n++;
      gotAny = true;
    }

    window.addEventListener('devicemotion', handler);
    const t0 = performance.now();
    let warned = false;
    const timer = setInterval(() => {
      if (n > 0) {
        const rms = Math.sqrt(sumSq / n);
        onLevel(20 * Math.log10(rms + 1e-4));
        sumSq = 0;
        n = 0;
      } else if (!gotAny && !warned && performance.now() - t0 > 2500) {
        warned = true;
        onNoData && onNoData();
      }
    }, FRAME_MS);

    return {
      stop() {
        clearInterval(timer);
        window.removeEventListener('devicemotion', handler);
      },
    };
  }

  return { startMic, startMotion };
})();
