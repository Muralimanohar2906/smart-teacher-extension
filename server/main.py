import os, json, re, requests, uvicorn
from typing import List, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from openai import OpenAI  # ✅ Correct modern import

# ✅ Load API Key
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("OPENAI_API_KEY env var required")

# ✅ Initialize OpenAI client (new syntax)
client = OpenAI(api_key=OPENAI_API_KEY)

# ✅ FastAPI setup
app = FastAPI(title="Smart Teacher LLM API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ✅ Models
class TranscriptPart(BaseModel):
    start: float
    text: str


class QuizChoice(BaseModel):
    text: str


class QuizQuestion(BaseModel):
    id: str
    prompt: str
    start: float
    choices: List[QuizChoice]
    answer_index: int


class GenerateRequest(BaseModel):
    video_id: Optional[str]
    title: Optional[str] = None
    transcript: List[TranscriptPart]


class GenerateResponse(BaseModel):
    notes: str
    questions: List[QuizQuestion]


# ✅ System prompt
SYSTEM_PROMPT = """
You are "Smart Teacher", an assistant that converts transcripts into concise study notes and 5 multiple-choice questions.
Return JSON:
{"notes": "...", "questions":[{"id":"q1","prompt":"...","start":0,"choices":[{"text":"..."},...],"answer_index":0}]}
"""


# ✅ OpenAI helper (modern API)
def call_openai(transcript_text: str, title: Optional[str] = None):
    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": f"Title: {title or 'No title'}\n\nTranscript:\n{transcript_text}",
        },
    ]
    try:
        resp = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            max_tokens=1200,
            temperature=0.3,
        )
        return resp.choices[0].message.content
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OpenAI error: {str(e)}")


# ✅ Helper: safely parse JSON
def safe_json_extract(raw: str):
    try:
        return json.loads(raw)
    except:
        match = re.search(r"\{[\s\S]*\}", raw)
        if not match:
            raise HTTPException(status_code=500, detail="Invalid JSON from OpenAI")
        return json.loads(match.group(0))


# ✅ POST /generate → Extension sends transcript
@app.post("/generate", response_model=GenerateResponse)
def generate(req: GenerateRequest):
    if not req.transcript:
        raise HTTPException(status_code=400, detail="Transcript required")

    text = "\n".join([f"[{int(p.start)}s] {p.text}" for p in req.transcript])
    raw = call_openai(text, req.title)
    parsed = safe_json_extract(raw)

    if "notes" not in parsed or "questions" not in parsed:
        raise HTTPException(status_code=500, detail="Invalid LLM output")

    questions = [
        QuizQuestion(
            id=q.get("id", f"q{i+1}"),
            prompt=q.get("prompt", ""),
            start=float(q.get("start", 0)),
            choices=[
                {"text": str(c.get("text") if isinstance(c, dict) else c)}
                for c in q.get("choices", [])
            ],
            answer_index=int(q.get("answer_index", 0)),
        )
        for i, q in enumerate(parsed["questions"])
    ]

    return GenerateResponse(notes=parsed["notes"], questions=questions)


# ✅ GET /generate/{video_id} → Auto transcript fetch + AI processing
@app.get("/generate/{video_id}")
def generate_from_video(video_id: str):
    possible_langs = ["en", "en-US", "en-GB", "en-IN"]
    transcript = []

    for lang in possible_langs:
        url = f"https://www.youtube.com/api/timedtext?lang={lang}&v={video_id}"
        resp = requests.get(url)
        if resp.status_code != 200:
            continue
        xml = resp.text
        entries = re.findall(r'<text start="([\d.]+)" dur="[\d.]+">(.*?)</text>', xml)
        if entries:
            for s, t in entries:
                t = (
                    t.replace("&amp;", "&")
                    .replace("&quot;", '"')
                    .replace("&#39;", "'")
                    .replace("&lt;", "<")
                    .replace("&gt;", ">")
                )
                transcript.append({"start": float(s), "text": t})
            break

    if not transcript:
        raise HTTPException(
            status_code=404, detail="Transcript not found for any language"
        )

    transcript_text = "\n".join(
        [f"[{int(p['start'])}s] {p['text']}" for p in transcript]
    )
    raw = call_openai(transcript_text, f"YouTube Video {video_id}")
    parsed = safe_json_extract(raw)

    return {
        "video_id": video_id,
        "transcript": transcript,
        "notes": parsed.get("notes", ""),
        "questions": parsed.get("questions", []),
    }


# ✅ Run
if __name__ == "__main__":
    print("[Smart Teacher] ✅ Server started at http://127.0.0.1:8000")
    print(f"[Smart Teacher] 🔑 API Key Loaded: {'Yes' if OPENAI_API_KEY else 'No'}")
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
