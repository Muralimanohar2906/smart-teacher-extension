# Smart Teacher (Gemini-powered)

Chrome extension that generates **Smart Quiz** and **Smart Notes** for YouTube videos.

## How it works
- Content script opens/scrapes the on-page Transcript panel.
- Sends transcript to a local FastAPI server that calls **Google Gemini**.
- Renders tabs (Quiz/Notes) on top of the video with **download** (TXT + PDF).

## Run the server
```bash
cd server
cp .env.example .env   # put GEMINI_API_KEY
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
