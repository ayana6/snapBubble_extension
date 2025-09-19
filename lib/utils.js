export const STORAGE_KEYS = {
  SETTINGS: "sb_settings"
};

export function getDefaultSettings() {
  return {
    enabled: true,
    targetLanguage: "en",
    ocrProvider: "ocrspace",
    ocrEngine: "1",
    translateProvider: "openai",
    openaiModel: "gpt-4o-mini",
    ocrApiKey: "",
    translateApiKey: "",
    libreEndpoint: "https://libretranslate.com/translate",
    maxConcurrentImages: 2,
    minImageSize: { width: 220, height: 220 },
    forceOcrLang: "chs",
    fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
    textSize: 16,
    useAiOcr: false,
    aiModel: "gemini-2-flash",
    overlay: {
      fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
      fontCssUrl: "",
      fontSizePx: 18,
      lineHeight: 1.25,
      padding: 6,
      backgroundAlpha: 1
    }
  };
}

export async function loadSettings() {
  const def = getDefaultSettings();
  const r = await chrome.storage.sync.get([STORAGE_KEYS.SETTINGS]);
  const saved = r?.[STORAGE_KEYS.SETTINGS] || {};
  
  // Load personal API keys from local storage
  const localData = await chrome.storage.local.get(['personalOcrKey', 'personalTranslateKey']);
  
  // Shallow merge, then deep-merge overlay so defaults get upgraded
  const merged = { ...def, ...saved };
  merged.overlay = { ...def.overlay, ...(saved.overlay || {}) };
  
  // Override with personal API keys if they exist
  if (localData.personalOcrKey) {
    merged.ocrApiKey = localData.personalOcrKey;
  }
  if (localData.personalTranslateKey) {
    merged.translateApiKey = localData.personalTranslateKey;
  }
  
  for (const k of ["ocrApiKey","translateProvider","translateApiKey","libreEndpoint","ocrProvider"]) {
    if (merged[k] === "" || merged[k] == null) merged[k] = def[k];
  }
  // For user preferences, only use defaults if truly empty (not just empty string)
  if (merged.targetLanguage == null) merged.targetLanguage = def.targetLanguage;
  if (merged.forceOcrLang == null) merged.forceOcrLang = def.forceOcrLang;
  if (merged.fontFamily == null) merged.fontFamily = def.fontFamily;
  if (merged.textSize == null) merged.textSize = def.textSize;
  // Upgrade font family if missing/old
  if (!saved?.overlay?.fontFamily || saved?.overlay?.fontFamily === "Arial, sans-serif") {
    merged.overlay.fontFamily = def.overlay.fontFamily;
  }
  if (!merged.minImageSize?.width || !merged.minImageSize?.height) {
    merged.minImageSize = def.minImageSize;
  }
  return merged;
}

export async function saveSettings(settings) {
  await chrome.storage.sync.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

export async function resetSettings() {
  await chrome.storage.sync.remove([STORAGE_KEYS.SETTINGS]);
}

export function isLargeEnough(img, min) {
  const w = img.naturalWidth || img.width || 0;
  const h = img.naturalHeight || img.height || 0;
  return (w >= (min?.width || 0) && h >= (min?.height || 0));
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

export function calculateImageScaling(width, height, maxSize = 1600) {
  const ratio = Math.min(1, maxSize / Math.max(width, height));
  return {
    ratio,
    scaledWidth: Math.max(1, Math.floor(width * ratio)),
    scaledHeight: Math.max(1, Math.floor(height * ratio))
  };
}
