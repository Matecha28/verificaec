// VerificaEC — background.js
// Service worker: ruteo de mensajes, extracción de transcripción, rate limiter global

// Abrir side panel al hacer clic en el ícono
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Rate limiter global — ventana deslizante de 60 segundos
const RATE_LIMIT_RPM = 12; // conservador vs límite de 15 de Gemini
const callTimestamps = [];

function canMakeCall() {
  const now = Date.now();
  // Limpiar timestamps de más de 60 segundos
  while (callTimestamps.length > 0 && now - callTimestamps[0] > 60000) {
    callTimestamps.shift();
  }
  return callTimestamps.length < RATE_LIMIT_RPM;
}

function registerCall() {
  callTimestamps.push(Date.now());
}

function msUntilNextSlot() {
  if (callTimestamps.length < RATE_LIMIT_RPM) return 0;
  const oldest = callTimestamps[callTimestamps.length - RATE_LIMIT_RPM];
  return Math.max(0, 60000 - (Date.now() - oldest));
}

// Ruteo de mensajes principal
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  
  if (message.type === 'GET_TRANSCRIPT') {
    extractYouTubeTranscript(sender.tab?.id || message.tabId)
      .then(result => sendResponse({ success: true, data: result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true; // async
  }

  if (message.type === 'GET_RATE_STATUS') {
    sendResponse({
      canCall: canMakeCall(),
      waitMs: msUntilNextSlot(),
      callsInWindow: callTimestamps.length,
      limit: RATE_LIMIT_RPM
    });
    return false;
  }

  if (message.type === 'REGISTER_API_CALL') {
    registerCall();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'GET_CAPTIONS') {
    // Reenviar a content script en la pestaña activa
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) return sendResponse({ success: false });
      chrome.tabs.sendMessage(tabs[0].id, { type: 'GET_CAPTIONS' }, (response) => {
        sendResponse(response || { success: false });
      });
    });
    return true;
  }
});

// Extracción de transcripción completa de YouTube (modo batch)
async function extractYouTubeTranscript(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        // Intentar obtener transcripción vía API interna de YouTube
        const videoId = new URLSearchParams(window.location.search).get('v');
        if (!videoId) return null;

        // Obtener lista de pistas de transcripción
        const playerResponse = window.ytInitialPlayerResponse;
        if (!playerResponse) return null;

        const captions = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
        if (!captions || captions.length === 0) return null;

        // Preferir español, si no cualquier idioma disponible
        const track = captions.find(t => t.languageCode?.startsWith('es')) || captions[0];
        const url = track.baseUrl + '&fmt=json3';

        const resp = await fetch(url);
        const data = await resp.json();

        // Construir transcripción con timestamps
        const segments = data.events
          ?.filter(e => e.segs)
          .map(e => ({
            start: Math.round(e.tStartMs / 1000),
            text: e.segs.map(s => s.utf8).join('').trim()
          }))
          .filter(e => e.text) || [];

        return {
          videoId,
          title: document.title.replace(' - YouTube', ''),
          url: window.location.href,
          segments,
          fullText: segments.map(s => s.text).join(' ')
        };
      }
    });

    return results[0]?.result || null;
  } catch (err) {
    throw new Error('No se pudo extraer la transcripción: ' + err.message);
  }
}
