
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
  translateKeysRow: document.getElementById("translateKeysRow"),
  translateKeysList: document.getElementById("translateKeysList"),
  addTranslateKey: document.getElementById("addTranslateKey"),
  testTranslateKeys: document.getElementById("testTranslateKeys"),
  translateKeysStatus: document.getElementById("translateKeysStatus"),
  translateApiKeyRow: document.getElementById("translateApiKeyRow"),
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
  testOcrKey: document.getElementById("testOcrKey"),
  copyTranslateKey: document.getElementById("copyTranslateKey"),
  testTranslatePrimaryKey: document.getElementById("testTranslatePrimaryKey"),
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
  const tier = document.getElementById('geminiTier1');
  if (tier) tier.checked = !!s.geminiTier1;
  const gm = document.getElementById('geminiModel');
  if (gm) gm.value = s.geminiModel || 'gemini-2.0-flash-lite';
  const dbgEl = document.getElementById('debugEnabled');
  if (dbgEl) dbgEl.checked = !!s.debugEnabled;

  // Populate multiple translate keys UI
  renderTranslateKeys(s.translateApiKeys || [], s.translateApiKey || "");
  
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
  const tier = document.getElementById('geminiTier1');
  if (tier) s.geminiTier1 = !!tier.checked;
  const gm = document.getElementById('geminiModel');
  if (gm) s.geminiModel = gm.value || s.geminiModel;
  const dbgEl = document.getElementById('debugEnabled');
  s.debugEnabled = !!(dbgEl && dbgEl.checked);

  // collect multiple keys
  s.translateApiKeys = collectTranslateKeys();
  if (!s.translateApiKey && s.translateApiKeys.length) s.translateApiKey = s.translateApiKeys[0];
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
  if (els.translateKeysRow) {
    const needsKeys = ['openai','gemini','gemini-pro','gemini-2'].includes(els.translateProvider.value);
    els.translateKeysRow.style.display = needsKeys ? 'flex' : 'none';
    if (els.translateApiKeyRow) els.translateApiKeyRow.style.display = needsKeys ? 'flex' : 'none';
  }
  // Toggle Gemini tier/model rows
  const tierRow = document.getElementById('geminiTierRow');
  const modelRow = document.getElementById('geminiModelRow');
  const showGem = ['gemini','gemini-2','gemini-pro'].includes(els.translateProvider.value);
  if (tierRow) tierRow.style.display = showGem ? 'flex' : 'none';
  if (modelRow) modelRow.style.display = showGem ? 'flex' : 'none';
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

[els.fontFamily, els.textSize, els.forceOcrLang, els.targetLanguage, els.ocrEngine, els.translateProvider, els.minWidth, els.minHeight].forEach(el => {
  el?.addEventListener('change', async () => { try { await save(); } catch {} });
});

document.addEventListener('DOMContentLoaded', async () => {
  await loadPersonalApiKeys();
  await init();
  if (els.translateKeysRow) {
    const s = await loadSettings();
    els.translateKeysRow.style.display = ['openai','gemini','gemini-pro','gemini-2'].includes(s.translateProvider) ? 'flex' : 'none';
    if (els.translateApiKeyRow) els.translateApiKeyRow.style.display = ['openai','gemini','gemini-pro','gemini-2'].includes(s.translateProvider) ? 'flex' : 'none';
    const tierRow = document.getElementById('geminiTierRow');
    const modelRow = document.getElementById('geminiModelRow');
    const showGem = ['gemini','gemini-2','gemini-pro'].includes(s.translateProvider);
    if (tierRow) tierRow.style.display = showGem ? 'flex' : 'none';
    if (modelRow) modelRow.style.display = showGem ? 'flex' : 'none';
  }
});

function renderTranslateKeys(keys, primary) {
  if (!els.translateKeysList) return;
  els.translateKeysList.innerHTML = '';
  const list = (Array.isArray(keys) && keys.length) ? keys.slice() : (primary ? [primary] : []);
  list.forEach((val, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:6px; align-items:center;';
    const input = document.createElement('input');
    input.type = 'password'; input.placeholder = `API key #${idx+1}`; input.value = val || ''; input.style.flex = '1';
    input.addEventListener('input', () => { try { saveTranslateKeysFromUI(); } catch {} });
    const del = document.createElement('button');
    del.className = 'btn btn-ghost'; del.title = 'Remove'; del.textContent = '✕';
    del.addEventListener('click', () => { row.remove(); saveTranslateKeysFromUI(); });
    row.appendChild(input); row.appendChild(del);
    els.translateKeysList.appendChild(row);
  });
  els.addTranslateKey?.addEventListener('click', () => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:6px; align-items:center;';
    const input = document.createElement('input');
    input.type = 'password'; input.placeholder = `API key #${(els.translateKeysList.children.length+1)}`; input.style.flex = '1';
    input.addEventListener('input', () => { try { saveTranslateKeysFromUI(); } catch {} });
    const del = document.createElement('button');
    del.className = 'btn btn-ghost'; del.title = 'Remove'; del.textContent = '✕';
    del.addEventListener('click', () => { row.remove(); saveTranslateKeysFromUI(); });
    row.appendChild(input); row.appendChild(del);
    els.translateKeysList.appendChild(row);
    saveTranslateKeysFromUI();
  });

  els.testTranslateKeys?.addEventListener('click', async () => {
    try {
      els.translateKeysStatus.textContent = 'Testing…';
      const keys = collectTranslateKeys();
      if (!keys.length) { els.translateKeysStatus.textContent = 'No keys to test.'; return; }
      const provider = els.translateProvider?.value || 'gemini';
      const ok = await testKeys(provider, keys);
      els.translateKeysStatus.textContent = ok ? 'All keys OK.' : 'Some keys failed (see console).';
    } catch (e) {
      els.translateKeysStatus.textContent = 'Test failed.';
    }
  });

  els.testTranslatePrimaryKey?.addEventListener('click', async () => {
    const key = (document.getElementById('translateApiKey').value || '').trim();
    const provider = els.translateProvider?.value || 'gemini';
    if (!key) return;
    els.translateKeysStatus.textContent = 'Testing…';
    const ok = await testKeys(provider, [key]);
    els.translateKeysStatus.textContent = ok ? 'Primary key OK.' : 'Primary key failed.';
  });

  els.testOcrKey?.addEventListener('click', async () => {
    try {
      const key = (document.getElementById('ocrApiKey').value || '').trim();
      if (!key) return;
      const form = new URLSearchParams();
      form.set('isOverlayRequired', 'false');
      form.set('OCREngine', '1');
      const { makeApiRequest, createRequestId } = await import('../lib/api-helper.js');
      const resp = await makeApiRequest('https://api.ocr.space/parse/image', {
        requestId: createRequestId('test-ocr'),
        init: { method: 'POST', headers: { 'apikey': key }, body: form }
      });
      if (resp?.ok) {
        alert('OCR key OK.');
      } else {
        alert('OCR key failed.');
      }
    } catch (e) {
      alert('OCR key test error.');
    }
  });
}

function collectTranslateKeys() {
  if (!els.translateKeysList) return [];
  const arr = [];
  els.translateKeysList.querySelectorAll('input[type="password"]').forEach(inp => {
    const v = (inp.value || '').trim(); if (v) arr.push(v);
  });
  return arr;
}

function saveTranslateKeysFromUI() {
  const keys = collectTranslateKeys();
  chrome.storage.local.set({ personalTranslateKeys: keys });
  save();
}

async function testKeys(provider, keys) {
  const sampleText = 'hello';
  const target = 'fr';
  const { makeApiRequest, createRequestId, parseJsonResponse } = await import('../lib/api-helper.js');
  if (provider.startsWith('gemini')) {
    for (const key of keys) {
      const body = { contents: [{ parts: [{ text: `Translate to ${target}: ${sampleText}` }] }], generationConfig: { temperature: 0 } };
      const gm = document.getElementById('geminiModel');
      const model = (gm && gm.value) ? gm.value : 'gemini-2.5-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
      const resp = await makeApiRequest(url, { requestId: createRequestId('test-gem'), init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } });
      if (!resp?.ok) { console.warn('Key failed (gemini)', resp); return false; }
    }
    return true;
  } else if (provider === 'openai') {
    for (const key of keys) {
      const body = { model: 'gpt-4o-mini', temperature: 0, messages: [ { role: 'system', content: 'You are a translator.' }, { role: 'user', content: `Translate to ${target}: ${sampleText}` } ] };
      const url = 'https://api.openai.com/v1/chat/completions';
      const resp = await makeApiRequest(url, { requestId: createRequestId('test-oa'), init: { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` }, body: JSON.stringify(body) } });
      if (!resp?.ok) { console.warn('Key failed (openai)', resp); return false; }
    }
    return true;
  } else if (provider === 'deepl') {
    for (const key of keys) {
      const url = 'https://api-free.deepl.com/v2/usage';
      const resp = await makeApiRequest(url, { requestId: createRequestId('test-dl'), init: { method: 'GET', headers: { 'Authorization': `DeepL-Auth-Key ${key}` } } });
      if (!resp?.ok) { console.warn('Key failed (deepl)', resp); return false; }
    }
    return true;
  }
  return true;
}