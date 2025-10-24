// content_script.js
// Smart Teacher - content script (auto transcript + backend call + timeline-synced notes & quiz)
// Paste/replace this file in your extension folder.

(async () => {
  console.log("🎓 Smart Teacher content script starting...");

  // --- Helper: read backend url from chrome storage (sync) ---
  const storageGet = (keys) =>
    new Promise((resolve) => {
      chrome.storage && chrome.storage.sync
        ? chrome.storage.sync.get(keys, (res) => resolve(res))
        : resolve(keys);
    });

  const { backendUrl: storedUrl } = await storageGet({ backendUrl: null });
  const backendUrl = (storedUrl || "http://127.0.0.1:8000").replace(/\/+$/, "");

  // --- Helper: auto-fetch transcript from youtubetranscript.com (primary) ---
  async function fetchTranscriptViaMirror(videoId) {
    try {
      // youtubetranscript.com returns an HTML page containing <text start="..." dur="..."> nodes in certain endpoints
      // This approach attempts to get the captions XML-like content.
      const resp = await fetch(`https://youtubetranscript.com/?server_vid=${videoId}`);
      if (!resp.ok) throw new Error("Transcript mirror returned non-OK");

      const html = await resp.text();

      // Try to extract <text start="..." dur="...">some text</text>
      const regex = /<text start="([\d.]+)"\s+dur="[\d.]+">([\s\S]*?)<\/text>/g;
      const out = [];
      let m;
      while ((m = regex.exec(html)) !== null) {
        let txt = m[2] || "";
        // Some pages may contain encoded HTML entities; decode basic ones
        txt = txt.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
        // Remove other HTML tags if present
        txt = txt.replace(/<\/?[^>]+(>|$)/g, "").trim();
        out.push({ start: parseFloat(m[1]), text: txt });
      }

      if (out.length) {
        console.log("🟢 Transcript fetched via mirror:", out.length, "lines");
        return out;
      }

      // fallback attempt: look for JSON payloads inside the returned HTML
      const jsonMatch = html.match(/\{[\s\S]*"captionTracks"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          // attempt to find transcript text inside parsed JSON structure
          const tracks = parsed.captionTracks || parsed.playerCaptionsTracklistRenderer?.captionTracks || [];
          if (tracks.length) {
            const first = tracks[0];
            // fetch actual subtitle XML or JSON if URL present
            if (first.baseUrl) {
              const sresp = await fetch(first.baseUrl);
              const stext = await sresp.text();
              // try same regex on stext
              const out2 = [];
              let mm;
              while ((mm = /<text start="([\d.]+)"[^>]*>([\s\S]*?)<\/text>/g.exec(stext)) !== null) {
                let txt = mm[2].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
                txt = txt.replace(/<\/?[^>]+(>|$)/g, "").trim();
                out2.push({ start: parseFloat(mm[1]), text: txt });
              }
              if (out2.length) return out2;
            }
          }
        } catch (e) {
          /* ignore JSON parse errors */
        }
      }

      throw new Error("Mirror parsing found no transcript.");
    } catch (err) {
      console.warn("Transcript mirror fetch failed:", err);
      return null;
    }
  }

  // --- Helper: DOM fallback (reads if the user opened transcript panel) ---
  function fetchTranscriptFromDOM() {
    try {
      const nodes = document.querySelectorAll("ytd-transcript-renderer ytd-transcript-segment-renderer, ytd-transcript-segment-renderer");
      if (!nodes || nodes.length === 0) return null;
      const out = Array.from(nodes).map((el) => {
        const timeText = el.querySelector(".segment-timestamp")?.textContent?.trim() || "0:00";
        const parts = timeText.split(":").map((s) => parseFloat(s));
        let start = 0;
        if (parts.length === 2) start = parts[0] * 60 + parts[1];
        else if (parts.length === 3) start = parts[0] * 3600 + parts[1] * 60 + parts[2];
        const text = el.querySelector(".segment-text")?.textContent?.trim() || el.textContent.trim();
        return { start, text };
      });
      if (out.length) {
        console.log("🟡 Transcript fetched from DOM (transcript panel open):", out.length, "lines");
        return out;
      }
      return null;
    } catch (e) {
      console.warn("DOM transcript extraction failed:", e);
      return null;
    }
  }

  // --- Master getTranscript: try mirror -> DOM -> fail ---
  async function getTranscript() {
    // try mirror if videoId found
    const videoId = new URL(window.location.href).searchParams.get("v");
    if (!videoId) {
      alert("⚠️ Couldn't find video id in URL.");
      return [];
    }

    // 1) mirror (primary)
    const mirror = await fetchTranscriptViaMirror(videoId);
    if (mirror && mirror.length) return mirror;

    // 2) DOM fallback
    const dom = fetchTranscriptFromDOM();
    if (dom && dom.length) return dom;

    // 3) final try: attempt YouTube timedtext endpoint directly (may be CORS-blocked in browser)
    try {
      const url = `https://www.youtube.com/api/timedtext?lang=en&v=${videoId}`;
      const r = await fetch(url);
      if (r.ok) {
        const txt = await r.text();
        // parse <text start=".." dur="..">...</text> xml
        const parser = new DOMParser();
        const doc = parser.parseFromString(txt, "text/xml");
        const nodes = Array.from(doc.getElementsByTagName("text") || []);
        const out = nodes.map((n) => ({
          start: parseFloat(n.getAttribute("start") || 0),
          text: (n.textContent || "").replace(/\s+/g, " ").trim()
        }));
        if (out.length) {
          console.log("🟢 Transcript fetched from YouTube timedtext endpoint:", out.length);
          return out;
        }
      }
    } catch (e) {
      console.warn("Direct timedtext fetch failed (likely CORS):", e);
    }

    // nothing found
    return [];
  }

  // --- Get transcript (auto) ---
  const transcript = await getTranscript();
  if (!transcript || transcript.length === 0) {
    alert("⚠️ Could not auto-fetch transcript. Please open the YouTube transcript panel manually, then click Inject again.");
    return;
  }

  // --- Prepare and send transcript to backend ---
  const videoId = new URL(window.location.href).searchParams.get("v");
  const videoTitle = document.title.replace(" - YouTube", "");
  let aiResponse;
  try {
    console.log("📤 Sending transcript to backend:", backendUrl + "/generate");
    const r = await fetch(`${backendUrl}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ video_id: videoId, title: videoTitle, transcript })
    });

    aiResponse = await r.json();
    if (!r.ok) {
      console.error("Backend respond error:", aiResponse);
      const msg = aiResponse?.detail || JSON.stringify(aiResponse);
      alert("Backend error: " + msg);
      return;
    }
    console.log("✅ AI response received:", aiResponse);
  } catch (err) {
    console.error("Failed to call backend:", err);
    alert("Failed to contact Smart Teacher backend. Check popup config and server.");
    return;
  }

  // Validate aiResponse shape
  if (!aiResponse || typeof aiResponse.notes !== "string" || !Array.isArray(aiResponse.questions)) {
    console.warn("Unexpected LLM response shape:", aiResponse);
    alert("Unexpected response from backend.");
    return;
  }

  // --- Insert UI under video title ---
  const titleEl = document.querySelector("#title.ytd-watch-metadata");
  if (!titleEl) {
    // try alternate selectors
    const alt = document.querySelector("#info-contents") || document.querySelector("#meta-contents");
    if (alt) {
      console.warn("Using alternate insertion point");
      // proceed with alt
      insertUnder(alt);
    } else {
      alert("⚠️ Could not find a good place to insert Smart Teacher UI.");
      console.warn("titleEl not found");
      return;
    }
  } else {
    insertUnder(titleEl);
  }

  // Insert container helper
  function insertUnder(refEl) {
    // If previously inserted, remove to avoid duplicates
    const existing = document.querySelector(".smart-teacher-under-title");
    if (existing) existing.remove();

    const container = document.createElement("div");
    container.className = "smart-teacher-under-title";
    container.style.maxWidth = "100%";
    container.style.boxSizing = "border-box";
    container.innerHTML = `
      <div class="st-header">🧠 Smart Teacher</div>
      <div class="st-current-note"></div>
      <div class="st-current-quiz"></div>
    `;
    // Insert after refEl (title area)
    if (refEl.parentElement) refEl.parentElement.insertBefore(container, refEl.nextSibling);
    else document.body.appendChild(container);

    // Start timeline sync
    startTimeline(container, transcript, aiResponse.questions || []);
  }

  // --- Timeline sync: show current note + quiz around question times ---
  function startTimeline(containerEl, transcriptArr, questionsArr) {
    const noteEl = containerEl.querySelector(".st-current-note");
    const quizEl = containerEl.querySelector(".st-current-quiz");
    const videoEl = document.querySelector("video");
    if (!videoEl) {
      console.warn("No video element found for timeline sync");
      return;
    }

    // Pre-sort transcript and questions
    transcriptArr.sort((a, b) => a.start - b.start);
    questionsArr.sort((a, b) => (a.start || 0) - (b.start || 0));

    let lastNoteIndex = -1;
    let lastQuizIndex = -1;

    // render helper for quiz
    function renderQuiz(q) {
      if (!q) {
        quizEl.innerHTML = "";
        return;
      }
      // allow q.choices to be either [{text: 'x'}] or strings
      const choicesHtml = (q.choices || [])
        .map((c, j) => {
          const text = typeof c === "string" ? c : c?.text || "";
          return `<button class="st-choice" data-correct="${j === (q.answer_index||0)}" data-start="${q.start}" style="display:block;width:100%;margin:6px 0;padding:8px;border-radius:6px;border:1px solid #ccc;background:#eee;text-align:left;cursor:pointer">${escapeHtml(text)}</button>`;
        })
        .join("");
      quizEl.innerHTML = `<div class="st-quiz-box"><b>🧩 Question:</b> ${escapeHtml(q.prompt || "")}<div class="st-choices" style="margin-top:8px">${choicesHtml}</div></div>`;

      // attach handlers
      quizEl.querySelectorAll(".st-choice").forEach((btn) => {
        btn.addEventListener("click", (evt) => {
          const isCorrect = evt.currentTarget.dataset.correct === "true";
          if (isCorrect) {
            evt.currentTarget.style.background = "#4caf50";
            evt.currentTarget.style.color = "white";
          } else {
            evt.currentTarget.style.background = "#f44336";
            evt.currentTarget.style.color = "white";
            // optionally jump video slightly before the question start for context
            const s = Number(evt.currentTarget.dataset.start || 0);
            try {
              videoEl.currentTime = Math.max(0, s - 2);
              videoEl.play();
            } catch (e) {
              /* ignore */
            }
          }
        });
      });
    }

    // render helper for note
    function renderNote(n) {
      if (!n) {
        noteEl.innerHTML = "";
        return;
      }
      noteEl.innerHTML = `<div class="st-note-box" style="background:#f1f8e9;padding:10px;border-left:5px solid #81c784;border-radius:6px;margin-bottom:10px"><b>🕒 ${Math.floor(n.start)}s</b><div style="margin-top:6px">${escapeHtml(n.text)}</div></div>`;
    }

    // sync loop
    function tick() {
      const t = videoEl.currentTime || 0;

      // update note: latest transcript entry with start <= t
      let noteIdx = -1;
      // binary search-like approach (transcriptArr sorted)
      let lo = 0,
        hi = transcriptArr.length - 1;
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        if ((transcriptArr[mid].start || 0) <= t) {
          noteIdx = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      if (noteIdx !== lastNoteIndex) {
        lastNoteIndex = noteIdx;
        const note = noteIdx >= 0 ? transcriptArr[noteIdx] : null;
        renderNote(note);
      }

      // update quiz: find any question whose start is <= t < start + window (window = 8-12s)
      const windowSec = 10;
      const qIdx = questionsArr.findIndex((q) => {
        const start = Number(q.start || 0);
        return t >= start && t < start + windowSec;
      });

      if (qIdx !== lastQuizIndex) {
        lastQuizIndex = qIdx;
        const q = qIdx >= 0 ? questionsArr[qIdx] : null;
        renderQuiz(q);
      }

      // loop
      requestAnimationFrame(tick);
    }

    // Start the loop
    tick();
  }

  // --- Utility: escape HTML to avoid injection ---
  function escapeHtml(str) {
    if (!str && str !== 0) return "";
    return String(str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }
})();
