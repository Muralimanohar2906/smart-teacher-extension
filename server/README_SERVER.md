# Smart Teacher Gemini Server

Local FastAPI microservice that powers Smart Teacher whenever Chrome’s on-device Gemini Nano is unavailable.

---

## Features
- Auto-detects the best available Gemini model (prefers `gemini-2.0-flash` → `1.5-flash`).
- Language detection + optional translation to English before prompting.
- JSON repair pass for quizzes when the LLM responds with fuzzy formatting.
- Returns structured notes, quiz MCQs, and a `study_plan_markdown` payload for the Study Coach tab.
- Summarise / proofread / translate helper routes for future features.

---

## Quickstart
```bash
cd server
cp .env.example .env          # set GOOGLE_API_KEY (aka GEMINI_API_KEY)
python -m venv .venv && source .venv/bin/activate  # optional
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

- `ALLOWED_ORIGINS=*` by default so the extension can call from `chrome-extension://*`.
- Override `MODEL_NAME` in `.env` if you want to pin to `gemini-1.5-flash` etc.

---

## Endpoints
| Route         | Description                                      |
|---------------|--------------------------------------------------|
| `POST /generate`  | Notes + MCQ quiz + study coach plan (extension)  |
| `POST /summarize` | 5-bullet summary of supplied text               |
| `POST /proofread` | Grammar and clarity improvements                |
| `POST /translate` | Auto-detect + translate into target language    |
| `GET /health`     | Returns active API version + model for debugging |

All endpoints expect/return JSON. See `server/main.py` for schemas (`GenerateIn`, `GenerateOut`, etc.). The `GenerateOut` model now includes `study_plan_markdown` in addition to notes, quiz array, source language/word counts.

---

## Docker
```bash
docker build -t smart-teacher-server .
docker run -p 8000:8000 --env-file .env smart-teacher-server
```

---

## Troubleshooting
- **401 / quota errors** – ensure the API key has Gemini access (Google AI Studio) and hasn’t exhausted its quota.
- **Model probing fails** – some enterprise configurations block `v1beta` routes; set `MODEL_NAME` directly.
- **CORS mismatch** – tweak `ALLOWED_ORIGINS` (comma-separated) in `.env` to match your testing origin.

---

This service is optional once Chrome’s Gemini Nano is broadly available, but it guarantees Smart Teacher keeps working during demos and judging.
