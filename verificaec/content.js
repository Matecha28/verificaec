// VerificaEC — content.js
// Content script: captura de subtítulos de YouTube en tiempo real

let captionBuffer = '';
let lastSentBuffer = '';
let debounceTimer = null;
let windowTimer = null;
const DEBOUNCE_MS = 1200;
const WINDOW_MS = 8000;

// Observar cambios en el DOM para capturar subtítulos
function observeCaptions() {
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          const captionEl = node.querySelector?.('.ytp-caption-segment') || 
                            (node.classList?.contains('ytp-caption-segment') ? node : null);
          if (captionEl) {
            const text = captionEl.textContent?.trim();
            if (text && text !== captionBuffer) {
              captionBuffer += ' ' + text;
              scheduleFlush();
            }
          }
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
}

function scheduleFlush() {
  // Debounce: enviar si no hay nuevos subtítulos en 1.2s
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(flushBuffer, DEBOUNCE_MS);

  // Ventana: enviar forzosamente cada 8s (para streams en vivo)
  if (!windowTimer) {
    windowTimer = setTimeout(() => {
      windowTimer = null;
      flushBuffer();
    }, WINDOW_MS);
  }
}

function flushBuffer() {
  clearTimeout(debounceTimer);
  clearTimeout(windowTimer);
  windowTimer = null;

  const text = captionBuffer.trim();
  if (text && text !== lastSentBuffer) {
    lastSentBuffer = text;
    captionBuffer = '';
    chrome.runtime.sendMessage({
      type: 'NEW_CAPTION_SEGMENT',
      text,
      timestamp: Date.now(),
      videoTime: getVideoCurrentTime()
    });
  }
}

function getVideoCurrentTime() {
  const video = document.querySelector('video');
  return video ? Math.round(video.currentTime) : 0;
}

// Responder a solicitudes de subtítulos actuales
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'GET_CAPTIONS') {
    sendResponse({
      success: true,
      buffer: captionBuffer,
      lastSent: lastSentBuffer
    });
  }
});

// Iniciar observador
observeCaptions();
