# Writing Rhythm Recorder

A first prototype for a research idea: can we tell **composed** writing (thinking while you write) apart from **copied** writing, using only the *rhythm* of handwriting and never the words?

**Open the app:** https://anoopmrperera.github.io/my-project/

## What it does

1. **Record.** Put your phone on the desk next to the paper and tap **Start**. The app listens for the scratchy sound of a pen on paper and draws a live chart of writing bursts and pauses.
   - *Motion mode (optional):* strap the phone to your writing wrist/forearm, and the app uses the phone's motion sensors instead of the microphone.
2. **Summary.** When you tap **Stop**, you get:
   - total time (first to last pen stroke)
   - time spent writing vs pausing
   - number of pauses, pauses per minute
   - average, middle and longest pause
   - **rhythm steadiness** (0–100): how evenly sized the bursts and pauses were. High = regular rhythm; low = stop-and-go.
3. **Save** the session and label it *Copied*, *Composed* or *Other*.
4. **Compare** any two saved sessions side by side: plain-language observations, the two rhythms on the same time scale, a table of numbers and a chart of pause lengths.

## How detection works

- **Microphone mode:** the sound is filtered so only high-pitched sound (above about 2 kHz, where pen scratch lives) is kept. Twenty times a second the app measures its loudness. During the first 2 seconds it learns the background level; after that, anything clearly louder counts as "pen moving". No audio is ever recorded or stored, only "moving / not moving" and a loudness value.
- **Motion mode:** same idea, using the strength of small, quick hand movements (acceleration plus rotation).
- Short breaks between letters and words are part of a **burst**. A **pause** is a break of at least 1 second (adjustable in Settings: 0.5–3 s). Changing it re-analyses all saved sessions, so comparisons stay fair.
- Steadiness = 100 ÷ (1 + average of the coefficients of variation of burst lengths and pause lengths). It needs at least 3 pauses.

## Privacy

Everything stays on the device. Sessions are stored in the browser's local storage; nothing is uploaded and there is no account or server. You can save a backup file (JSON) or a per-session CSV of bursts and pauses to the phone if you want to analyse the data elsewhere.

## Tips

- Quiet room; a pencil or ballpoint on paper over a hard table works best.
- Keep the screen on and the app open while recording (the app asks the phone to keep the screen awake).
- If writing isn't picked up, raise **Sensitivity** in Settings; if background noise counts as writing, lower it. On the live chart the line should cross the dashed threshold only while the pen moves.
- Compare sessions of similar length.

## Technical notes

Plain HTML, CSS and JavaScript, no build step and no external libraries. Files:

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css` | Page and design (mobile first, light/dark) |
| `js/sensors.js` | Microphone and motion signal levels |
| `js/detector.js` | Background calibration and writing/quiet decision |
| `js/analysis.js` | Bursts, pauses and summary numbers |
| `js/charts.js` | Canvas timelines |
| `js/storage.js` | Local storage |
| `js/app.js` | User interface |

Run locally with any static server, e.g. `python3 -m http.server`, and open `http://localhost:8000`. Sensors need `https` (or `localhost`).

Hosted with GitHub Pages: repository **Settings → Pages → Build and deployment → Deploy from a branch**, pick the branch and `/ (root)`.
