/* global chrome */
const OVERLAY_ID = "st-overlay";
let state = { quiz: [], notes_md: "", score: 0 };

function injectOverlay() {
  if (document.getElementById(OVERLAY_ID)) return;
  fetch(chrome.runtime.getURL("ui/overlay.html"))
    .then(r => r.text())
    .then(html => {
      const el = document.createElement("div");
      el.innerHTML = html;
      document.body.appendChild(el.firstElementChild);
      bindOverlayEvents();
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
}

function setStatus(msg) {
  const s = document.getElementById("st-status");
  if (s) s.textContent = msg;
}

async function getSettings() {
  const { serverUrl='http://127.0.0.1:8000', numQ=5, difficulty='mixed' } =
    await chrome.storage.sync.get(['serverUrl','numQ','difficulty']);
  return { serverUrl, numQ, difficulty };
}

function parseVideoInfo() {
  const url = location.href;
  const titleEl = document.querySelector('h1.ytd-video-primary-info-renderer, h1.ytd-watch-metadata');
  const title = titleEl ? titleEl.textContent.trim() : document.title;
  return { url, title };
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
    state.quiz.forEach((q, idx) => {
      const val = document.querySelector(`input[name="q${idx}"]:checked`);
      if (val && Number(val.value) === q.correct_index) correct++;
    });
    const pct = Math.round((correct / state.quiz.length) * 100);
    state.score = pct;
    alert(`Score: ${correct}/${state.quiz.length} • ${pct}%`);
  });
  root.appendChild(submit);
}

function renderNotes(md) {
  // Lightweight Markdown to HTML (only headings, bullets, bold)
  let html = md
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/\*\*(.*?)\*\*/gim, '<b>$1</b>')
    .replace(/^\s*[-*]\s+(.*)$/gim, '<li>$1</li>')
    .replace(/(<li>.*<\/li>)/gims, '<ul>$1</ul>')
    .replace(/\n{2,}/g, '<br/>');
  document.getElementById("st-notes").innerHTML = html;
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

  doc.save("smart_teacher.pdf");
}

// Handle popup trigger
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "ST_GENERATE") startGeneration();
});

// Main flow
async function startGeneration() {
  injectOverlay();
  setStatus("Extracting transcript…");
  const { serverUrl, numQ, difficulty } = await getSettings();
  const { url, title } = parseVideoInfo();
  const transcript = await extractTranscript();

  setStatus("Talking to server…");
  try {
    const res = await fetch(`${serverUrl.replace(/\/$/,'')}/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        video_url: url, title, transcript,
        num_questions: numQ, difficulty
      })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();
    state.quiz = data.quiz;
    state.notes_md = data.notes_markdown;

    setStatus(`Ready • ${data.source_words} words processed`);
    renderQuiz();
    renderNotes(state.notes_md);
  } catch (e) {
    console.error(e);
    setStatus("Error. See console.");
    alert("Smart Teacher error:\n" + e.message);
  }
}

// Auto-inject overlay when on a watch page
if (/youtube\.com\/watch/.test(location.href)) {
  injectOverlay();
}
