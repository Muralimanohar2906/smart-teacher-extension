(() => {
  const CHANNEL = "__st_ai_bridge__";

  const send = (type, detail = {}) => {
    window.postMessage({ channel: CHANNEL, type, detail }, "*");
  };

  const hasWindowAi =
    typeof window !== "undefined" &&
    window.ai &&
    typeof window.ai.getCapabilities === "function" &&
    typeof window.ai.createTextSession === "function";

  const hasChromeAi =
    typeof chrome !== "undefined" &&
    chrome.aiOriginTrial &&
    chrome.aiOriginTrial.languageModel &&
    typeof chrome.aiOriginTrial.languageModel.capabilities === "function" &&
    typeof chrome.aiOriginTrial.languageModel.create === "function";

  const strategies = [];
  if (hasWindowAi) strategies.push("window.ai");
  if (hasChromeAi) strategies.push("chrome.aiOriginTrial");

  send("bridge-ready", {
    strategies,
    available: strategies.length > 0,
  });

  if (!strategies.length) {
    return;
  }

  const withTimeout = (ms, promise) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), ms);
      promise
        .then((val) => {
          clearTimeout(timer);
          resolve(val);
        })
        .catch((err) => {
          clearTimeout(timer);
          reject(err);
        });
    });

  async function ensureWindowAiReady() {
    const caps = await withTimeout(7000, window.ai.getCapabilities());
    return caps;
  }

  async function ensureChromeAiReady() {
    const caps = await withTimeout(
      7000,
      chrome.aiOriginTrial.languageModel.capabilities()
    );
    return caps;
  }

  async function runWithWindowAi(payload) {
    const caps = await ensureWindowAiReady();
    if (!caps || caps.available === "no") {
      throw new Error("window.ai model unavailable");
    }
    const session = await withTimeout(
      8000,
      window.ai.createTextSession({
        topK: payload.topK,
        topP: payload.topP,
        temperature: payload.temperature,
        candidateCount: 1,
        systemPrompt: payload.systemPrompt || "",
      })
    );
    const output = await withTimeout(42000, session.prompt(payload.prompt));
    return {
      output,
      origin: "window.ai",
      capabilities: caps,
    };
  }

  async function runWithChromeAi(payload) {
    const caps = await ensureChromeAiReady();
    if (!caps || caps.available === "no") {
      throw new Error("chrome.aiOriginTrial model unavailable");
    }
    const session = await withTimeout(
      8000,
      chrome.aiOriginTrial.languageModel.create({
        temperature: payload.temperature ?? 0.6,
        topK: payload.topK,
        topP: payload.topP ?? 0.9,
        maxOutputTokens: payload.maxOutputTokens ?? 2048,
        safetySettings: payload.safetySettings,
        stopSequences: payload.stopSequences,
        systemPrompt: payload.systemPrompt || "",
      })
    );
    const { output } = await withTimeout(
      42000,
      session.prompt({ input: payload.prompt })
    );
    return {
      output,
      origin: "chrome.aiOriginTrial",
      capabilities: caps,
    };
  }

  async function handlePrompt(payload) {
    const preferred = payload.preferredStrategy;
    const sequential = strategies.slice();
    if (preferred && strategies.includes(preferred)) {
      sequential.sort((a, b) => (a === preferred ? -1 : b === preferred ? 1 : 0));
    }

    const errors = [];
    for (const strategy of sequential) {
      try {
        if (strategy === "window.ai") {
          return await runWithWindowAi(payload);
        }
        if (strategy === "chrome.aiOriginTrial") {
          return await runWithChromeAi(payload);
        }
      } catch (err) {
        errors.push({ strategy, message: err?.message || String(err) });
      }
    }
    const message = errors
      .map((e) => `${e.strategy}: ${e.message}`)
      .join(" | ");
    throw new Error(message || "On-device AI failure");
  }

  window.addEventListener("message", async (event) => {
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.from !== "content") return;

    if (data.type === "prompt") {
      const { id, payload } = data;
      try {
        const result = await handlePrompt(payload);
        send("prompt-success", { id, result });
      } catch (error) {
        send("prompt-error", {
          id,
          error: error?.message || String(error),
        });
      }
    }
  });
})();
