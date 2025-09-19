
let isSelecting = false;
let selectionOverlay = null;
let startX = 0, startY = 0;
let currentX = 0, currentY = 0;

export function isManualSelectActive() {
  return isSelecting;
}

export function startManualSelect() {
  if (isSelecting) return;
  
  isSelecting = true;
  document.body.style.cursor = 'crosshair';
  
  // Create selection overlay
  selectionOverlay = document.createElement('div');
  selectionOverlay.id = 'sb-manual-select-overlay';
  selectionOverlay.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483647;
    pointer-events: auto;
    background: rgba(0, 0, 0, 0.3);
  `;
  
  // Create selection box
  const selectionBox = document.createElement('div');
  selectionBox.id = 'sb-selection-box';
  selectionBox.style.cssText = `
    position: absolute;
    border: 2px dashed #00ff00;
    background: rgba(0, 255, 0, 0.1);
    display: none;
    pointer-events: none;
  `;
  selectionOverlay.appendChild(selectionBox);
  
  // Create instructions
  const instructions = document.createElement('div');
  instructions.style.cssText = `
    position: fixed;
    top: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: rgba(0, 0, 0, 0.8);
    color: #00ff00;
    padding: 10px 20px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 14px;
    z-index: 2147483648;
    pointer-events: none;
  `;
  instructions.textContent = '📸 Drag to select area for translation • ESC to cancel';
  selectionOverlay.appendChild(instructions);
  
  document.body.appendChild(selectionOverlay);
  
  // Add event listeners
  selectionOverlay.addEventListener('mousedown', onMouseDown);
  selectionOverlay.addEventListener('mousemove', onMouseMove);
  selectionOverlay.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown);
  
  console.log('[SB] Manual select mode activated - drag to select area');
}

export function stopManualSelect() {
  if (!isSelecting) return;
  
  isSelecting = false;
  document.body.style.cursor = '';
  
  if (selectionOverlay) {
    selectionOverlay.remove();
    selectionOverlay = null;
  }
  
  document.removeEventListener('keydown', onKeyDown);
  console.log('[SB] Manual select mode deactivated');
}

function onMouseDown(e) {
  if (e.button !== 0) return;
  
  startX = e.clientX;
  startY = e.clientY;
  currentX = startX;
  currentY = startY;
  
  const selectionBox = document.getElementById('sb-selection-box');
  if (selectionBox) {
    selectionBox.style.display = 'block';
    selectionBox.style.left = startX + 'px';
    selectionBox.style.top = startY + 'px';
    selectionBox.style.width = '0px';
    selectionBox.style.height = '0px';
  }
}

function onMouseMove(e) {
  if (!isSelecting) return;
  
  currentX = e.clientX;
  currentY = e.clientY;
  
  const selectionBox = document.getElementById('sb-selection-box');
  if (selectionBox && selectionBox.style.display === 'block') {
    const left = Math.min(startX, currentX);
    const top = Math.min(startY, currentY);
    const width = Math.abs(currentX - startX);
    const height = Math.abs(currentY - startY);
    
    selectionBox.style.left = left + 'px';
    selectionBox.style.top = top + 'px';
    selectionBox.style.width = width + 'px';
    selectionBox.style.height = height + 'px';
  }
}

async function onMouseUp(e) {
  if (!isSelecting || e.button !== 0) return;
  
  const width = Math.abs(currentX - startX);
  const height = Math.abs(currentY - startY);
  
  if (width < 20 || height < 20) {
    console.log('[SB] Selection too small, try again');
    const selectionBox = document.getElementById('sb-selection-box');
    if (selectionBox) selectionBox.style.display = 'none';
    return;
  }
  
  const rect = {
    left: Math.min(startX, currentX),
    top: Math.min(startY, currentY),
    width: width,
    height: height
  };
  
  console.log('[SB] Processing selected area:', rect);
  
  stopManualSelect();
  
  try {
    await processSelectedArea(rect);
  } catch (e) {
    console.error('[SB] Manual select processing failed:', e);
  }
}

function onKeyDown(e) {
  if (e.key === 'Escape') {
    stopManualSelect();
  }
}

async function processSelectedArea(rect) {
  try {
    console.log('[SB] Capturing selected area...');
    
    const resp = await chrome.runtime.sendMessage({ type: "SB_CAPTURE" });
    if (!resp?.ok || !resp?.dataUrl) {
      throw new Error("Screenshot capture failed");
    }
    
    const screenshot = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = resp.dataUrl;
    });
    
    const dpr = window.devicePixelRatio || 1;
    const sx = Math.floor(rect.left * dpr);
    const sy = Math.floor(rect.top * dpr);
    const sw = Math.floor(rect.width * dpr);
    const sh = Math.floor(rect.height * dpr);
    
    const canvas = document.createElement('canvas');
    canvas.width = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(screenshot, sx, sy, sw, sh, 0, 0, sw, sh);
    
    const croppedDataUrl = canvas.toDataURL('image/jpeg', 0.9);
    console.log('[SB] Cropped area captured, size:', sw + 'x' + sh);
    
    const base = (path) => chrome.runtime.getURL(path);
    const utils = await import(base("lib/utils.js"));
    const settings = await utils.loadSettings();
    
    console.log('[SB] Manual select settings:', { useAiOcr: settings.useAiOcr, translateProvider: settings.translateProvider, targetLanguage: settings.targetLanguage });
    
    let result;
    if (settings.useAiOcr) {
      console.log('[SB] Using AI OCR for selected area...');
      
      const aiocr = await import(base("lib/ai_ocr.js"));
      
      const tempImg = document.createElement('img');
      tempImg.src = croppedDataUrl;
      await new Promise(resolve => {
        tempImg.onload = resolve;
      });
      
      result = await aiocr.aiOcrAndTranslate(tempImg);
    } else {
      console.log('[SB] Using OCR.space for selected area...');
      
      const ocr = await import(base("lib/ocr.js"));
      const translate = await import(base("lib/translate.js"));
      
      const tempImg = document.createElement('img');
      tempImg.src = croppedDataUrl;
      await new Promise(resolve => {
        tempImg.onload = resolve;
      });
      
      try {
        console.log('[SB] Calling OCR on temp image...');
        
        const ocrPromise = ocr.ocrImageFromElement(tempImg);
        const timeoutPromise = new Promise((_, reject) => 
          setTimeout(() => reject(new Error('OCR timeout after 30 seconds')), 30000)
        );
        
        const ocrResult = await Promise.race([ocrPromise, timeoutPromise]);
        console.log('[SB] OCR result received:', { words: ocrResult?.words?.length || 0, text: (ocrResult?.text || '').length });
        
        if (!ocrResult?.words?.length && !(ocrResult?.text || '').trim()) {
          console.log('[SB] No text detected in selected area');
          showNotification('No text detected in selected area');
          return;
        }
        
        const texts = ocrResult.words?.length ? ocrResult.words.map(w => w.text) : [ocrResult.text || ''];
        console.log('[SB] Translating texts:', texts);
        
        const translated = await translate.translateTextArray(texts, settings.targetLanguage || "en");
        console.log('[SB] Translation result:', translated);
        
        result = {
          words: ocrResult.words || [],
          text: ocrResult.text || '',
          translated: translated
        };
      } catch (ocrError) {
        console.error('[SB] OCR failed:', ocrError);
        showNotification('OCR failed: ' + (ocrError?.message || ocrError));
        return;
      }
    }
    
    console.log('[SB] Showing result overlay...');
    showResultOverlay(rect, result, settings);
    console.log('[SB] Manual select processing completed successfully');
    
  } catch (e) {
    console.error('[SB] Manual select processing error:', e);
    showNotification('Processing failed: ' + (e?.message || e));
  }
}

function showResultOverlay(rect, result, settings) {
  console.log('[SB] showResultOverlay called with:', { rect, result });
  
  // Calculate absolute position relative to document
  const scrollX = window.pageXOffset || document.documentElement.scrollLeft;
  const scrollY = window.pageYOffset || document.documentElement.scrollTop;
  
  const tempContainer = document.createElement('div');
  tempContainer.style.cssText = `
    position: absolute;
    left: ${rect.left + scrollX}px;
    top: ${rect.top + scrollY}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    z-index: 2147483647;
    pointer-events: none;
    background: rgba(255, 0, 0, 0.1);
    border: 2px dashed red;
  `;
  document.body.appendChild(tempContainer);
  
  const boxes = [];
  if (result.words && result.translated) {
    // Calculate scaling factors from cropped image to selection rect
    const dpr = window.devicePixelRatio || 1;
    const croppedWidth = rect.width * dpr;
    const croppedHeight = rect.height * dpr;
    
    for (let i = 0; i < Math.min(result.words.length, result.translated.length); i++) {
      const word = result.words[i];
      const translation = result.translated[i];
      if (translation && translation.trim()) {
        // Scale OCR coordinates back to selection rect coordinates
        const scaleX = rect.width / croppedWidth;
        const scaleY = rect.height / croppedHeight;
        
        boxes.push({
          left: word.left * scaleX,
          top: word.top * scaleY,
          width: Math.max(word.width * scaleX, 60), // Minimum width for readability
          height: Math.max(word.height * scaleY, 20), // Minimum height
          text: translation
        });
      }
    }
  } else if (result.words && result.words.length > 0) {
    // AI OCR case - words already contain translated text
    const dpr = window.devicePixelRatio || 1;
    const croppedWidth = rect.width * dpr;
    const croppedHeight = rect.height * dpr;
    
    result.words.forEach(word => {
      if (word.text && word.text.trim()) {
        const scaleX = rect.width / croppedWidth;
        const scaleY = rect.height / croppedHeight;
        
        boxes.push({
          left: word.left * scaleX,
          top: word.top * scaleY,
          width: Math.max(word.width * scaleX, 60),
          height: Math.max(word.height * scaleY, 20),
          text: word.text
        });
      }
    });
  } else if (result.text) {
    // Fallback for single text block
    const text = (typeof result === 'string') ? result : result.text;
    if (text && text.trim()) {
      boxes.push({
        left: rect.width * 0.05,
        top: rect.height * 0.05,
        width: rect.width * 0.9,
        height: rect.height * 0.9,
        text: text
      });
    }
  }
  
  if (boxes.length > 0) {
    console.log('[SB] Creating overlays for boxes:', boxes);
    
    // Add close button to the container
    const closeButton = document.createElement('div');
    closeButton.style.cssText = `
      position: absolute;
      top: -15px;
      right: -15px;
      width: 30px;
      height: 30px;
      background: rgba(255, 0, 0, 0.8);
      color: white;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: Arial, sans-serif;
      font-size: 18px;
      font-weight: bold;
      cursor: pointer;
      z-index: 20;
      pointer-events: auto;
      box-shadow: 0 2px 5px rgba(0,0,0,0.3);
      user-select: none;
    `;
    closeButton.textContent = '×';
    closeButton.title = 'Close translation overlay';
    closeButton.addEventListener('click', () => {
      tempContainer.remove();
    });
    tempContainer.appendChild(closeButton);
    
    // Create individual overlay elements
    boxes.forEach((box, i) => {
      const overlayElement = document.createElement('div');
      overlayElement.style.cssText = `
        position: absolute;
        left: ${box.left}px;
        top: ${box.top}px;
        width: ${box.width}px;
        height: ${box.height}px;
        background: rgba(255, 255, 255, 0.95);
        border: 1px solid #333;
        border-radius: 3px;
        padding: 2px 4px;
        font-family: Arial, 'Helvetica Neue', Helvetica, sans-serif;
        font-size: 12px;
        font-weight: 500;
        color: #000;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        word-wrap: break-word;
        overflow: hidden;
        z-index: 10;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
        line-height: 1.2;
        pointer-events: auto;
        cursor: help;
      `;
      overlayElement.textContent = box.text;
      overlayElement.title = `Original area translation: ${box.text}`;
      tempContainer.appendChild(overlayElement);
    });
    
    tempContainer.classList.add('sb-manual-overlay');
    console.log('[SB] Manual select result displayed');
    
    // Remove the debug styling after overlays are created
    setTimeout(() => {
      tempContainer.style.background = 'transparent';
      tempContainer.style.border = 'none';
      tempContainer.style.pointerEvents = 'none'; // Allow clicking through container but not children
    }, 100);
  } else {
    tempContainer.remove();
    showNotification('No translatable text found');
  }
}

function showNotification(message) {
  const notification = document.createElement('div');
  notification.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: rgba(0, 0, 0, 0.8);
    color: #00ff00;
    padding: 15px 25px;
    border-radius: 8px;
    font-family: monospace;
    font-size: 14px;
    z-index: 2147483648;
    pointer-events: none;
  `;
  notification.textContent = message;
  document.body.appendChild(notification);
  
  setTimeout(() => {
    notification.remove();
  }, 3000);
}

