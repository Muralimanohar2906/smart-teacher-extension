import os
import re
import json
from typing import List
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from dotenv import load_dotenv
from pathlib import Path
import requests
import orjson

# ==============================
# Env
# ==============================
env_path = Path(__file__).parent / ".env"
if env_path.exists():
    load_dotenv(env_path)
    print(f"[INFO] Loaded env from {env_path}")
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
if not GOOGLE_API_KEY:
    raise RuntimeError("GOOGLE_API_KEY (or GEMINI_API_KEY) missing")

PREFERRED_MODEL = (os.getenv("MODEL_NAME") or "gemini-1.5-flash").strip()

# ==============================
# FastAPI Setup
# ==============================
app = FastAPI(title="Smart Teacher API", version="7.2")
origins = [o.strip() for o in os.getenv("ALLOWED_ORIGINS", "*").split(",")]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins if origins != ["*"] else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ==============================
# Data Models
# ==============================
class GenerateIn(BaseModel):
    video_url: str
    title: str = ""
    transcript: str
    num_questions: int = Field(5, ge=1, le=12)
    difficulty: str = "mixed"


class SummarizeIn(BaseModel):
    text: str


class ProofreadIn(BaseModel):
    text: str


class TranslateIn(BaseModel):
    text: str
    target_language: str = Field(..., description="e.g., Hindi, Spanish, French")


class MCQ(BaseModel):
    question: str
    options: List[str]
    correct_index: int
    explanation: str = ""


class GenerateOut(BaseModel):
    notes_markdown: str
    quiz: List[MCQ]
    source_words: int
    source_language: str


# ==============================
# Gemini Resolver
# ==============================
SESSION = requests.Session()
SESSION.headers.update({"Content-Type": "application/json"})
TIMEOUT = 40


def _http_get(url: str, params: dict):
    return SESSION.get(url, params=params, timeout=TIMEOUT)


def _http_post(url: str, params: dict, json: dict):
    return SESSION.post(url, params=params, json=json, timeout=TIMEOUT)


def _strip_models_prefix(name: str) -> str:
    return name.replace("models/", "").strip()


def list_models_try(api_version: str) -> List[str]:
    url = f"https://generativelanguage.googleapis.com/{api_version}/models"
    r = _http_get(url, params={"key": GOOGLE_API_KEY})
    if r.status_code != 200:
        print(f"[WARN] ListModels {api_version} -> {r.status_code}: {r.text[:180]}")
        return []
    data = r.json()
    out = []
    for m in data.get("models", []):
        name = _strip_models_prefix(m.get("name", ""))
        methods = m.get("supportedGenerationMethods", [])
        if "generateContent" in methods:
            out.append(name)
    return out


def probe_generate_content(api_version: str, model: str) -> bool:
    model_clean = _strip_models_prefix(model)
    url = f"https://generativelanguage.googleapis.com/{api_version}/models/{model_clean}:generateContent"
    params = {"key": GOOGLE_API_KEY}
    payload = {"contents": [{"role": "user", "parts": [{"text": "ping"}]}]}
    r = _http_post(url, params=params, json=payload)
    if r.status_code == 200:
        return True
    print(
        f"[WARN] probe {api_version}/{model_clean} -> {r.status_code}: {r.text[:180]}"
    )
    return False


def resolve_model_and_version() -> tuple[str, str]:
    common_models = [
        "gemini-2.0-flash",
        "gemini-2.0-pro",
        "gemini-1.5-flash",
        "gemini-1.5-pro",
    ]
    versions = ["v1", "v1beta"]

    def order_candidates(avail: List[str]) -> List[str]:
        seen = set()
        ordered = []
        pref = _strip_models_prefix(PREFERRED_MODEL)
        if pref in avail:
            ordered.append(pref)
            seen.add(pref)
        for m in common_models:
            if m in avail and m not in seen:
                ordered.append(m)
                seen.add(m)
        for m in avail:
            if m not in seen:
                ordered.append(m)
                seen.add(m)
        return ordered

    for ver in versions:
        avail = list_models_try(ver)
        if not avail:
            continue
        candidates = order_candidates(avail)
        print(
            f"[INFO] {ver} available: {', '.join(candidates[:8])}{' …' if len(candidates)>8 else ''}"
        )
        for m in candidates:
            if probe_generate_content(ver, m):
                print(f"[✅] Using {ver} / {m}")
                return ver, m

    for ver in versions:
        for m in common_models:
            if probe_generate_content(ver, m):
                print(f"[✅] Using {ver} / {m} (fallback)")
                return ver, m

    raise RuntimeError("No Gemini model available for this API key.")


API_VERSION, ACTIVE_MODEL = resolve_model_and_version()


def call_gemini(prompt: str) -> str:
    url = f"https://generativelanguage.googleapis.com/{API_VERSION}/models/{_strip_models_prefix(ACTIVE_MODEL)}:generateContent"
    params = {"key": GOOGLE_API_KEY}
    payload = {"contents": [{"role": "user", "parts": [{"text": prompt}]}]}
    r = _http_post(url, params=params, json=payload)
    if r.status_code != 200:
        raise HTTPException(status_code=500, detail=f"Gemini API Error: {r.text}")
    try:
        return r.json()["candidates"][0]["content"]["parts"][0]["text"]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Invalid Gemini response: {e}")


# ==============================
# Prompts & Helpers
# ==============================
SYSTEM_PROMPT = """You are Smart Teacher, an academic tutor.
Given a lecture transcript, produce:
1. Clear, structured MARKDOWN notes.
2. A JSON quiz with exactly 4 options per question.
"""

QUIZ_JSON_HINT = """Output *only* a valid JSON array:
[{"question":"...","options":["...","...","...","..."],"correct_index":1,"explanation":"..."}]
"""


def detect_language(text: str) -> str:
    try:
        return call_gemini(
            "Detect language of this text and return only language name (e.g., English, Hindi):\n\n"
            + text[:800]
        ).strip()
    except Exception:
        return "Unknown"


def translate_to_english(text: str, detected_lang: str) -> str:
    if "english" in detected_lang.lower():
        return text
    return call_gemini(
        f"Translate this {detected_lang} text into English:\n\n{text[:4000]}"
    ).strip()


def extract_json_block(text: str) -> str:
    """Extract valid JSON substring safely."""
    text = re.sub(r"```(json)?", "", text)
    text = text.replace("```", "").strip()
    start, end = text.find("["), text.rfind("]")
    if start != -1 and end != -1:
        return text[start : end + 1]
    return text


def safe_json_loads(text: str):
    """Parse JSON safely and repair if needed."""
    try:
        return orjson.loads(text)
    except Exception:
        cleaned = extract_json_block(text)
        try:
            return orjson.loads(cleaned)
        except Exception:
            try:
                return json.loads(cleaned)
            except Exception:
                print("[WARN] Could not parse JSON even after cleaning")
                return []


# ==============================
# API Routes
# ==============================
@app.post("/generate", response_model=GenerateOut)
def generate(data: GenerateIn):
    try:
        if not data.transcript or len(data.transcript.split()) < 50:
            raise ValueError("Transcript too short or missing.")

        lang = detect_language(data.transcript)
        transcript_en = translate_to_english(data.transcript, lang)

        header = (
            f"Video: {data.title or 'Untitled'}\n"
            f"URL: {data.video_url}\n"
            f"Questions: {data.num_questions}\n"
            f"Difficulty: {data.difficulty}\n"
        )

        notes_prompt = f"{SYSTEM_PROMPT}\n\n{header}\nGenerate MARKDOWN notes only:\n\n{transcript_en}"
        notes_md = call_gemini(notes_prompt).strip()

        quiz_prompt = (
            f"{SYSTEM_PROMPT}\n\n{header}\nGenerate {data.num_questions} MCQs in JSON format only.\n"
            f"{QUIZ_JSON_HINT}\nTranscript:\n{transcript_en}"
        )
        quiz_text = call_gemini(quiz_prompt).strip()

        quiz_data = safe_json_loads(quiz_text)

        if not quiz_data:
            print("[WARN] Retry — malformed quiz JSON, requesting fix")
            repair_prompt = (
                f"Fix this invalid JSON to valid JSON array only:\n{quiz_text}"
            )
            fixed = call_gemini(repair_prompt)
            quiz_data = safe_json_loads(fixed)
            if not quiz_data:
                raise ValueError("Quiz JSON could not be fixed even after retry.")

        mcqs = []
        for q in quiz_data:
            if isinstance(q.get("options"), list) and len(q["options"]) == 4:
                mcqs.append(
                    MCQ(
                        question=str(q.get("question", "")).strip(),
                        options=[str(o) for o in q["options"]],
                        correct_index=int(q.get("correct_index", 0)),
                        explanation=q.get("explanation", "").strip(),
                    )
                )

        if not mcqs:
            raise ValueError("No valid MCQs found after parse & repair.")

        return GenerateOut(
            notes_markdown=notes_md,
            quiz=mcqs,
            source_words=len(transcript_en.split()),
            source_language=lang,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")


@app.post("/summarize")
def summarize(data: SummarizeIn):
    try:
        txt = call_gemini(
            f"Summarize this text in 5 concise bullet points:\n\n{data.text}"
        )
        return {"summary": txt.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Summarization failed: {e}")


@app.post("/proofread")
def proofread(data: ProofreadIn):
    try:
        txt = call_gemini(f"Proofread and improve grammar and clarity:\n\n{data.text}")
        return {"corrected_text": txt.strip()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Proofreading failed: {e}")


@app.post("/translate")
def translate(data: TranslateIn):
    try:
        detected = detect_language(data.text)
        if data.target_language.lower() in detected.lower():
            return {
                "original_text": data.text,
                "translated_text": data.text,
                "language": detected,
                "note": "Skipped translation (already target language)",
            }
        out = call_gemini(
            f"Translate from {detected} to {data.target_language}:\n\n{data.text}"
        )
        return {
            "original_text": data.text,
            "translated_text": out.strip(),
            "source_language": detected,
            "target_language": data.target_language,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")


@app.get("/health")
def health():
    return {"ok": True, "api_version": API_VERSION, "model": ACTIVE_MODEL}
