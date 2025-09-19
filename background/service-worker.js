const inflight = new Map();

function arrayBufferToBase64(ab) {
  const bytes = new Uint8Array(ab);
  const chunkSize = 0x8000;
  let b64 = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const end = Math.min(i + chunkSize, bytes.length);
    let binary = '';
    for (let j = i; j < end; j++) binary += String.fromCharCode(bytes[j]);
    b64 += btoa(binary);
  }
  return b64;
}

function base64ToUint8(b64) {
  const binary = atob(b64 || '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;
  if (msg.type === "SB_FORWARD_TO_TAB") {
    try {
      chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
        try {
          const tab = (tabs || []).find(t => t?.id && /^https?:|^file:|^blob:/.test(t.url || '')) || (tabs || [])[0];
          if (tab?.id) {
            try { chrome.tabs.sendMessage(tab.id, msg.payload || {}); } catch {}
            return sendResponse({ ok: true });
          }
          chrome.tabs.query({ active: true }, (all) => {
            const t = (all || []).find(tt => tt?.id && /^https?:|^file:|^blob:/.test(tt.url || '')) || (all || [])[0];
            if (t?.id) {
              try { chrome.tabs.sendMessage(t.id, msg.payload || {}); } catch {}
              return sendResponse({ ok: true });
            }
            return sendResponse({ ok: false, error: 'no_active_tab' });
          });
        } catch (e) {
          return sendResponse({ ok: false, error: e?.message || 'forward_failed' });
        }
      });
    } catch (e) {
      return sendResponse({ ok: false, error: e?.message || 'forward_failed' });
    }
    return true;
  }
  if (msg.type === "SB_FETCH") {
    (async () => {
      try {
        const controller = new AbortController();
        if (msg.requestId) inflight.set(msg.requestId, controller);
        const init = Object.assign({}, msg.init || {}, { signal: controller.signal });
        try {
          if (typeof init.body === 'string') {
            const hasCT = !!(init.headers && (init.headers['content-type'] || init.headers['Content-Type']));
            if (!hasCT) {
              init.headers = Object.assign({}, init.headers, { 'content-type': 'application/json' });
            }
          }
        } catch {}
        try {
          const bodyStr = typeof init.body === 'string' ? init.body : null;
          if (bodyStr && /\/v1\/ocr/.test(msg.url)) {
            const len = bodyStr.length;
            const head = bodyStr.slice(0, 120);
            console.log(`[SB_FETCH] POST ${msg.url} jsonLen=${len} head=${head}`);
          }
          if (/api\.ocr\.space\//.test(msg.url)) {
            const formMode = !!msg.formFields || !!msg.formBinary;
            console.log(`[SB_FETCH] DIRECT OCR → ${msg.url} form=${formMode}`);
          }
        } catch {}
        if (msg.formFields && typeof msg.formFields === 'object') {
          const fd = new FormData();
          for (const [k, v] of Object.entries(msg.formFields)) {
            fd.set(k, v);
          }
          init.body = fd;
          if (!init.method) init.method = 'POST';
          if (init.headers) {
            try { delete init.headers['Content-Type']; } catch {}
            try { delete init.headers['content-type']; } catch {}
          }
        }
        if (msg.formBinary && typeof msg.formBinary === 'object') {
          const fd = init.body instanceof FormData ? init.body : (init.body = new FormData());
          for (const [k, info] of Object.entries(msg.formBinary)) {
            try {
              const bytes = base64ToUint8(info.b64 || '');
              const blob = new Blob([bytes], { type: info.type || 'application/octet-stream' });
              if (typeof fd.append === 'function') fd.append(k, blob, info.name || 'file');
            } catch {}
          }
          if (!init.method) init.method = 'POST';
          if (init.headers) {
            try { delete init.headers['Content-Type']; } catch {}
            try { delete init.headers['content-type']; } catch {}
          }
        }
        const resp = await fetch(msg.url, init);
        const headers = Array.from(resp.headers.entries());
        try {
          const keySrc = resp.headers.get('x-key-source');
          if (keySrc) {
            const lbl = keySrc;
            try {
              chrome.tabs.query({}, (tabs) => {
                for (const t of (tabs||[])) {
                  try {
                    const url = t?.url || '';
                    if (!/^https?:|^file:|^blob:/.test(url)) continue;
                    chrome.tabs.sendMessage(t.id, { type: 'SB_KEY_SRC', value: lbl }, () => void chrome.runtime.lastError);
                  } catch {}
                }
              });
            } catch {}
          }
        } catch {}
        if (msg.returnType === 'arrayBuffer') {
          const ab = await resp.arrayBuffer();
          const b64 = arrayBufferToBase64(ab);
          const ct = resp.headers.get('content-type') || '';
          sendResponse({ ok: resp.ok, status: resp.status, headers, contentType: ct, bodyB64: b64 });
        } else {
          const text = await resp.text();
          sendResponse({ ok: resp.ok, status: resp.status, headers, body: text });
        }
      } catch (e) {
        sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
      } finally {
        if (msg.requestId) inflight.delete(msg.requestId);
      }
    })();
    return true;
  }
  if (msg.type === "SB_CAPTURE") {
    try {
      const winId = sender?.tab?.windowId;
      const doCapture = (windowId) => {
        try {
          const options = { format: 'png', quality: 100 };
          if (typeof windowId === 'number') {
            chrome.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
              if (chrome.runtime.lastError || !dataUrl) return sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'capture_failed' });
              return sendResponse({ ok: true, dataUrl });
            });
          } else {
            chrome.tabs.captureVisibleTab(options, (dataUrl) => {
              if (chrome.runtime.lastError || !dataUrl) return sendResponse({ ok: false, error: chrome.runtime.lastError?.message || 'capture_failed' });
              return sendResponse({ ok: true, dataUrl });
            });
          }
        } catch (e) {
          return sendResponse({ ok: false, error: e?.message || 'capture_threw' });
        }
      };
      doCapture(winId);
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || 'capture_failed' });
    }
    return true;
  }
  if (msg.type === "SB_OCR_URL") {
    (async () => {
      try {
        const { url, engine, language, apiKey } = msg;
        // Fetch the image with sender page referrer
        const pageUrl = sender?.tab?.url || '';
        const r = await fetch(url, { method: 'GET', credentials: 'include', referrer: pageUrl, referrerPolicy: 'strict-origin-when-cross-origin' });
        if (!r.ok) {
          sendResponse({ ok: false, status: r.status, error: 'image fetch failed' });
          return;
        }
        const ab = await r.arrayBuffer();
        const b64 = arrayBufferToBase64(ab);
        const ct = (r.headers.get('content-type') || 'image/jpeg').split(';')[0];
        const dataUrl = `data:${ct};base64,${b64}`;
        
        // Call OCR.space API
        const form = new FormData();
        form.set('base64Image', dataUrl);
        form.set('isOverlayRequired', 'true');
        form.set('OCREngine', engine || '1');
        form.set('isTable', 'false');
        form.set('detectOrientation', 'true');
        form.set('scale', 'true');
        if (language) form.set('language', language);
        
        const headers = apiKey ? { 'apikey': apiKey } : {};
        const ocrResp = await fetch('https://api.ocr.space/parse/image', { method: 'POST', headers, body: form });
        
        if (!ocrResp.ok) {
          const body = await ocrResp.text().catch(() => '');
          console.warn('[SB][BG] OCR.space failed', ocrResp.status, body.slice(0, 200));
          sendResponse({ ok: false, status: ocrResp.status, error: body });
          return;
        }
        
        const json = await ocrResp.json();
        sendResponse({ ok: true, result: json });
      } catch (e) {
        console.warn('[SB][BG] SB_OCR_URL error:', e?.message || e);
        sendResponse({ ok: false, status: 0, error: e?.message || String(e) });
      }
    })();
    return true;
  }
  if (msg.type === "SB_ABORT") {
    try {
      const c = inflight.get(msg.requestId);
      if (c) c.abort();
      inflight.delete(msg.requestId);
      sendResponse({ ok: true });
    } catch (e) {
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  }
});
