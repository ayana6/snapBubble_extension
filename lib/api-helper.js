// Unified API helper to eliminate duplicate code patterns
export async function makeApiRequest(url, options, signal) {
    const requestId = options.requestId || Math.random().toString(36).slice(2);
    let abortListener;
    
    try {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      if (signal) {
        abortListener = () => { 
          try { chrome.runtime.sendMessage({ type: "SB_ABORT", requestId }); } catch {} 
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      const payload = { type: "SB_FETCH", requestId, url, init: options.init || {} };

      // First attempt
      let resp = await chrome.runtime.sendMessage(payload).catch(e => ({ __err: e }));
      // Retry once if background not ready
      if (!resp || resp.__err) {
        await new Promise(r => setTimeout(r, 150));
        resp = await chrome.runtime.sendMessage(payload).catch(e => ({ __err: e }));
        if (!resp || resp.__err) {
          try { if (typeof window !== 'undefined' && window.logHud) window.logHud('[ERR] BG channel unavailable'); } catch {}
          throw new Error('Receiving end does not exist');
        }
      }

      if (!resp?.ok) {
        throw new Error(`API request failed: ${resp?.status} - ${resp?.error || 'Unknown error'}`);
      }
      
      return resp;
    } finally {
      if (abortListener && signal) { 
        try { signal.removeEventListener("abort", abortListener); } catch {} 
      }
    }
  }
  
  export function createRequestId(prefix = "req") {
    return `${prefix}-${Math.random().toString(36).slice(2)}`;
  }
  
  export function parseJsonResponse(resp) {
    try {
      return JSON.parse(resp.body || "{}");
    } catch {
      return {};
    }
  }