import { loadSettings, saveSettings, resetSettings, getDefaultSettings } from "../lib/utils.js";

const els = {
  forceOcrLang: document.getElementById("forceOcrLang"),
  targetLanguage: document.getElementById("targetLanguage"),
  ocrEngine: document.getElementById("ocrEngine"),
  ocrApiKey: document.getElementById("ocrApiKey"),
  translateProvider: document.getElementById("translateProvider"),
  openaiModel: document.getElementById("openaiModel"),
  openaiModelRow: document.getElementById("openaiModelRow"),
  translateApiKey: document.getElementById("translateApiKey"),
  minWidth: document.getElementById("minWidth"),
  minHeight: document.getElementById("minHeight"),
  fontFamily: document.getElementById("fontFamily"),
  textSize: document.getElementById("textSize"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  rescanBtn: document.getElementById("rescanBtn"),
  manualSelectBtn: document.getElementById("manualSelectBtn"),
  defaultsBtn: document.getElementById("defaultsBtn"),
  copyOcrKey: document.getElementById("copyOcrKey"),
  copyTranslateKey: document.getElementById("copyTranslateKey"),
  useAiOcr: document.getElementById("useAiOcr"),
  aiModel: document.getElementById("aiModel"),
  aiModelRow: document.getElementById("aiModelRow"),
  batchProcessing: document.getElementById("batchProcessing")
};

async function init() {
  const s = await loadSettings();
  const def = getDefaultSettings();
  
  if (els.forceOcrLang) els.forceOcrLang.value = s.forceOcrLang || def.forceOcrLang || "";
  if (els.targetLanguage) els.targetLanguage.value = s.targetLanguage || def.targetLanguage || "en";
  if (els.ocrEngine) els.ocrEngine.value = s.ocrEngine || def.ocrEngine || "1";
  if (els.translateProvider) els.translateProvider.value = s.translateProvider || def.translateProvider || "gemini";
  if (els.openaiModel) els.openaiModel.value = s.openaiModel || def.openaiModel || "gpt-4o-mini";
  if (els.minWidth) els.minWidth.value = (s.minImageSize?.width ?? def.minImageSize?.width ?? 220).toString();
  if (els.minHeight) els.minHeight.value = (s.minImageSize?.height ?? def.minImageSize?.height ?? 220).toString();
  if (els.fontFamily) els.fontFamily.value = s.fontFamily || def.fontFamily || "Arial, sans-serif";
  if (els.textSize) els.textSize.value = (s.textSize ?? def.textSize ?? 16).toString();
  if (els.useAiOcr) els.useAiOcr.checked = s.useAiOcr || false;
  if (els.aiModel) els.aiModel.value = s.aiModel || "gemini-2.5-flash";
  if (els.batchProcessing) els.batchProcessing.checked = s.batchProcessing || false;
  
  if (els.aiModelRow) {
    els.aiModelRow.style.display = els.useAiOcr?.checked ? "flex" : "none";
  }
  if (els.openaiModelRow) {
    els.openaiModelRow.style.display = (els.translateProvider?.value === 'openai') ? "flex" : "none";
  }
  syncAiUi();
  
  await loadPersonalApiKeys();
}

async function save() {
  const s = await loadSettings();
  const def = getDefaultSettings();
  s.forceOcrLang = els.forceOcrLang?.value ?? def.forceOcrLang;
  s.targetLanguage = els.targetLanguage?.value ?? def.targetLanguage;
  s.ocrEngine = els.ocrEngine?.value || def.ocrEngine;
  s.translateProvider = els.translateProvider?.value || def.translateProvider;
  s.openaiModel = els.openaiModel?.value || def.openaiModel;
  s.minImageSize = { width: Number(els.minWidth?.value || def.minImageSize.width), height: Number(els.minHeight?.value || def.minImageSize.height) };
  s.fontFamily = els.fontFamily?.value ?? def.fontFamily;
  s.textSize = Number(els.textSize?.value ?? def.textSize);
  s.useAiOcr = els.useAiOcr?.checked || false;
  s.aiModel = els.aiModel?.value || "gemini-2.5-flash";
  s.batchProcessing = els.batchProcessing?.checked || false;
  await saveSettings(s);
}

function sendToTab(payload) {
  chrome.runtime.sendMessage({ type: "SB_FORWARD_TO_TAB", payload });
}

els.startBtn?.addEventListener("click", async () => {
  await save();
  sendToTab({ type: "SB_START" });
});

els.stopBtn?.addEventListener("click", async () => {
  sendToTab({ type: "SB_STOP" });
});

els.rescanBtn?.addEventListener("click", async () => {
  await save();
  sendToTab({ type: "SB_RESCAN" });
});

els.manualSelectBtn?.addEventListener("click", async () => {
  sendToTab({ type: "SB_MANUAL_SELECT" });
  window.close(); // Close popup so user can see the page
});

els.defaultsBtn?.addEventListener("click", async () => {
  await resetSettings();
  await chrome.storage.local.remove(['personalOcrKey', 'personalTranslateKey']);
  await init();
});

els.copyOcrKey?.addEventListener("click", async () => {
  const key = els.ocrApiKey?.value;
  if (key) {
    try {
      await navigator.clipboard.writeText(key);
      els.copyOcrKey.textContent = "✓";
      setTimeout(() => { els.copyOcrKey.textContent = "📋"; }, 1000);
    } catch (err) {
      els.ocrApiKey?.select();
      document.execCommand('copy');
      els.copyOcrKey.textContent = "✓";
      setTimeout(() => { els.copyOcrKey.textContent = "📋"; }, 1000);
    }
  }
});

els.copyTranslateKey?.addEventListener("click", async () => {
  const key = els.translateApiKey?.value;
  if (key) {
    try {
      await navigator.clipboard.writeText(key);
      els.copyTranslateKey.textContent = "✓";
      setTimeout(() => { els.copyTranslateKey.textContent = "📋"; }, 1000);
    } catch (err) {
      els.translateApiKey?.select();
      document.execCommand('copy');
      els.copyTranslateKey.textContent = "✓";
      setTimeout(() => { els.copyTranslateKey.textContent = "📋"; }, 1000);
    }
  }
});

async function loadPersonalApiKeys() {
  try {
    const result = await chrome.storage.local.get([
      'personalOcrKey',
      'personalTranslateKey'
    ]);

    document.getElementById('ocrApiKey').value = result.personalOcrKey || '';
    document.getElementById('translateApiKey').value = result.personalTranslateKey || '';
  } catch (error) {
    console.error('Error loading personal API keys:', error);
  }
}

function savePersonalApiKeys() {
  const ocrKey = document.getElementById('ocrApiKey').value.trim();
  const translateKey = document.getElementById('translateApiKey').value.trim();

  chrome.storage.local.set({
    personalOcrKey: ocrKey,
    personalTranslateKey: translateKey
  });
}

['ocrApiKey', 'translateApiKey'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => { try { savePersonalApiKeys(); } catch {} });
    el.addEventListener('change', () => { try { savePersonalApiKeys(); } catch {} });
    el.addEventListener('blur', () => { try { savePersonalApiKeys(); } catch {} });
  }
});

els.useAiOcr?.addEventListener('change', () => {
  syncAiUi();
  save();
});

els.batchProcessing?.addEventListener('change', save);

els.aiModel?.addEventListener('change', save);

els.translateProvider?.addEventListener('change', () => {
  if (els.openaiModelRow) {
    els.openaiModelRow.style.display = (els.translateProvider.value === 'openai') ? 'flex' : 'none';
  }
  save();
});

els.openaiModel?.addEventListener('change', save);

function syncAiUi() {
  const aiOn = !!els.useAiOcr?.checked;
  if (els.forceOcrLang) els.forceOcrLang.disabled = aiOn;
  if (els.ocrEngine) els.ocrEngine.disabled = aiOn;
  if (els.ocrApiKey) els.ocrApiKey.disabled = aiOn;
  if (els.copyOcrKey) els.copyOcrKey.disabled = aiOn;

  const visionProviders = new Set(['openai', 'gemini', 'gemini-pro', 'gemini-2']);
  if (els.translateProvider) {
    const opts = Array.from(els.translateProvider.options || []);
    opts.forEach(o => { if (!visionProviders.has(o.value)) o.disabled = aiOn; });
    if (aiOn && !visionProviders.has(els.translateProvider.value)) {
      els.translateProvider.value = 'openai';
    }
    if (els.openaiModelRow) {
      els.openaiModelRow.style.display = (els.translateProvider.value === 'openai') ? 'flex' : 'none';
    }
  }

  if (els.aiModelRow) els.aiModelRow.style.display = aiOn ? 'flex' : 'none';
}

[els.fontFamily, els.textSize, els.forceOcrLang, els.targetLanguage, els.ocrProvider, els.ocrEngine, els.translateProvider, els.minWidth, els.minHeight].forEach(el => {
  el?.addEventListener('change', async () => { try { await save(); } catch {} });
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadPersonalApiKeys();
  await init();
});
