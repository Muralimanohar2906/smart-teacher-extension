const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:8000',
  numQ: 5,
  difficulty: 'mixed',
  preferLocal: true,
  nanoStrategy: 'auto',
  temperature: 0.6,
};

const serverUrlEl = document.getElementById('serverUrl');
const numQEl = document.getElementById('numQ');
const diffEl = document.getElementById('difficulty');
const preferLocalEl = document.getElementById('preferLocal');
const nanoStrategyEl = document.getElementById('nanoStrategy');
const temperatureEl = document.getElementById('temperature');
const temperatureLabelEl = document.getElementById('temperatureLabel');
const localHintEl = document.getElementById('localHint');
const statusEl = document.getElementById('status');
const checkStatusBtn = document.getElementById('checkStatus');
const nanoStatusChip = document.getElementById('nanoStatus');
const serverStatusChip = document.getElementById('serverStatus');
const statusNoteEl = document.getElementById('statusNote');

const describeTemperature = (value) => {
  const v = Number(value);
  if (v <= 0.35) return 'Deterministic';
  if (v <= 0.55) return 'Balanced';
  if (v <= 0.75) return 'Adaptive';
  return 'Creative';
};

const applyTemperatureLabel = (value) => {
  temperatureLabelEl.textContent = describeTemperature(value);
};

const applyLocalUiState = () => {
  const enabled = preferLocalEl.checked;
  nanoStrategyEl.disabled = !enabled;
  temperatureEl.disabled = !enabled;
  temperatureLabelEl.style.opacity = enabled ? '1' : '0.5';
  localHintEl.style.opacity = enabled ? '1' : '0.5';
};

const setChip = (chip, state, text) => {
  if (!chip) return;
  chip.dataset.state = state;
  chip.textContent = text;
};

const setStatusNote = (text) => {
  if (!statusNoteEl) return;
  statusNoteEl.textContent = text || '';
};

const checkServerHealth = async (url) => {
  if (!url) {
    return { state: 'warn', text: 'Server • URL missing', note: 'Set a server URL or rely on on-device mode.' };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`${url.replace(/\/$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!res.ok) {
      return { state: 'warn', text: `Server • ${res.status}`, note: 'Health check failed. Verify the FastAPI server.' };
    }
    const data = await res.json().catch(() => ({}));
    const model = data.model || data.active_model || 'unknown model';
    return { state: 'ready', text: `Server • ${model}`, note: 'Server is reachable. Gemini cloud fallback ready.' };
  } catch (err) {
    return { state: 'error', text: 'Server • offline', note: 'Could not reach server. It may be stopped or blocked.' };
  }
};

const checkNanoStatus = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) {
      return { state: 'warn', text: 'Gemini Nano • no active tab', note: 'Open a YouTube video to test on-device AI.' };
    }
    if (!/youtube\.com/.test(tab.url || '')) {
      return { state: 'warn', text: 'Gemini Nano • open YouTube', note: 'Navigate to a YouTube video tab to leverage Nano.' };
    }
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        if (!window.ai || typeof window.ai.getCapabilities !== 'function') {
          return { available: false, reason: 'missing' };
        }
        try {
          const caps = await window.ai.getCapabilities();
          return { available: caps?.available !== 'no', raw: caps };
        } catch (error) {
          return { available: true, reason: error?.message || 'capabilities error' };
        }
      },
    });
    const result = injection?.result;
    if (!result || !result.available) {
      return {
        state: 'warn',
        text: 'Gemini Nano • not ready',
        note: 'Chrome has not exposed on-device AI yet. Check flags and model download.',
      };
    }
    const status = result.raw?.available || 'ready';
    if (status === 'readily') {
      return { state: 'ready', text: 'Gemini Nano • ready', note: 'On-device Gemini is available for instant runs.' };
    }
    if (status === 'after-download') {
      return {
        state: 'warn',
        text: 'Gemini Nano • downloading',
        note: 'Chrome is downloading the model. Try again in a few minutes.',
      };
    }
    return {
      state: 'warn',
      text: 'Gemini Nano • limited',
      note: 'Detected window.ai but availability is unclear. A quick reload may help.',
    };
  } catch (err) {
    return { state: 'error', text: 'Gemini Nano • error', note: err?.message || 'Could not evaluate window.ai. Allow scripting on this tab.' };
  }
};

const runQuickCheck = async () => {
  setStatusNote('Checking availability…');
  setChip(nanoStatusChip, 'unknown', 'Gemini Nano • checking…');
  setChip(serverStatusChip, 'unknown', 'Server • checking…');
  checkStatusBtn.disabled = true;
  try {
    const serverResult = await checkServerHealth(serverUrlEl.value.trim());
    setChip(serverStatusChip, serverResult.state, serverResult.text);

    const nanoResult = await checkNanoStatus();
    setChip(nanoStatusChip, nanoResult.state, nanoResult.text);

    const combinedNote = `${nanoResult.note || ''}${nanoResult.note && serverResult.note ? '\n' : ''}${serverResult.note || ''}`.trim();
    setStatusNote(combinedNote);
  } finally {
    checkStatusBtn.disabled = false;
  }
};

(async () => {
  const stored = await chrome.storage.sync.get([
    'serverUrl',
    'numQ',
    'difficulty',
    'preferLocal',
    'nanoStrategy',
    'temperature'
  ]);
  serverUrlEl.value = stored.serverUrl || DEFAULTS.serverUrl;
  numQEl.value = stored.numQ ?? DEFAULTS.numQ;
  diffEl.value = stored.difficulty || DEFAULTS.difficulty;
  preferLocalEl.checked = typeof stored.preferLocal === 'boolean'
    ? stored.preferLocal
    : DEFAULTS.preferLocal;
  nanoStrategyEl.value = stored.nanoStrategy || DEFAULTS.nanoStrategy;
  const temp = typeof stored.temperature === 'number'
    ? stored.temperature
    : DEFAULTS.temperature;
  temperatureEl.value = temp;
  applyTemperatureLabel(temp);
  applyLocalUiState();
  setChip(nanoStatusChip, 'unknown', 'Gemini Nano • not checked');
  setChip(serverStatusChip, 'unknown', 'Server • not checked');
  setStatusNote('Tip: run a quick check to confirm on-device AI and server reachability.');
  runQuickCheck().catch(() => {});
})();

serverUrlEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ serverUrl: serverUrlEl.value.trim() });
});

preferLocalEl.addEventListener('change', async () => {
  applyLocalUiState();
  await chrome.storage.sync.set({ preferLocal: preferLocalEl.checked });
});

nanoStrategyEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ nanoStrategy: nanoStrategyEl.value });
});

temperatureEl.addEventListener('input', () => {
  applyTemperatureLabel(temperatureEl.value);
});

temperatureEl.addEventListener('change', async () => {
  await chrome.storage.sync.set({ temperature: Number(temperatureEl.value) });
});

checkStatusBtn?.addEventListener('click', () => {
  runQuickCheck().catch((err) => {
    setStatusNote(err?.message || 'Unable to complete readiness check.');
  });
});

document.getElementById('genBtn').addEventListener('click', async () => {
  statusEl.textContent = 'Requesting generation...';
  await chrome.storage.sync.set({
    serverUrl: serverUrlEl.value.trim(),
    numQ: Number(numQEl.value),
    difficulty: diffEl.value,
    preferLocal: preferLocalEl.checked,
    nanoStrategy: nanoStrategyEl.value,
    temperature: Number(temperatureEl.value)
  });
  chrome.runtime.sendMessage({ type: 'ST_GENERATE' }, () => {
    statusEl.textContent = 'Working… watch the page overlay.';
  });
});
