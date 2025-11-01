/* global chrome */
const OVERLAY_ID = "st-overlay";
const AI_CHANNEL = "__st_ai_bridge__";
const LOCAL_SYSTEM_PROMPT = [
  "You are Smart Teacher, an award-winning pedagogy expert running fully on-device.",
  "Provide academically rigorous yet accessible explanations tailored to self-directed learners.",
  "Ground every output strictly in the supplied transcript without inventing facts.",
  "Keep tone encouraging and never mention that you are an AI model."
].join("\n");

const DEFAULT_SETTINGS = {
  serverUrl: "http://127.0.0.1:8000",
  numQ: 5,
  difficulty: "mixed",
  preferLocal: true,
  nanoStrategy: "auto",
  temperature: 0.6,
};

let state = {
  quiz: [],
  notes_md: "",
  study_plan_md: "",
  score: 0,
  quiz_feedback: "",
  source_language: "",
  source_words: 0,
  ai_origin: "",
  cache_state: "",
};

const aiBridgeState = {
  initialized: false,
  ready: false,
  available: false,
  strategies: [],
  waiters: [],
  pending: new Map(),
  lastOrigin: "",
  capabilities: null,
};

const CACHE_KEY = "stCache";
const MAX_CACHE_ITEMS = 8;
const CACHE_TTL_MS = 1000 * 60 * 60 * 24; // 24h
let generationInProgress = false;

function setProgressVisible(visible) {
  const el = document.getElementById("st-progress");
  if (!el) return;
  el.classList.toggle("hidden", !visible);
}

function setMetaVisible(visible) {
  const metaEl = document.querySelector("#st-overlay .meta");
  if (!metaEl) return;
  metaEl.classList.toggle("hidden", !visible);
}

function injectBridgeScript() {
  if (document.getElementById("st-ai-bridge")) return;
  const script = document.createElement("script");
  script.id = "st-ai-bridge";
  script.type = "text/javascript";
  script.src = chrome.runtime.getURL("ui/ai_bridge.js");
  script.onload = () => script.remove();
  (document.head || document.documentElement).appendChild(script);
}

function handleAiBridgeMessage(event) {
  if (event.source !== window || !event.data || event.data.channel !== AI_CHANNEL) {
    return;
  }
  const { type, detail } = event.data;
  if (type === "bridge-ready") {
    aiBridgeState.ready = true;
    aiBridgeState.available = Boolean(detail?.available);
    aiBridgeState.strategies = Array.isArray(detail?.strategies)
      ? detail.strategies
      : [];
    aiBridgeState.waiters.forEach((resolve) => resolve(aiBridgeState.available));
    aiBridgeState.waiters = [];
  } else if (type === "prompt-success") {
    const id = detail?.id;
    const entry = id ? aiBridgeState.pending.get(id) : null;
    if (!entry) return;
    clearTimeout(entry.timeout);
    aiBridgeState.pending.delete(id);
    aiBridgeState.lastOrigin = detail?.result?.origin || "";
    aiBridgeState.capabilities = detail?.result?.capabilities || null;
    entry.resolve(detail?.result);
  } else if (type === "prompt-error") {
    const id = detail?.id;
    const entry = id ? aiBridgeState.pending.get(id) : null;
    if (!entry) return;
    clearTimeout(entry.timeout);
    aiBridgeState.pending.delete(id);
    entry.reject(new Error(detail?.error || "On-device AI error"));
  }
}

function ensureAiBridge() {
  if (aiBridgeState.initialized) return;
  aiBridgeState.initialized = true;
  window.addEventListener("message", handleAiBridgeMessage);
  injectBridgeScript();
}

function waitForAiReady(timeout = 3500) {
  if (aiBridgeState.ready) {
    return Promise.resolve(aiBridgeState.available);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeout);
    aiBridgeState.waiters.push((available) => {
      clearTimeout(timer);
      resolve(available);
    });
  });
}

function preferredStrategyName(setting) {
  if (!setting || setting === "auto") return undefined;
  if (typeof setting === "string") return setting;
  return undefined;
}

function aiPrompt(prompt, options = {}) {
  const dispatch = async () => {
    if (!aiBridgeState.ready) {
      await waitForAiReady();
    }
    if (!aiBridgeState.available) {
      throw new Error("On-device AI unavailable");
    }
    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `st-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const payload = {
      prompt,
      systemPrompt: options.systemPrompt,
      temperature: options.temperature,
      topK: options.topK,
      topP: options.topP,
      maxOutputTokens: options.maxOutputTokens,
      stopSequences: options.stopSequences,
      safetySettings: options.safetySettings,
      preferredStrategy: preferredStrategyName(options.preferredStrategy),
    };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        aiBridgeState.pending.delete(id);
        reject(new Error("On-device AI timed out"));
      }, options.timeoutMs || 45000);
      aiBridgeState.pending.set(id, { resolve, reject, timeout });
      window.postMessage(
        {
          channel: AI_CHANNEL,
          from: "content",
          type: "prompt",
          id,
          payload,
        },
        "*"
      );
    });
  };
  return dispatch();
}

function clipTranscript(text, maxWords = 2800) {
  const parts = text.split(/\s+/);
  if (parts.length <= maxWords) return text;
  return parts.slice(0, maxWords).join(" ");
}

function hashString(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i += 1) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

function buildSettingsFingerprint(settings) {
  return hashString(JSON.stringify(settings));
}

function makeCacheKey(videoId, fingerprint) {
  return `${videoId || "unknown"}::${fingerprint}`;
}

async function readCacheMap() {
  const stored = await chrome.storage.local.get([CACHE_KEY]);
  return stored[CACHE_KEY] || {};
}

async function writeCacheMap(map) {
  await chrome.storage.local.set({ [CACHE_KEY]: map });
}

async function loadCachedGeneration(videoId, fingerprint, transcriptHash) {
  const cache = await readCacheMap();
  const entry = cache[makeCacheKey(videoId, fingerprint)];
  if (!entry) return null;
  if (entry.transcriptHash !== transcriptHash) return null;
  if (Date.now() - entry.savedAt > CACHE_TTL_MS) return null;
  return entry;
}

async function saveCachedGeneration(videoId, fingerprint, transcriptHash, payload) {
  const cache = await readCacheMap();
  cache[makeCacheKey(videoId, fingerprint)] = {
    transcriptHash,
    data: payload,
    savedAt: Date.now(),
  };
  const entries = Object.entries(cache).sort(
    (a, b) => b[1].savedAt - a[1].savedAt
  );
  const trimmed = entries.slice(0, MAX_CACHE_ITEMS);
  const next = {};
  trimmed.forEach(([key, value]) => {
    next[key] = value;
  });
  await writeCacheMap(next);
}

function formatRelativeTime(timestamp) {
  const diff = Date.now() - timestamp;
  if (diff < 45_000) return "moments ago";
  if (diff < 90_000) return "1 min ago";
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 7_200_000) return "1 hr ago";
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hr ago`;
  const days = Math.round(diff / 86_400_000);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function cleanJsonBlock(text) {
  let cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start !== -1 && end !== -1 && end > start) {
    cleaned = cleaned.slice(start, end + 1);
  }
  return cleaned;
}

function markdownToHtml(md) {
  if (!md) {
    return '<div class="muted">No content yet.</div>';
  }
  let html = md
    .replace(/\r\n/g, "\n")
    .replace(/^### (.*)$/gim, "<h3>$1</h3>")
    .replace(/^## (.*)$/gim, "<h2>$1</h2>")
    .replace(/^# (.*)$/gim, "<h1>$1</h1>")
    .replace(/\*\*(.*?)\*\*/gim, "<strong>$1</strong>")
    .replace(/__(.*?)__/gim, "<strong>$1</strong>")
    .replace(/_([^_]+)_/gim, "<em>$1</em>")
    .replace(/`([^`]+)`/gim, "<code>$1</code>")
    .replace(/^\s*[-*]\s+(.*)$/gim, "<li>$1</li>");

  html = html.replace(
    /(<li>[^<]*<\/li>\s*)+/gim,
    (match) => `<ul>${match.replace(/\s+/g, " ")}</ul>`
  );
  html = html.replace(/\n{2,}/g, "<br/>");
  return html;
}

function createStudyPlanPrompt(header, transcript) {
  return [
    header,
    "Compose a personalized study coach plan using markdown headings exactly as follows:",
    "## Quick Diagnostic",
    "## Priority Topics",
    "## Practice Actions",
    "## Reflection Prompts",
    "Instructions:",
    "• Keep each section concise and grounded in the transcript facts.",
    "• Quick Diagnostic: 2 bullet insights about learner understanding.",
    "• Priority Topics: bullet list of key concepts to reinforce.",
    "• Practice Actions: 3 actionable tasks referencing transcript ideas.",
    "• Reflection Prompts: 2 questions that encourage metacognition.",
    "• Keep the entire response under 220 words.",
    "",
    "Transcript basis:",
    transcript,
  ].join("\n");
}

async function generateStudyPlanWithLocalAi({
  header,
  transcript,
  preferredStrategy,
  temperature,
}) {
  const available = await waitForAiReady(4500);
  if (!available) {
    throw new Error("On-device AI not available for study plan");
  }
  const prompt = createStudyPlanPrompt(header, transcript);
  const result = await aiPrompt(prompt, {
    systemPrompt: `${LOCAL_SYSTEM_PROMPT}\nReturn markdown with the required headings only.`,
    temperature: Math.max(0.4, (temperature || 0.6) - 0.05),
    preferredStrategy,
    timeoutMs: 30000,
  });
  return (result?.output || result || "").toString().trim();
}

function normalizeQuizArray(raw) {
  if (!Array.isArray(raw)) return [];
  const letterMap = { A: 0, B: 1, C: 2, D: 3 };
  return raw
    .map((item) => {
      if (!item) return null;
      const question = String(
        item.question || item.prompt || item.q || ""
      ).trim();
      if (!question) return null;
      let options = item.options || item.choices || item.answers || [];
      if (!Array.isArray(options)) return null;
      options = options.map((opt) => String(opt || "").trim()).filter(Boolean);
      if (options.length !== 4) return null;
      let correctIndex =
        item.correct_index ??
        item.correctIndex ??
        item.answer_index ??
        item.answerIndex ??
        item.answer;
      if (typeof correctIndex === "string") {
        const cleaned = correctIndex.trim();
        const upper = cleaned.toUpperCase();
        if (letterMap.hasOwnProperty(upper)) {
          correctIndex = letterMap[upper];
        } else {
          const num = parseInt(cleaned, 10);
          if (!Number.isNaN(num)) {
            correctIndex = num;
          }
        }
      }
      if (typeof correctIndex === "string") {
        const matchIdx = options.findIndex(
          (opt) => opt.toLowerCase() === correctIndex.toLowerCase()
        );
        if (matchIdx !== -1) correctIndex = matchIdx;
      }
      let idxValue = Number(correctIndex);
      if (Number.isNaN(idxValue)) {
        return null;
      }
      if (!Number.isInteger(idxValue)) {
        idxValue = Math.round(idxValue);
      }
      if (idxValue < 0 || idxValue > options.length) {
        return null;
      }
      if (!(idxValue >= 0 && idxValue <= options.length - 1)) {
        if (idxValue >= 1 && idxValue <= options.length) {
          idxValue -= 1;
        }
      }
      if (idxValue < 0 || idxValue > options.length - 1) {
        return null;
      }
      const idx = idxValue;
      return {
        question,
        options,
        correct_index: idx,
        explanation: String(item.explanation || item.rationale || "").trim(),
      };
    })
    .filter(Boolean);
}

function safeParseQuiz(text) {
  const cleaned = cleanJsonBlock(text);
  try {
    return normalizeQuizArray(JSON.parse(cleaned));
  } catch (_) {}
  try {
    return normalizeQuizArray(JSON.parse(cleaned.replace(/\n/g, " ")));
  } catch (_) {
    return [];
  }
}

async function generateWithLocalAi({
  transcript,
  title,
  url,
  numQ,
  difficulty,
  preferredStrategy,
  temperature,
}) {
  const available = await waitForAiReady(4500);
  if (!available) {
    throw new Error("On-device AI not available");
  }
  const clipped = clipTranscript(transcript, 3200);
  const header = [
    `Video title: ${title || "Untitled"}`,
    `Video URL: ${url}`,
    `Number of MCQs: ${numQ}`,
    `Target difficulty: ${difficulty}`,
  ].join("\n");

  const languagePrompt = [
    "Identify the primary human language used in the following text.",
    "Respond with the language name only (e.g., English, Hindi, Spanish).",
    "",
    clipped.slice(0, 2000),
  ].join("\n");

  const languageResult = await aiPrompt(languagePrompt, {
    systemPrompt:
      "You are a linguistic expert. Reply with nothing except the language name.",
    temperature: 0.1,
    preferredStrategy,
    timeoutMs: 10000,
  });
  const detectedLanguage = (languageResult?.output || languageResult || "")
    .toString()
    .split(/[:\-]/)[0]
    .trim();

  const notesPrompt = [
    header,
    "Task: Craft structured MARKDOWN study notes grounded in the transcript.",
    "Requirements:",
    "• Organize content with H2/H3 headings and short paragraphs.",
    "• Include prioritized bullet lists and key formulas if present.",
    "• Highlight actionable insights and learner takeaways.",
    "• Keep within 320 words.",
    "",
    "Transcript:",
    clipped,
  ].join("\n");

  const notesResult = await aiPrompt(notesPrompt, {
    systemPrompt: `${LOCAL_SYSTEM_PROMPT}\nAlways return only markdown content.`,
    temperature: Math.min(0.85, (temperature || 0.6) + 0.15),
    preferredStrategy,
  });
  const notesMarkdown =
    (notesResult?.output || notesResult || "").toString().trim();

  const quizPrompt = [
    header,
    `Create ${numQ} multiple-choice questions (MCQs) that reinforce understanding.`,
    "Output strictly as JSON array with this shape:",
    '[{"question":"...","options":["A","B","C","D"],"correct_index":1,"explanation":"..."}]',
    "Guidelines:",
    "• Vary cognitive level (recall, application, synthesis).",
    "• Ensure each question references transcript facts.",
    "• Options must be concise and mutually exclusive.",
    "• Explanation must justify the correct answer in 1 sentence.",
    "",
    "Transcript excerpt:",
    clipped,
  ].join("\n");

  const quizResult = await aiPrompt(quizPrompt, {
    systemPrompt: `${LOCAL_SYSTEM_PROMPT}\nAlways respond with valid JSON only.`,
    temperature: Math.max(0.45, temperature || 0.6),
    preferredStrategy,
    timeoutMs: 45000,
  });

  const quizPayload = quizResult?.output || quizResult || "";
  const quizItems = safeParseQuiz(quizPayload.toString());
  if (!quizItems.length) {
    throw new Error("Failed to parse on-device quiz JSON");
  }

  const planPrompt = createStudyPlanPrompt(header, clipped);
  const planResult = await aiPrompt(planPrompt, {
    systemPrompt: `${LOCAL_SYSTEM_PROMPT}\nReturn markdown with the required headings only.`,
    temperature: Math.max(0.4, (temperature || 0.6) - 0.05),
    preferredStrategy,
  });
  const studyPlanMarkdown =
    (planResult?.output || planResult || "").toString().trim();

  return {
    notes_markdown: notesMarkdown,
    study_plan_markdown: studyPlanMarkdown,
    quiz: quizItems,
    source_language: detectedLanguage || "Unknown",
    source_words: clipped.split(/\s+/).length,
    ai_origin: aiBridgeState.lastOrigin || "Gemini Nano",
  };
}

function applyGenerationResult(data, meta = {}) {
  state.quiz = Array.isArray(data.quiz) ? data.quiz : [];
  state.notes_md = data.notes_markdown || "";
  state.study_plan_md =
    data.study_plan_markdown ||
    data.studyPlanMarkdown ||
    data.study_plan_md ||
    "";
  state.source_language = data.source_language || "";
  state.source_words = data.source_words || 0;
  state.ai_origin = formatAiOrigin(meta.ai_origin || data.ai_origin || "");
  state.cache_state = meta.cache || "";
  state.quiz_feedback = "";

  const statusBits = ["Ready"];
  if (state.source_words) statusBits.push(`${state.source_words} words`);
  if (state.source_language) statusBits.push(state.source_language);
  if (state.ai_origin) statusBits.push(state.ai_origin);
  if (meta.statusLabel) statusBits.push(meta.statusLabel);
  if (state.cache_state) statusBits.push(state.cache_state);

  setStatus(statusBits.join(" • "));
  renderQuiz();
  renderNotes(state.notes_md);
  renderCoach(state.study_plan_md);
  renderMeta();
  updateProgress("render");
  setProgressVisible(false);
}

ensureAiBridge();

function formatAiOrigin(origin) {
  if (!origin) return "";
  if (/window\.ai/i.test(origin)) return "Gemini Nano (window.ai)";
  if (/chrome\.aiOriginTrial/i.test(origin)) return "Gemini Nano (Chrome AI)";
  if (/^\s*gemini\s+nano\s*$/i.test(origin)) return "Gemini Nano";
  return origin;
}

function injectOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;
  fetch(chrome.runtime.getURL("ui/overlay.html"))
    .then(r => r.text())
    .then(html => {
      const el = document.createElement("div");
      el.innerHTML = html;
      document.body.appendChild(el.firstElementChild);
      bindOverlayEvents();
      renderNotes(state.notes_md);
      renderCoach(state.study_plan_md);
      const quizRoot = document.getElementById("st-quiz");
      if (quizRoot && !quizRoot.innerHTML.trim()) {
        quizRoot.innerHTML =
          '<div class="muted">Generate to unlock adaptive quiz practice.</div>';
      }
      setProgressVisible(generationInProgress);
      setMetaVisible(generationInProgress);
      renderMeta();
      updateProgress("transcript");
    });
}

function bindOverlayEvents() {
  const root = document.getElementById(OVERLAY_ID);
  const tabs = root.querySelectorAll(".tab");
  tabs.forEach(t => t.addEventListener("click", () => {
    tabs.forEach(x => x.classList.remove("active"));
    t.classList.add("active");
    root.querySelectorAll(".section").forEach(s => s.classList.remove("active"));
    root.querySelector(`#st-${t.dataset.tab}`).classList.add("active");
  }));
  root.querySelector("#st-close").addEventListener("click", () => root.remove());
  root.querySelector("#st-download-notes").addEventListener("click", downloadNotesTxt);
  root.querySelector("#st-download-pdf").addEventListener("click", downloadPdf);
  const refreshBtn = root.querySelector("#st-refresh");
  if (refreshBtn) {
    refreshBtn.addEventListener("click", () => startGeneration({ force: true }));
  }
}

function setStatus(msg) {
  const s = document.getElementById("st-status");
  if (s) s.textContent = msg;
}

const PROGRESS_STEPS = ["transcript", "ai", "render"];

function updateProgress(step) {
  const container = document.getElementById("st-progress");
  if (!container) return;
  const idx = PROGRESS_STEPS.indexOf(step);
  PROGRESS_STEPS.forEach((name, i) => {
    const node = container.querySelector(`[data-step="${name}"]`);
    if (!node) return;
    if (idx === -1) {
      node.classList.remove("active");
      node.classList.remove("done");
      return;
    }
    node.classList.toggle("active", i === idx);
    if (i < idx) {
      node.classList.add("done");
      node.classList.remove("active");
    } else if (i > idx) {
      node.classList.remove("done");
      node.classList.remove("active");
    } else {
      node.classList.remove("done");
    }
  });
}

function renderMeta() {
  const originEl = document.getElementById("st-meta-origin");
  if (originEl) originEl.textContent = state.ai_origin || "—";
  const langEl = document.getElementById("st-meta-lang");
  if (langEl) langEl.textContent = state.source_language || "—";
  const cacheEl = document.getElementById("st-meta-cache");
  if (cacheEl) cacheEl.textContent = state.cache_state || "—";
  const hasMeta = Boolean(
    (state.ai_origin && state.ai_origin !== "—") ||
      (state.source_language && state.source_language !== "—") ||
      (state.cache_state && state.cache_state !== "—")
  );
  setMetaVisible(hasMeta);
}

function quizFeedbackForScore(pct) {
  if (!Number.isFinite(pct)) return "Keep exploring the material and try again.";
  if (pct === 100) {
    return "Flawless! Reinforce mastery by teaching the concept to someone else.";
  }
  if (pct >= 80) {
    return "Great job. Review the explanations for the few misses to solidify nuance.";
  }
  if (pct >= 60) {
    return "Solid progress. Revisit the Priority Topics in Study Coach before retesting.";
  }
  return "Use the Study Coach plan to revisit fundamentals, then attempt the quiz again.";
}

async function getSettings() {
  const stored = await chrome.storage.sync.get([
    "serverUrl",
    "numQ",
    "difficulty",
    "preferLocal",
    "nanoStrategy",
    "temperature",
  ]);
  return {
    serverUrl: stored.serverUrl || DEFAULT_SETTINGS.serverUrl,
    numQ:
      typeof stored.numQ === "number" && !Number.isNaN(stored.numQ)
        ? stored.numQ
        : DEFAULT_SETTINGS.numQ,
    difficulty: stored.difficulty || DEFAULT_SETTINGS.difficulty,
    preferLocal:
      typeof stored.preferLocal === "boolean"
        ? stored.preferLocal
        : DEFAULT_SETTINGS.preferLocal,
    nanoStrategy: stored.nanoStrategy || DEFAULT_SETTINGS.nanoStrategy,
    temperature:
      typeof stored.temperature === "number" && !Number.isNaN(stored.temperature)
        ? stored.temperature
        : DEFAULT_SETTINGS.temperature,
  };
}

function parseVideoInfo() {
  const url = location.href;
  const titleEl = document.querySelector(
    "h1.ytd-video-primary-info-renderer, h1.ytd-watch-metadata"
  );
  const title = titleEl ? titleEl.textContent.trim() : document.title;
  let videoId = "";
  try {
    const parsed = new URL(url);
    videoId =
      parsed.searchParams.get("v") ||
      parsed.pathname.replace("/watch/", "").split("/").pop() ||
      "";
  } catch (_) {
    videoId = "";
  }
  if (!videoId) {
    const meta = document.querySelector("ytd-watch-flexy");
    if (meta?.videoId) videoId = meta.videoId;
  }
  return { url, title, videoId };
}

/** Try to open and scrape YouTube's transcript panel and join lines. */
async function extractTranscript() {
  // 1) open transcript if needed
  try {
    // Try to click the "More actions" (three dots) under the video and then "Show transcript"
    const moreBtn = document.querySelector('button[aria-label*="More actions"], ytd-menu-renderer button[aria-label*="More actions"]');
    if (moreBtn) moreBtn.click();
    await new Promise(r => setTimeout(r, 400));
    const showTx = [...document.querySelectorAll('tp-yt-paper-listbox ytd-menu-service-item-renderer, ytd-menu-service-item-renderer')]
      .find(el => /transcript/i.test(el.textContent));
    if (showTx) { showTx.click(); await new Promise(r => setTimeout(r, 700)); }
  } catch (_) {}

  // 2) scrape transcript lines
  const containers = document.querySelectorAll('ytd-transcript-segment-renderer, yt-formatted-string.ytd-transcript-segment-renderer');
  if (containers.length) {
    const lines = [...containers].map(el => el.textContent.trim()).filter(Boolean);
    const text = lines.join(' ').replace(/\s+/g,' ').trim();
    if (text.split(' ').length > 25) return text;
  }

  // fallback: description + captions words on page (weak)
  const fallback = document.body.innerText.slice(0, 15000);
  return fallback;
}

function renderQuiz() {
  const root = document.getElementById("st-quiz");
  root.innerHTML = "";
  state.score = 0;
  state.quiz_feedback = "";

  const summary = document.createElement("div");
  summary.id = "st-quiz-summary";

  if (!state.quiz.length) {
    summary.className = "quiz-summary empty";
    summary.innerHTML =
      "<strong>No quiz yet.</strong><span>Generate to see practice questions.</span>";
    root.appendChild(summary);
    return;
  }

  summary.className = "quiz-summary empty";
  summary.innerHTML =
    "<strong>Ready when you are.</strong><span>Select answers, then submit to reveal feedback.</span>";
  root.appendChild(summary);

  state.quiz.forEach((q, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "q";
    wrap.innerHTML = `<h4>${idx+1}. ${q.question}</h4>` +
      q.options.map((o,i)=>`<label class="opt"><input type="radio" name="q${idx}" value="${i}"> ${o}</label>`).join("");
    const exp = document.createElement("div");
    exp.className = "muted";
    exp.style.display = "none";
    exp.textContent = "Explanation: " + (q.explanation || "");
    wrap.appendChild(exp);
    wrap.addEventListener("change", (e) => {
      const chosen = Number(e.target.value);
      const opts = wrap.querySelectorAll(".opt");
      opts.forEach((el, i) => {
        el.classList.remove("correct","wrong");
        if (i === q.correct_index) el.classList.add("correct");
        if (i === chosen && i !== q.correct_index) el.classList.add("wrong");
      });
      exp.style.display = "block";
    });
    root.appendChild(wrap);
  });

  const submit = document.createElement("button");
  submit.textContent = "Submit Answers";
  submit.addEventListener("click", () => {
    let correct = 0;
    let answered = 0;
    state.quiz.forEach((q, idx) => {
      const val = document.querySelector(`input[name="q${idx}"]:checked`);
      if (val) {
        answered += 1;
        if (Number(val.value) === q.correct_index) correct++;
      }
    });
    if (!answered) {
      summary.className = "quiz-summary empty";
      summary.innerHTML =
        "<strong>No answers selected.</strong><span>Try answering at least one question before submitting.</span>";
      return;
    }
    const pct = Math.round((correct / state.quiz.length) * 100);
    state.score = pct;
    const feedback = quizFeedbackForScore(pct);
    state.quiz_feedback = feedback;

    summary.className = "quiz-summary";
    summary.innerHTML = `<span class="score-pill">${pct}%</span>
      <strong>${correct}/${state.quiz.length} correct</strong>
      <span>${feedback}</span>`;
    renderCoach(state.study_plan_md);
  });
  root.appendChild(submit);
}

function renderNotes(md) {
  const container = document.getElementById("st-notes");
  if (!container) return;
  container.innerHTML = markdownToHtml(md);
}

function renderCoach(md) {
  const container = document.getElementById("st-coach");
  if (!container) return;
  if (!md) {
    if (state.quiz.length) {
      container.innerHTML =
        '<div class="coach-empty">Study Coach needs on-device Gemini Nano or the updated Smart Teacher server. Enable "Prefer on-device" in the popup or upgrade the server, then regenerate.</div>';
    } else {
      container.innerHTML =
        '<div class="coach-empty">Generate a quiz to unlock tailored coaching.</div>';
    }
    return;
  }
  const scoreBadge = state.score
    ? `<span class="coach-score">Latest score: ${state.score}%</span>`
    : "";
  const coachNote =
    state.quiz_feedback ||
    "Use these actions before retaking the quiz or sharing notes.";
  container.innerHTML = `<div class="coach-card">${scoreBadge}${markdownToHtml(
    md
  )}<div class="coach-note">${coachNote}</div></div>`;
}

function downloadNotesTxt() {
  const text = state.notes_md || "";
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "smart_notes.txt";
  a.click();
}

async function downloadPdf() {
  // jsPDF via CDN (lazy load)
  if (!window.jspdf) {
    await new Promise((res) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js";
      s.onload = res; document.head.appendChild(s);
    });
  }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF();
  const wrap = (str, width=180) => doc.splitTextToSize(str, width);

  doc.setFontSize(14);
  doc.text("Smart Notes", 14, 16);
  doc.setFontSize(11);
  let y = 26;
  wrap(state.notes_md.replace(/[#*`]/g,''), 180).forEach(line => {
    if (y > 280) { doc.addPage(); y = 20; }
    doc.text(line, 14, y); y += 6;
  });

  doc.addPage();
  doc.setFontSize(14);
  doc.text("Smart Quiz", 14, 16);
  doc.setFontSize(11); y = 26;
  state.quiz.forEach((q, i) => {
    const block = `${i+1}. ${q.question}\nA) ${q.options[0]}\nB) ${q.options[1]}\nC) ${q.options[2]}\nD) ${q.options[3]}\nAnswer: ${["A","B","C","D"][q.correct_index]}  — ${q.explanation || ""}\n`;
    wrap(block, 180).forEach(line => {
      if (y > 280) { doc.addPage(); y = 20; }
      doc.text(line, 14, y); y += 6;
    });
    y += 2;
  });

  doc.addPage();
  doc.setFontSize(14);
  doc.text("Study Coach Plan", 14, 16);
  doc.setFontSize(11); y = 26;
  wrap((state.study_plan_md || "").replace(/[#*`]/g,''), 180).forEach(line => {
    if (y > 280) { doc.addPage(); y = 20; }
    doc.text(line, 14, y); y += 6;
  });

  doc.save("smart_teacher.pdf");
}

// Handle popup trigger
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ST_GENERATE") startGeneration({ force: Boolean(msg.forceRefresh) });
});

// Main flow
async function startGeneration(options = {}) {
  if (generationInProgress) {
    setStatus("Generation already running…");
    return;
  }
  generationInProgress = true;
  const force = Boolean(options.force);
  injectOverlay();
  ensureAiBridge();
  setProgressVisible(true);
  setMetaVisible(true);
  updateProgress("transcript");
  setStatus("Extracting transcript…");
  const refreshBtn = document.getElementById("st-refresh");
  state.ai_origin = "";
  state.source_language = "";
  state.source_words = 0;
  state.study_plan_md = "";
  state.cache_state = "";
  state.quiz_feedback = "";
  renderMeta();
  if (refreshBtn) refreshBtn.disabled = true;

  try {
    const settings = await getSettings();
    const { serverUrl, numQ, difficulty, preferLocal, nanoStrategy, temperature } =
      settings;
    const { url, title, videoId } = parseVideoInfo();
    const transcript = await extractTranscript();
    const header = [
      `Video title: ${title || "Untitled"}`,
      `Video URL: ${url}`,
      `Number of MCQs: ${numQ}`,
      `Target difficulty: ${difficulty}`,
    ].join("\n");
    const fingerprint = buildSettingsFingerprint({
      numQ,
      difficulty,
      preferLocal,
      nanoStrategy,
      temperature,
    });
    const transcriptHash = hashString(transcript);
    const cacheKeyId = videoId || hashString(url);

    if (!force) {
      const cached = await loadCachedGeneration(
        cacheKeyId,
        fingerprint,
        transcriptHash
      );
      if (cached?.data) {
        const cachedPayload = JSON.parse(JSON.stringify(cached.data));
        let cachedStatusLabel = "Cached";
        if (!cachedPayload.study_plan_markdown && preferLocal) {
          try {
            const plan = await generateStudyPlanWithLocalAi({
              header,
              transcript: clipTranscript(transcript, 3200),
              preferredStrategy: nanoStrategy,
              temperature,
            });
            if (plan) {
              cachedPayload.study_plan_markdown = plan;
              cachedPayload.ai_origin =
                cachedPayload.ai_origin || formatAiOrigin(aiBridgeState.lastOrigin || "Gemini Nano");
              cachedStatusLabel = "Cached + Coach";
            }
          } catch (cachedPlanErr) {
            console.warn("[SmartTeacher] Cached coach fallback skipped", cachedPlanErr);
          }
        }
        applyGenerationResult(cachedPayload, {
          statusLabel: cachedStatusLabel,
          cache: `Cached ${formatRelativeTime(cached.savedAt)}`,
        });
        setStatus(`Loaded from cache • ${formatRelativeTime(cached.savedAt)}`);
        return;
      }
    }

    updateProgress("ai");
    let result = null;
    const meta = {};

    if (preferLocal) {
      setStatus("Trying on-device Gemini Nano…");
      try {
        result = await generateWithLocalAi({
          transcript,
          title,
          url,
          numQ,
          difficulty,
          preferredStrategy: nanoStrategy,
          temperature,
        });
        meta.statusLabel = "On-device";
      } catch (err) {
        console.warn("[SmartTeacher] On-device attempt failed", err);
        setStatus("Local AI unavailable, contacting server…");
      }
    } else {
      setStatus("Contacting server…");
    }

    if (!result) {
      const res = await fetch(`${serverUrl.replace(/\/$/, "")}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          video_url: url,
          title,
          transcript,
          num_questions: numQ,
          difficulty,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      result = data;
      meta.ai_origin = "Gemini API (server)";
      if (!meta.statusLabel) meta.statusLabel = "Server";
    }

    if (!result.study_plan_markdown && preferLocal) {
      try {
        const plan = await generateStudyPlanWithLocalAi({
          header,
          transcript: clipTranscript(transcript, 3200),
          preferredStrategy: nanoStrategy,
          temperature,
        });
        if (plan) {
          result.study_plan_markdown = plan;
          meta.statusLabel = meta.statusLabel
            ? `${meta.statusLabel} + Coach`
            : "On-device Coach";
          meta.ai_origin = meta.ai_origin
            ? `${meta.ai_origin} + Nano Coach`
            : formatAiOrigin(aiBridgeState.lastOrigin || "Gemini Nano");
        }
      } catch (planErr) {
        console.warn("[SmartTeacher] Study coach fallback skipped", planErr);
      }
    }

    meta.cache = force ? "Refreshed now" : "Fresh";
    applyGenerationResult(result, meta);

    try {
      const payload = JSON.parse(
        JSON.stringify({
          notes_markdown: state.notes_md,
          study_plan_markdown: state.study_plan_md,
          quiz: state.quiz,
          source_language: state.source_language,
          source_words: state.source_words,
          ai_origin: state.ai_origin,
        })
      );
      await saveCachedGeneration(cacheKeyId, fingerprint, transcriptHash, payload);
    } catch (cacheErr) {
      console.warn("[SmartTeacher] Cache save skipped", cacheErr);
    }
  } catch (e) {
    console.error(e);
    setStatus("Error. See console.");
    alert("Smart Teacher error:\n" + e.message);
  } finally {
    generationInProgress = false;
    const rb = document.getElementById("st-refresh");
    if (rb) rb.disabled = false;
    setProgressVisible(false);
  }
}

// Auto-inject overlay when on a watch page
if (/youtube\.com\/watch/.test(location.href)) {
  injectOverlay();
}
