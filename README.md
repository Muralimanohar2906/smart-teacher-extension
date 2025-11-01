# Smart Teacher (Gemini-powered)

Gemini-driven Chrome extension that turns any YouTube lecture into:
- **Smart Notes** (structured Markdown) for instant studying.
- **Smart Quiz** (MCQs with explanations) with on-page grading.
- Downloadables (TXT + PDF) and re-generation with one click.

Built to shine for the *Google Chrome Built-in AI Challenge 2025* by fusing on-device **Gemini Nano** with a resilient cloud fallback.

---

## Why It Stands Out
- **Chrome AI native** – Prefers Gemini Nano via `window.ai` / `chrome.aiOriginTrial` for private, offline-ready generation.
- **Graceful fallbacks** – Automatically switches to the FastAPI Gemini cloud microservice when Nano isn’t available.
- **Adaptive Study Coach** – Generates a personalized follow-up plan (diagnostic, priorities, practice, reflection) to drive mastery.
- **Learner experience upgrades** – Live progress tracker, mode badges, language detection, cached runs, and instant replays.
- **Configurable pedagogy** – Popup controls for question difficulty, creativity (temperature), preferred AI route, and server endpoint.

---

## Architecture Snapshot
```
YouTube page
 ├─ content_script.js
 │   ├─ Extract transcript + metadata
│   ├─ Try Gemini Nano via ai_bridge.js (window.ai / chrome.aiOriginTrial)
│   ├─ Fallback to FastAPI server if needed
│   └─ Render overlay (quiz, notes, coach guidance, downloads, regeneration)
 ├─ ai_bridge.js (injected) – negotiates with Chrome built-in AI APIs
 └─ overlay.html / inject.css – polished UI + progress & status bars

FastAPI server (optional)
 └─ server/main.py – resolves best Gemini model, handles notes/quiz repair, translation
```

---

## Getting Started

### 1. Prep Chrome for Gemini Nano (optional but recommended)
1. Run Chrome 127+ on a supported platform (Win/Mac x86-64, Pixelbook, etc.).
2. In `chrome://flags/`, enable:
   - `#optimization-guide-on-device-model`
   - `#prompt-api-for-gemini-nano` (Chrome AI APIs)
3. Restart Chrome. Visit `chrome://version` to confirm.
4. Navigate to `chrome://flags/#text-safety-classification` if you need relaxed content filters for dev testing.
5. Verify availability in DevTools console:
   ```js
   await window.ai?.getCapabilities();   // should show available: "readily" or "after-download"
   ```
   If `window.ai` is missing, the extension will automatically fall back to the server.

### 2. Load the Extension
1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `smart-teacher-extension` folder.
3. Pin *Smart Teacher* to the toolbar for quick access.

### 3. (Optional) Run the Gemini Server Fallback
```bash
cd server
cp .env.example .env      # drop in your GOOGLE_API_KEY / GEMINI_API_KEY
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```
> The server auto-detects the best Gemini model (prefers `gemini-2.0-flash`/`1.5-flash`) and repairs malformed output before returning it.

### 4. Generate Teaching Material
1. Open a YouTube lecture and wait for the overlay badge to appear.
2. Use the popup to tweak:
   - Server URL fallback
   - Number of questions / difficulty
   - **Prefer on-device Gemini Nano** toggle + strategy (`auto`, `window.ai`, `chrome.aiOriginTrial`)
   - Creativity slider (Gemini temperature)
3. Hit **Generate for this video** (or the in-overlay **Regenerate** button).
4. Watch the overlay show progress (Transcript → AI → Output) and final mode: `Gemini Nano` or `Gemini API (server)`.
5. Explore the three tabs:
   - **Smart Quiz**: auto-grading with instant feedback and color-coded explanations.
   - **Smart Notes**: structured markdown study notes.
   - **Study Coach**: adaptive plan with diagnostics, focus areas, practice actions, and reflection prompts.
6. Download notes/quiz/coach plan (TXT/PDF), or revisit later—the result is cached per video + settings.

---

## Key UX Enhancements
- **Progress tracker** – surfaces where the pipeline is: transcript scraping, on-device inference, server fallback, rendering.
- **Mode + language badges** – instantly see if the material came from Gemini Nano or the server, plus detected transcript language.
- **Study Coach tab** – on-device or cloud-generated remediation plan with score awareness and actionable next steps.
- **Smart caching** – fast replays when transcript + settings stay the same (override with “Regenerate”).
- **Inline Markdown rendering** – headings/bullets render cleanly, and PDFs bundle notes, quiz answers, plus the Study Coach plan.
- **Error transparency** – overlay status + console warnings explain why a fallback or failure happened.

---

## Tips for the Challenge Submission
- Capture both modes (Nano + cloud) in demos to highlight resilience.
- Mention privacy benefits of on-device runs and the no-network path for schools.
- Showcase the configurable pedagogy controls (difficulty, temperature) to align with learner-centered judging criteria.
- Use cached runs to demo near-instant experience after first generation.

---

## Troubleshooting
- **`window.ai` unavailable** – ensure flags above are enabled, that Chrome has downloaded the on-device model (check settings → Privacy → `Use Chrome's on-device AI`), and that you’re on supported hardware.
- **CORS issues hitting the server** – adjust `ALLOWED_ORIGINS` in `server/.env` or run server on `0.0.0.0`.
- **Malformed quiz JSON** – server and on-device prompts include self-healing logic, but logs appear in DevTools (client) or console (server) for deeper debugging.

---

## Roadmap Ideas
- Streamed generation with token-by-token reveal inside the overlay.
- Timeline-linked notes (jump to timestamps) once YouTube transcript timestamps are parsed.
- Export to Google Classroom / Sheets for teachers’ workflows.

Contributions and experiments welcome—let’s make Smart Teacher the standout Chrome AI finalist. 🙌
