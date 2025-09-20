export const STORAGE_KEYS = {
  SETTINGS: "sb_settings",
  ERROR_TRACKER: "sb_error_tracker"
};

export function getDefaultSettings() {
  return {
    enabled: true,
    targetLanguage: "en",
    ocrEngine: "1",
    translateProvider: "gemini",
    openaiModel: "gpt-4o-mini",
    ocrApiKey: "",
    translateApiKey: "",
    maxConcurrentImages: 2,
    minImageSize: { width: 220, height: 220 },
    forceOcrLang: "",
    fontFamily: "Arial, 'Helvetica Neue', Helvetica, sans-serif",
    textSize: 16,
    useAiOcr: false,
    aiModel: "gemini-2.5-flash",
    batchProcessing: false, 
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
  
  const localData = await chrome.storage.local.get(['personalOcrKey', 'personalTranslateKey']);
  
  const merged = { ...def, ...saved };
  merged.overlay = { ...def.overlay, ...(saved.overlay || {}) };
  
  if (localData.personalOcrKey) {
    merged.ocrApiKey = localData.personalOcrKey;
  }
  if (localData.personalTranslateKey) {
    merged.translateApiKey = localData.personalTranslateKey;
  }
  
  for (const k of ["ocrApiKey","translateProvider","translateApiKey"]) {
    if (merged[k] === "" || merged[k] == null) merged[k] = def[k];
  }
  if (merged.targetLanguage == null) merged.targetLanguage = def.targetLanguage;
  if (merged.forceOcrLang == null) merged.forceOcrLang = def.forceOcrLang;
  if (merged.fontFamily == null) merged.fontFamily = def.fontFamily;
  if (merged.textSize == null) merged.textSize = def.textSize;
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

export async function trackError(errorType, errorMessage, provider = null) {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEYS.ERROR_TRACKER]);
    const tracker = data[STORAGE_KEYS.ERROR_TRACKER] || { errors: {}, lastReset: Date.now() };
    
    const key = provider ? `${errorType}:${provider}` : errorType;
    if (!tracker.errors[key]) {
      tracker.errors[key] = { count: 0, lastError: null, messages: [] };
    }
    
    tracker.errors[key].count++;
    tracker.errors[key].lastError = Date.now();
    tracker.errors[key].messages.push({
      message: errorMessage,
      timestamp: Date.now()
    });
    
    if (tracker.errors[key].messages.length > 5) {
      tracker.errors[key].messages = tracker.errors[key].messages.slice(-5);
    }
    
    await chrome.storage.local.set({ [STORAGE_KEYS.ERROR_TRACKER]: tracker });
    return tracker.errors[key];
  } catch (e) {
    console.warn('[SB] Failed to track error:', e);
    return null;
  }
}

export async function shouldStopProcessing(errorType, provider = null, maxErrors = 3) {
  try {
    const data = await chrome.storage.local.get([STORAGE_KEYS.ERROR_TRACKER]);
    const tracker = data[STORAGE_KEYS.ERROR_TRACKER] || { errors: {}, lastReset: Date.now() };
    
    const key = provider ? `${errorType}:${provider}` : errorType;
    const errorInfo = tracker.errors[key];
    
    if (!errorInfo) return false;
    
    if (Date.now() - errorInfo.lastError > 5 * 60 * 1000) {
      errorInfo.count = 0;
      await chrome.storage.local.set({ [STORAGE_KEYS.ERROR_TRACKER]: tracker });
      return false;
    }
    
    return errorInfo.count >= maxErrors;
  } catch (e) {
    console.warn('[SB] Failed to check error threshold:', e);
    return false;
  }
}

export async function clearErrorTracker() {
  try {
    await chrome.storage.local.remove([STORAGE_KEYS.ERROR_TRACKER]);
  } catch (e) {
    console.warn('[SB] Failed to clear error tracker:', e);
  }
}
