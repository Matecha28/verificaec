// ============================================================
// Verificador EC — El Comercio Perú
// Basado en Live Fact Checker por @alandaitch
// Adaptado para verificación periodística peruana
// ============================================================

(() => {
  'use strict';

  // ==========================================================
  // FUENTES PERUANAS PARA VERIFICACIÓN
  // Estas fuentes se inyectan en el prompt de verificación
  // para que Gemini priorice datos oficiales y locales.
  // ==========================================================
  // Compact source list injected in verify prompts (keeps token count low)
  const PERU_SOURCES = `Eres un experto en extracción y verificación de datos periodísticos para Perú. Al buscar, prioriza por este criterio de calidad:

1. FUENTES PRIMARIAS OFICIALES (máxima confiabilidad): repositorios, observatorios y portales del Estado peruano — INEI, BCRP, MEF, MINEDU, MINSA, SUNAT, ONPE, JNE, congreso.gob.pe, gob.pe/presidencia, y cualquier ministerio u organismo público con datos sobre el tema.
2. MEDIOS PERIODÍSTICOS PERUANOS CONFIABLES: agencias (Andina), diarios de referencia (El Comercio, La República), radios (RPP), y periodismo de investigación (Ojo Público, Convoca, Salud con Lupa), entre otros medios serios del ecosistema periodístico peruano.
3. CUENTAS VERIFICADAS EN X: cuentas oficiales de instituciones del Estado, funcionarios públicos verificados y medios de comunicación establecidos.
4. FACT-CHECKERS: Fact Check Explorer (google.com/factcheck) y unidades de verificación de medios peruanos.

Busca activamente — no te limites a estas menciones, usa tu criterio de experto para encontrar la fuente más autorizada sobre el tema específico que estás verificando.`;

  // ==========================================================
  // STATE
  // ==========================================================
  const state = {
    isRunning: false,
    mode: 'youtube',
    tabId: null,
    tabUrl: '',
    transcript: [],
    fullText: '',
    pendingText: '',
    wordCount: 0,
    claims: new Map(),
    claimIdCounter: 0,
    context: { speaker: '', event: '', custom: '', platform: '', title: '', url: '', description: '', date: '' },
    startTime: null,
    clarifications: {},
    pendingClarification: null,
    apiKey: '',
    checkInterval: 10000,
    minWords: 8,
    language: 'es',
    checkTimer: null,
    recognition: null,
    audioStream: null,
    audioContext: null,
    audioTimer: null,
    audioBuffer: [],
    whisperIframe: null,
    whisperReady: false,
    whisperLoading: false,
    whisperRequestId: 0,
    whisperCallbacks: {},
    whisperCurrentModel: '',
    batchMode: false,
  };

  // ==========================================================
  // DOM
  // ==========================================================
  const $ = (s) => document.querySelector(s);
  const dom = {
    statusDot: $('#statusDot'), statusText: $('#statusText'),
    settingsBtn: $('#settingsBtn'), settingsPanel: $('#settingsPanel'),
    apiKeyInput: $('#apiKeyInput'), langSelect: $('#langSelect'), saveSettingsBtn: $('#saveSettingsBtn'),
    contextToggle: $('#contextToggle'), contextFields: $('#contextFields'),
    contextBadge: $('#contextBadge'),
    ctxSpeaker: $('#ctxSpeaker'), ctxEvent: $('#ctxEvent'), ctxCustom: $('#ctxCustom'),
    startBtn: $('#startBtn'), stopBtn: $('#stopBtn'), clearBtn: $('#clearBtn'), exportBtn: $('#exportBtn'),
    progressWrap: $('#progressWrap'), progressFill: $('#progressFill'), progressLabel: $('#progressLabel'),
    statsBar: $('#statsBar'),
    statWords: $('#statWords'), statClaims: $('#statClaims'),
    statTrue: $('#statTrue'), statFalse: $('#statFalse'), statUncertain: $('#statUncertain'),
    clarBanner: $('#clarificationBanner'), clarQuestion: $('#clarificationQuestion'),
    clarInput: $('#clarificationInput'), clarSubmit: $('#submitClarification'),
    clarDismiss: $('#dismissClarification'),
    analyzeNowBtn: $('#analyzeNowBtn'),
    transcriptWrap: $('#transcriptContainer'), transcript: $('#transcript'),
    modal: $('#claimModal'), modalVerdict: $('#modalVerdict'), modalClaim: $('#modalClaim'),
    modalExplanation: $('#modalExplanation'), modalSources: $('#modalSources'),
    modalConfidence: $('#modalConfidence'), closeModal: $('#closeModal'),
  };

  // ==========================================================
  // STATUS
  // ==========================================================
  function setStatus(msg, type = '') {
    dom.statusText.textContent = msg;
    dom.statusDot.className = 'status-dot' + (type ? ' ' + type : '');
  }

  // ==========================================================
  // SETTINGS
  // ==========================================================
  async function loadSettings() {
    return new Promise(r => {
      chrome.storage.local.get(['apiKey','checkInterval','mode','language','clarifications'], d => {
        if (d.apiKey)         state.apiKey = d.apiKey;
        if (d.checkInterval)  state.checkInterval = d.checkInterval;
        if (d.mode)           state.mode = d.mode;
        if (d.language)       state.language = d.language || 'es';
        if (d.clarifications) state.clarifications = d.clarifications;
        dom.apiKeyInput.value = state.apiKey;
        dom.langSelect.value = state.language;
        const intRadio = document.querySelector(`input[name="interval"][value="${state.checkInterval}"]`);
        if (intRadio) intRadio.checked = true;
        const modeRadio = document.querySelector(`input[name="mode"][value="${state.mode}"]`);
        if (modeRadio) modeRadio.checked = true;
        r();
      });
    });
  }

  function saveSettings() {
    state.apiKey = dom.apiKeyInput.value.trim() || state.apiKey;
    state.checkInterval = +(document.querySelector('input[name="interval"]:checked')?.value || 10000);
    state.mode = document.querySelector('input[name="mode"]:checked')?.value || 'youtube';
    state.language = dom.langSelect.value || 'es';
    chrome.storage.local.set({ apiKey: state.apiKey, checkInterval: state.checkInterval, mode: state.mode, language: state.language, clarifications: state.clarifications });
  }

  function getEffectiveLanguage() {
    return state.language || 'es';
  }

  // ==========================================================
  // UI SETUP
  // ==========================================================
  function setupUI() {
    dom.settingsBtn.onclick = () => dom.settingsPanel.classList.toggle('hidden');
    dom.saveSettingsBtn.onclick = () => {
      saveSettings();
      dom.settingsPanel.classList.add('hidden');
      setStatus('Configuración guardada');
    };
    dom.contextToggle.onclick = () => {
      dom.contextFields.classList.toggle('hidden');
      dom.contextToggle.classList.toggle('open');
    };
    dom.startBtn.onclick = startFactChecking;
    dom.stopBtn.onclick = stopFactChecking;
    dom.clearBtn.onclick = clearTranscript;
    dom.exportBtn.onclick = exportReport;
    dom.analyzeNowBtn.onclick = analyzeNow;
    dom.clarSubmit.onclick = submitClarification;
    dom.clarInput.onkeydown = e => { if (e.key === 'Enter') submitClarification(); };
    dom.clarDismiss.onclick = () => { dom.clarBanner.classList.add('hidden'); state.pendingClarification = null; };
    dom.closeModal.onclick = closeModal;
    dom.modal.querySelector('.modal-backdrop').onclick = closeModal;
    dom.transcript.onclick = e => { const m = e.target.closest('.claim-mark'); if (m) openClaimDetail(m.dataset.claimId); };

    dom.transcript.addEventListener('mouseover', e => {
      const mark = e.target.closest('.claim-mark');
      if (!mark) { hideClaimTooltip(); return; }
      const claim = state.claims.get(mark.dataset.claimId);
      if (claim) showClaimTooltip(mark, claim);
    });
    dom.transcript.addEventListener('mouseout', e => {
      const related = e.relatedTarget;
      if (!related || !related.closest || !related.closest('.claim-mark')) hideClaimTooltip();
    });
  }

  // ==========================================================
  // TAB & CONTEXT
  // ==========================================================
  async function fetchActiveTab() {
    return new Promise(r => {
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, resp => {
        if (resp?.tab) {
          state.tabId = resp.tab.id;
          state.tabUrl = resp.tab.url || '';
          const isYT = state.tabUrl.includes('youtube.com');
          if (!isYT && state.mode === 'youtube') {
            state.mode = 'tab_audio';
            const radio = document.querySelector('input[name="mode"][value="tab_audio"]');
            if (radio) radio.checked = true;
          }
        }
        r();
      });
    });
  }

  async function fetchPageContext() {
    if (!state.tabId) return;
    return new Promise(r => {
      chrome.runtime.sendMessage({ type: 'GET_PAGE_CONTEXT', tabId: state.tabId }, resp => {
        if (resp?.context) {
          const c = resp.context;
          state.context.platform = c.platform || '';
          state.context.title = c.title || '';
          state.context.url = c.url || '';
          state.context.description = c.description || '';
          state.context.date = c.date || '';
          if (c.channel && !dom.ctxSpeaker.value) { dom.ctxSpeaker.value = c.channel; state.context.speaker = c.channel; }
          if (c.title && !dom.ctxEvent.value) { dom.ctxEvent.value = c.title; state.context.event = c.title; }
        }
        r();
      });
    });
  }

  function getContextString() {
    const sp = dom.ctxSpeaker.value.trim() || state.context.speaker;
    const ev = dom.ctxEvent.value.trim() || state.context.event;
    const cu = dom.ctxCustom.value.trim() || state.context.custom;
    const parts = [];
    if (sp) parts.push(`Orador/Canal: ${sp}`);
    if (ev) parts.push(`Evento/Tema: ${ev}`);
    if (state.context.date) parts.push(`Fecha del video: ${state.context.date}`);
    if (cu) parts.push(`Contexto adicional: ${cu}`);
    return parts.length ? parts.join(' | ') : 'Sin contexto específico';
  }

  // ==========================================================
  // INIT
  // ==========================================================
  async function init() {
    await loadSettings();
    setupUI();
    setupMessageListener();
    await fetchActiveTab();
    await fetchPageContext();
    setStatus('Listo — elige un modo y presiona Iniciar');
  }

  // ==========================================================
  // STATS
  // ==========================================================
  function updateStats() {
    dom.statWords.textContent = state.wordCount.toLocaleString();
    dom.statClaims.textContent = state.claims.size;
    let trueC = 0, falseC = 0, engC = 0, sdC = 0;
    for (const c of state.claims.values()) {
      if (c.verdict === 'VERDADERO') trueC++;
      else if (c.verdict === 'FALSO') falseC++;
      else if (c.verdict === 'ENGANOSO') engC++;
      else if (c.verdict === 'SIN_DATOS') sdC++;
    }
    dom.statTrue.textContent = trueC;
    dom.statFalse.textContent = falseC;
    dom.statUncertain.textContent = engC + sdC;
  }

  // ==========================================================
  // CLEAR
  // ==========================================================
  function clearTranscript() {
    state.transcript = [];
    state.fullText = '';
    state.pendingText = '';
    state.wordCount = 0;
    state.claims.clear();
    state.claimIdCounter = 0;
    dom.transcript.innerHTML = '<p class="placeholder-text">La transcripción aparecerá aquí al iniciar la verificación...</p>';
    dom.statsBar.classList.add('hidden');
    updateStats();
  }

  // ==========================================================
  // START / STOP
  // ==========================================================
  async function startFactChecking() {
    if (!state.apiKey) {
      dom.settingsPanel.classList.remove('hidden');
      dom.apiKeyInput.focus();
      setStatus('⚠ Ingresa tu clave API de Gemini primero', 'error');
      return;
    }
    state.isRunning = true;
    state.startTime = Date.now();
    dom.startBtn.classList.add('hidden');
    dom.stopBtn.classList.remove('hidden');
    dom.statsBar.classList.remove('hidden');

    if (state.mode === 'youtube') await startYouTubeMode();
    else if (state.mode === 'tab_audio') await startTabAudioMode();
    else startMicMode();

    scheduleNextClaimCheck();
  }

  function getAdaptiveInterval() {
    let interval = state.checkInterval;
    const avail = availableRequests(false);
    if (avail < 4) interval = Math.max(interval, 15000);
    if (avail < 2) interval = Math.max(interval, 30000);
    if (avail < 1) interval = Math.max(interval, msUntilNextSlot() + 2000);
    return Math.min(interval, 120000);
  }

  function scheduleNextClaimCheck() {
    if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
    if (!state.isRunning) return;
    const interval = getAdaptiveInterval();
    state.checkTimer = setTimeout(async () => {
      await runClaimCheck();
      scheduleNextClaimCheck();
    }, interval);
  }

  function stopFactChecking() {
    state.isRunning = false;
    dom.startBtn.classList.remove('hidden');
    dom.stopBtn.classList.add('hidden');
    setStatus('Detenido');
    if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
    if (!state.batchMode) {
      if (state.mode === 'youtube') stopYouTubeMode();
      else if (state.mode === 'tab_audio') stopTabAudioMode();
      else stopMicMode();
    }
    state.batchMode = false;
    dom.progressWrap.classList.add('hidden');
  }

  // ==========================================================
  // ANALYZE NOW (batch)
  // ==========================================================
  async function analyzeNow() {
    setStatus('Obteniendo transcripción completa...', 'checking');
    dom.progressWrap.classList.remove('hidden');
    dom.progressFill.style.width = '0%';
    dom.progressLabel.textContent = '0%';

    const lang = getEffectiveLanguage();
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          { type: 'GET_FULL_TRANSCRIPT', tabId: state.tabId, language: lang },
          resp => {
            if (chrome.runtime.lastError) reject(chrome.runtime.lastError.message);
            else resolve(resp);
          }
        );
      });
    } catch (err) {
      setStatus('No se pudo obtener la transcripción', 'error');
      dom.progressWrap.classList.add('hidden');
      return;
    }

    if (!result?.success || !result?.segments?.length) {
      setStatus(result?.error || 'No hay transcripción disponible para este video', 'error');
      dom.progressWrap.classList.add('hidden');
      return;
    }

    if (state.isRunning) {
      state.isRunning = false;
      if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
      if (state.mode === 'youtube') stopYouTubeMode();
      else if (state.mode === 'tab_audio') stopTabAudioMode();
      else stopMicMode();
    }

    clearTranscript();
    state.batchMode = true;
    state.isRunning = true;
    state.startTime = Date.now();
    dom.startBtn.classList.add('hidden');
    dom.stopBtn.classList.remove('hidden');
    dom.statsBar.classList.remove('hidden');

    const merged = [];
    let buf = '', bufStart = 0;
    for (const seg of result.segments) {
      if (!buf) { bufStart = seg.startMs; buf = seg.text; }
      else if (seg.startMs - bufStart < 20000) { buf += ' ' + seg.text; }
      else { merged.push({ text: buf.trim(), startMs: bufStart }); bufStart = seg.startMs; buf = seg.text; }
    }
    if (buf) merged.push({ text: buf.trim(), startMs: bufStart });

    let fullText = '';
    for (const seg of merged) {
      const entry = { id: 't-' + seg.startMs + '-' + Math.random().toString(36).slice(2,6), text: seg.text, timestamp: seg.startMs };
      state.transcript.push(entry);
      fullText += (fullText ? ' ' : '') + seg.text;
      state.wordCount += seg.text.split(/\s+/).filter(Boolean).length;
      renderTranscriptEntry(entry, true);
    }
    state.fullText = fullText;
    updateStats();

    const CHUNK_WORDS = 150;
    const words = fullText.split(/\s+/).filter(Boolean);
    const totalChunks = Math.ceil(words.length / CHUNK_WORDS);

    for (let i = 0; i < totalChunks; i++) {
      if (!state.isRunning) break;
      const chunkText = words.slice(i * CHUNK_WORDS, (i + 1) * CHUNK_WORDS).join(' ');
      const pct = Math.round(((i + 1) / totalChunks) * 40);
      dom.progressFill.style.width = pct + '%';
      dom.progressLabel.textContent = pct + '%';
      setStatus(`Identificando afirmaciones... (${i+1}/${totalChunks})`, 'checking');
      try {
        const claims = await identifyClaims(chunkText);
        if (claims?.length) {
          for (const cl of claims) {
            const id = 'c-' + (++state.claimIdCounter);
            const obj = { id, text: cl.claim || cl.text || '', summary: cl.summary || cl.claim || '', searchQuery: cl.searchQuery || '', status: 'pending', verdict: null, explanation: '', sources: [], confidence: 0, needsClarification: false, clarificationQuestion: null };
            state.claims.set(id, obj);
            highlightClaimInTranscript(obj);
            updateStats();
          }
        }
      } catch (err) {
        if (err.message.startsWith('RATE_LIMITED')) {
          const waitMs = parseInt(err.message.split(':')[1]) || 30000;
          setStatus('Límite de API — reintentando...', 'checking');
          await sleep(waitMs);
          i--;
          continue;
        }
        console.error('Batch identification error:', err);
      }
    }

    const claimsToVerify = [...state.claims.values()].filter(c => c.status === 'pending');
    const totalClaims = claimsToVerify.length;
    let verified = 0;

    for (let i = 0; i < claimsToVerify.length; i++) {
      if (!state.isRunning) break;
      const claim = claimsToVerify[i];
      const pct = 40 + Math.round(((verified + 1) / totalClaims) * 60);
      dom.progressFill.style.width = Math.min(pct, 99) + '%';
      dom.progressLabel.textContent = Math.min(pct, 99) + '%';
      setStatus(`Verificando afirmaciones... (${verified+1}/${totalClaims})`, 'checking');
      await verifyClaim(claim);
      if (claim.status === 'verified') { verified++; }
      else {
        claimsToVerify.push(claim);
        if (claimsToVerify.length > totalClaims * 3) break;
      }
    }

    dom.progressFill.style.width = '100%';
    dom.progressLabel.textContent = '100%';
    setStatus(`Análisis completo — ${verified} afirmaciones verificadas`, 'live');
    setTimeout(() => {
      if (!state.isRunning) return;
      dom.progressWrap.classList.add('hidden');
      state.isRunning = false;
      dom.startBtn.classList.remove('hidden');
      dom.stopBtn.classList.add('hidden');
    }, 2000);
    state.batchMode = false;
  }

  // ==========================================================
  // MODE 1: YOUTUBE CAPTIONS
  // ==========================================================
  async function startYouTubeMode() {
    setStatus('Conectando a YouTube...', 'checking');
    return new Promise(r => {
      chrome.runtime.sendMessage({ type: 'START_CAPTIONS', tabId: state.tabId }, resp => {
        if (resp?.success) setStatus('Escuchando subtítulos de YouTube', 'live');
        else setStatus('Sin subtítulos detectados. Activa CC.', 'error');
        r();
      });
    });
  }

  function stopYouTubeMode() {
    chrome.runtime.sendMessage({ type: 'STOP_CAPTIONS', tabId: state.tabId }, () => {});
  }

  // ==========================================================
  // MODE 2: TAB AUDIO (Whisper)
  // ==========================================================
  async function startTabAudioMode() {
    if (!state.whisperIframe) initWhisperSandbox();
    setStatus('Descargando modelo Whisper...', 'checking');

    await new Promise(r => {
      const check = () => { if (state.whisperReady || state.whisperLoading) r(); else setTimeout(check, 200); };
      check();
    });

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'GET_TAB_CAPTURE_STREAM', tabId: state.tabId }, async resp => {
        if (!resp?.streamId) { setStatus('No se pudo capturar el audio del tab', 'error'); reject(); return; }
        try {
          const stream = await navigator.mediaDevices.getUserMedia({ audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: resp.streamId } } });
          state.audioStream = stream;
          state.audioContext = new AudioContext({ sampleRate: 16000 });
          const src = state.audioContext.createMediaStreamSource(stream);
          const processor = state.audioContext.createScriptProcessor(16384, 1, 1);
          src.connect(processor);
          processor.connect(state.audioContext.destination);
          processor.onaudioprocess = (e) => {
            if (!state.isRunning) return;
            state.audioBuffer.push(...e.inputBuffer.getChannelData(0));
          };
          state.audioTimer = setInterval(() => processAudioBuffer(), 5000);
          setStatus('Modelo Whisper cargado — capturando audio...', 'live');
          resolve();
        } catch (err) {
          setStatus('Error capturando audio: ' + err.message, 'error');
          reject(err);
        }
      });
    });
  }

  function initWhisperSandbox() {
    state.whisperIframe = document.createElement('iframe');
    state.whisperIframe.src = chrome.runtime.getURL('whisper-sandbox.html');
    state.whisperIframe.style.display = 'none';
    state.whisperIframe.sandbox = 'allow-scripts';
    document.body.appendChild(state.whisperIframe);

    const lang = getEffectiveLanguage();
    const isEnglish = lang === 'en';
    const model = isEnglish ? 'Xenova/whisper-tiny.en' : 'Xenova/whisper-tiny';

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'SANDBOX_ALIVE') {
        state.whisperIframe.contentWindow.postMessage({ type: 'INIT_WHISPER', model, language: lang }, '*');
        state.whisperLoading = true;
      } else if (msg.type === 'WHISPER_STATUS') {
        if (msg.status === 'ready') { state.whisperReady = true; state.whisperLoading = false; state.whisperCurrentModel = model; }
        else if (msg.status === 'loading' || msg.status === 'downloading') { setStatus(msg.message, 'checking'); }
        else if (msg.status === 'error') { setStatus('Error Whisper: ' + msg.message, 'error'); state.whisperLoading = false; }
      } else if (msg.type === 'WHISPER_RESULT') {
        const cb = state.whisperCallbacks[msg.requestId];
        if (cb) { delete state.whisperCallbacks[msg.requestId]; cb(msg.text || '', msg.error); }
      }
    });
  }

  async function processAudioBuffer() {
    if (state.audioBuffer.length < 16000 || !state.whisperReady) return;
    const audio = new Float32Array(state.audioBuffer.splice(0));
    const requestId = ++state.whisperRequestId;
    const text = await new Promise((resolve) => {
      state.whisperCallbacks[requestId] = (t, err) => resolve(err ? '' : t);
      state.whisperIframe.contentWindow.postMessage({ type: 'TRANSCRIBE', audio, requestId, language: getEffectiveLanguage() }, '*', [audio.buffer]);
    });
    if (text && text.trim().length > 2) handleTranscriptText(text.trim());
  }

  function stopTabAudioMode() {
    if (state.audioTimer) { clearInterval(state.audioTimer); state.audioTimer = null; }
    if (state.audioStream) { state.audioStream.getTracks().forEach(t => t.stop()); state.audioStream = null; }
    if (state.audioContext) { try { state.audioContext.close(); } catch {} state.audioContext = null; }
    state.audioBuffer = [];
  }

  // ==========================================================
  // MODE 3: MICROPHONE
  // ==========================================================
  function startMicMode() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      setStatus('Reconocimiento de voz no soportado', 'error');
      return;
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    state.recognition = new SR();
    state.recognition.continuous = true;
    state.recognition.interimResults = true;
    const lang = getEffectiveLanguage();
    const langRegion = { en:'en-US', es:'es-PE', pt:'pt-BR', fr:'fr-FR', de:'de-DE' };
    state.recognition.lang = langRegion[lang] || 'es-PE';

    let lastFinal = '';
    state.recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (event.results[i].isFinal) {
          const text = event.results[i][0].transcript.trim();
          if (text && text !== lastFinal) { lastFinal = text; handleTranscriptText(text); }
        }
      }
    };
    state.recognition.onerror = (e) => {
      if (e.error === 'no-speech') return;
      if (e.error === 'not-allowed') setStatus('Acceso al micrófono denegado', 'error');
    };
    state.recognition.onend = () => {
      if (state.isRunning && state.mode === 'mic') { try { state.recognition.start(); } catch {} }
    };
    try { state.recognition.start(); setStatus('Escuchando micrófono...', 'live'); }
    catch { setStatus('No se pudo iniciar el micrófono', 'error'); }
  }

  function stopMicMode() {
    if (state.recognition) { state.recognition.onend = null; try { state.recognition.stop(); } catch {} state.recognition = null; }
  }

  // ==========================================================
  // TRANSCRIPT HANDLING
  // ==========================================================
  const recentTexts = [];
  const MAX_RECENT = 15;

  function handleTranscriptText(text) {
    if (!text || !state.isRunning) return;
    const norm = text.toLowerCase().replace(/\s+/g, ' ').trim();
    if (norm.length < 2) return;
    for (const prev of recentTexts) {
      if (prev === norm) return;
      if (prev.includes(norm)) return;
    }
    recentTexts.push(norm);
    if (recentTexts.length > MAX_RECENT) recentTexts.shift();

    const entry = { id: 't-' + Date.now() + '-' + Math.random().toString(36).slice(2,6), text, timestamp: Date.now() };
    state.transcript.push(entry);
    state.fullText += (state.fullText ? ' ' : '') + text;
    state.pendingText += (state.pendingText ? ' ' : '') + text;
    state.wordCount += text.split(/\s+/).filter(Boolean).length;
    renderTranscriptEntry(entry);
    updateStats();
    autoScroll();

    // FIX: trigger claim check proactively when enough text accumulates
    // instead of waiting blindly for the periodic timer
    const pendingWords = state.pendingText.trim().split(/\s+/).filter(Boolean).length;
    if (pendingWords >= state.minWords && availableRequests(false) >= 1) {
      if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
      setTimeout(async () => {
        await runClaimCheck();
        scheduleNextClaimCheck();
      }, 500); // small buffer so consecutive captions can arrive together
    }
  }

  function renderTranscriptEntry(entry, useVideoTime) {
    const ph = dom.transcript.querySelector('.placeholder-text');
    if (ph) ph.remove();
    const block = document.createElement('span');
    block.className = 'transcript-block';
    block.dataset.entryId = entry.id;
    const timeStr = useVideoTime
      ? formatVideoTime(entry.timestamp)
      : new Date(entry.timestamp).toLocaleTimeString('es-PE', { hour:'2-digit', minute:'2-digit', second:'2-digit' });
    block.innerHTML = `<span class="transcript-time">${timeStr}</span>${escapeHtml(entry.text)} `;
    dom.transcript.appendChild(block);
  }

  function autoScroll() {
    const el = dom.transcriptWrap;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 80) el.scrollTop = el.scrollHeight;
  }

  // ==========================================================
  // MESSAGE LISTENER
  // ==========================================================
  function setupMessageListener() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg.type === 'CAPTION_UPDATE') handleTranscriptText(msg.text);
      else if (msg.type === 'CONTEXT_UPDATE' && msg.context) {
        if (msg.context.channel && !dom.ctxSpeaker.value) { dom.ctxSpeaker.value = msg.context.channel; }
        if (msg.context.title && !dom.ctxEvent.value) { dom.ctxEvent.value = msg.context.title; }
      } else if (msg.type === 'CONTENT_STATUS') {
        setStatus(msg.message, 'checking');
      }
    });
  }

  // ==========================================================
  // GEMINI API — rate limiter
  // ==========================================================
  const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
  const RPM_LIMIT = 10; // Gemini free tier: 15 RPM, use 10 to be safe
  const RPD_LIMIT = 1400;
  const requestLog = [];
  let dailyRequestCount = 0;
  let dailyResetTime = Date.now() + 86400000;
  let serverBackoffUntil = 0;
  let pendingVerifications = [];
  let isProcessingQueue = false;

  // Separate counters for grounded (Google Search) calls — same model but
  // grounded search uses a shared quota; be conservative to avoid 429s
  const groundedLog = [];
  const GROUNDED_RPM = 8; // stay well under the grounded search quota

  function availableRequests(grounded = false) {
    const now = Date.now();
    while (requestLog.length && requestLog[0] < now - 60000) requestLog.shift();
    if (now > dailyResetTime) { dailyRequestCount = 0; dailyResetTime = now + 86400000; }
    const base = Math.max(0, Math.min(RPM_LIMIT - requestLog.length, RPD_LIMIT - dailyRequestCount));
    if (!grounded) return base;
    while (groundedLog.length && groundedLog[0] < now - 60000) groundedLog.shift();
    return Math.min(base, Math.max(0, GROUNDED_RPM - groundedLog.length));
  }

  function msUntilNextSlot(grounded = false) {
    const now = Date.now();
    if (serverBackoffUntil > now) return serverBackoffUntil - now;
    if (availableRequests(grounded) > 0) return 0;
    if (grounded && groundedLog.length >= GROUNDED_RPM) return groundedLog[0] + 60000 - now + 200;
    if (requestLog.length >= RPM_LIMIT) return requestLog[0] + 60000 - now + 200;
    return 1000;
  }

  async function acquireSlot(grounded = false) {
    let wait = msUntilNextSlot(grounded);
    if (wait > 65000) wait = 65000; // cap at 65s; reset backoff if stale
    while (wait > 0) {
      const secs = Math.round(wait / 1000);
      setStatus(`Límite de API — reintentando en ${secs}s...`, 'checking');
      await sleep(Math.min(wait, 1000)); // wake every second to update countdown
      if (!state.isRunning && !state.batchMode) throw new Error('STOPPED');
      wait = msUntilNextSlot(grounded);
    }
    requestLog.push(Date.now());
    if (grounded) groundedLog.push(Date.now());
    dailyRequestCount++;
  }

  async function callGemini(prompt, { grounded = false, temperature = 0.1, maxTokens = 1024, jsonMode = false, jsonSchema = null } = {}) {
    await acquireSlot(grounded);
    const model = 'gemini-2.5-flash';
    const url = `${GEMINI}/${model}:generateContent?key=${state.apiKey}`;
    const genConfig = { temperature, maxOutputTokens: maxTokens };
    if (jsonMode && !grounded) {
      genConfig.responseMimeType = 'application/json';
      if (jsonSchema) genConfig.responseSchema = jsonSchema;
    }
    const body = { contents: [{ parts: [{ text: prompt }] }], generationConfig: genConfig };
    if (grounded) body.tools = [{ googleSearch: {} }];

    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    if (r.status === 429) {
      let waitMs = 30000;
      try {
        const errBody = await r.json();
        const retryInfo = errBody.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
        if (retryInfo?.retryDelay) {
          const s = retryInfo.retryDelay.match(/([\d.]+)s/);
          if (s) waitMs = Math.ceil(parseFloat(s[1]) * 1000) + 1000;
        }
      } catch {}
      serverBackoffUntil = Date.now() + waitMs;
      throw new Error(`RATE_LIMITED:${waitMs}`);
    }

    if (!r.ok) {
      const errText = await r.text();
      throw new Error(`Gemini ${r.status}: ${errText.substring(0, 200)}`);
    }

    const d = await r.json();
    if (!d.candidates?.length) throw new Error('Sin candidatos en respuesta');
    const c = d.candidates[0];
    const text = c.content?.parts?.[0]?.text || '';
    let sources = [];
    if (c.groundingMetadata?.groundingChunks)
      sources = c.groundingMetadata.groundingChunks.filter(x=>x.web).map(x=>({ url: x.web.uri, title: x.web.title || x.web.uri }));
    return { text, sources };
  }

  function parseJSON(text) {
    if (!text) return null;
    let cleaned = text.replace(/```(?:json)?\s*/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch {}
    for (const startChar of ['{', '[']) {
      const endChar = startChar === '{' ? '}' : ']';
      const firstStart = cleaned.indexOf(startChar);
      const lastEnd = cleaned.lastIndexOf(endChar);
      if (firstStart !== -1 && lastEnd > firstStart) {
        try { return JSON.parse(cleaned.substring(firstStart, lastEnd + 1)); } catch {}
      }
    }
    return null;
  }


  function normalizeVerdict(v) {
    if (!v) return 'SIN_DATOS';
    const u = v.toUpperCase().replace(/[^A-Z_]/g, '');
    if (u === 'VERDADERO' || u === 'TRUE') return 'VERDADERO';
    if (u === 'FALSO' || u === 'FALSE') return 'FALSO';
    if (u.startsWith('ENGAN') || u === 'MISLEADING' || u === 'UNCERTAIN') return 'ENGANOSO';
    if (u === 'SIN_DATOS' || u === 'SINDATOS' || u === 'NODATA') return 'SIN_DATOS';
    return 'SIN_DATOS';
  }

  function extractVerdictFromProse(text) {
    if (!text || text.length < 5) return null;
    const upper = text.toUpperCase();
    let verdict = 'SIN_DATOS';

    const verdictPatterns = [
      { re: /\bveredicto\s*[:=]\s*"?(TRUE|FALSE|UNCERTAIN|VERDADERO|FALSO|INCIERTO)"?/i, group: 1 },
      { re: /\bverdict\s*[:=]\s*"?(TRUE|FALSE|UNCERTAIN|VERDADERO|FALSO|INCIERTO)"?/i, group: 1 },
      { re: /\bla\s+afirmaci[oó]n\s+es\s+(VERDADERA|FALSA|INCIERTA|TRUE|FALSE|UNCERTAIN)\b/i, group: 1 },
      { re: /\bclaim\s+is\s+(TRUE|FALSE|UNCERTAIN)\b/i, group: 1 },
    ];
    for (const { re, group } of verdictPatterns) {
      const m = text.match(re);
      if (m) {
        const raw = m[group].toUpperCase();
        verdict = normalizeVerdict(raw);
        break;
      }
    }

    if (verdict === 'SIN_DATOS') {
      if (/\b(es falso|es incorrecta|no es cierto|dato incorrecto|contradice)\b/i.test(text)) verdict = 'FALSO';
      else if (/\b(es verdadero|es correcto|confirmado|dato correcto|coincide)\b/i.test(text)) verdict = 'VERDADERO';
      else if (/\b(parcialmente|engañoso|incompleto|induce|contexto faltante)\b/i.test(text)) verdict = 'ENGANOSO';
    }

    const conf = text.match(/(?:confidence|confianza|confidence_score)\s*[:=]\s*(0\.\d+|\d+%)/i);
    let confidence = 0.5;
    if (conf) {
      const raw = conf[1];
      confidence = raw.includes('%') ? parseInt(raw) / 100 : parseFloat(raw);
    }

    const explMatch = text.match(/(?:explanation|explicaci[oó]n)\s*[:=]\s*"?([^"{\n]+)/i);
    const explanation = explMatch ? explMatch[1].trim() : text.substring(0, 300).trim();

    return { verdict, confidence, explanation, needsClarification: false, clarificationQuestion: null };
  }

  // ==========================================================
  // CLAIM CHECK LOOP
  // ==========================================================
  async function runClaimCheck(force = false) {
    if (!state.isRunning && !force) return;
    const text = state.pendingText.trim();
    const wordCount = text.split(/\s+/).filter(Boolean).length;
    if (wordCount < (force ? 5 : state.minWords)) return;
    if (!force && availableRequests(false) < 1) {
      const wait = msUntilNextSlot();
      setStatus(`Buffering transcripción — verificando en ${Math.round(wait/1000)}s...`, 'checking');
      // FIX: schedule a retry so pendingText gets processed after backoff clears
      if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
      state.checkTimer = setTimeout(async () => {
        await runClaimCheck(force);
        scheduleNextClaimCheck();
      }, Math.min(wait + 1000, 70000));
      return;
    }

    state.pendingText = '';
    const prevStatus = dom.statusText.textContent;
    setStatus('Analizando afirmaciones...', 'checking');

    try {
      const claims = await identifyClaims(text);
      if (claims?.length) {
        for (const cl of claims) {
          const id = 'c-' + (++state.claimIdCounter);
          const obj = { id, text: cl.claim||cl.text||'', summary: cl.summary||cl.claim||'', searchQuery: cl.searchQuery||'', status: 'pending', verdict: null, explanation: '', sources: [], confidence: 0, needsClarification: false, clarificationQuestion: null };
          state.claims.set(id, obj);
          highlightClaimInTranscript(obj);
          updateStats();
          queueVerification(obj);
        }
      }
      setStatus(state.isRunning ? prevStatus : 'Detenido', state.isRunning ? 'live' : '');
    } catch (err) {
      if (err.message === 'STOPPED') { return; } // user stopped, discard
      if (err.message.startsWith('RATE_LIMITED')) {
        setStatus('Límite de API — reintentará automáticamente', 'checking');
        // Preserve pendingText AND schedule retry
        state.pendingText = text + ' ' + state.pendingText;
        const waitMs = parseInt(err.message.split(':')[1]) || 30000;
        if (state.checkTimer) { clearTimeout(state.checkTimer); state.checkTimer = null; }
        state.checkTimer = setTimeout(async () => {
          await runClaimCheck();
          scheduleNextClaimCheck();
        }, waitMs + 1000);
      } else {
        setStatus('Error API: ' + err.message.substring(0, 80), 'error');
        state.pendingText = text + ' ' + state.pendingText;
      }
    }
  }

  function queueVerification(claim) {
    pendingVerifications.push(claim);
    if (!isProcessingQueue) processVerificationQueue();
  }

  async function processVerificationQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (pendingVerifications.length > 0) {
      const claim = pendingVerifications.shift();
      await verifyClaim(claim);
    }
    isProcessingQueue = false;
  }

  // ==========================================================
  // IDENTIFY CLAIMS — con contexto peruano
  // ==========================================================
  async function identifyClaims(text) {
    const lang = getEffectiveLanguage();
    const langName = lang === 'es' ? 'español' : 'inglés';
    const prompt = `Eres un extractor de afirmaciones verificables para El Comercio Perú, usando los criterios de OjoBiónico. Tu tarea es ser EXHAUSTIVO — es mejor extraer de más que de menos.

CONTEXTO: ${getContextString()}

TEXTO:
"""
${text}
"""

UNA FRASE ES VERIFICABLE si cumple AL MENOS UNO de estos criterios (aplica a CUALQUIER TEMA: política, salud, economía, educación, violencia, género, ciencia, cultura, deporte, medio ambiente, etc.):

A) CIFRA — contiene cualquier número, porcentaje, monto, fecha, cantidad, tasa, ranking, estadística, índice. Ejemplos: "6641 votos", "el 30% de peruanos", "desde 1943", "4 décadas", "S/. 2,000 millones", "puesto 87 en el mundo".

B) ACUSACIÓN — atribuye una acción negativa, irregular o polémica a una persona o institución. Ejemplos: "el ministro ordenó", "la empresa ocultó", "el congresista recibió".

C) LUGAR COMÚN CUESTIONABLE — usa superlativo o absoluto que podría ser falso. Ejemplos: "el peor", "el primero", "nunca antes", "siempre ha sido así", "histórico", "sin precedentes", "el más alto".

D) RIGOR SIN FUENTE — afirma algo como hecho comprobado sin citar de dónde viene. Ejemplos: "estudios muestran que", "se sabe que", "expertos señalan", "la evidencia indica", "datos revelan", "la ciencia dice".

E) COMPARACIÓN — compara dos o más cifras, períodos, países, personas o situaciones. Ejemplos: "más que el año pasado", "el doble que Chile", "mejor que en el gobierno anterior".

F) HECHO CONCRETO ATRIBUIBLE — afirma algo específico que puede confirmarse o refutarse con una fuente. Ejemplos: "fue elegido con X votos", "integra la bancada Y", "nació el día Z", "tiene estudios de posgrado", "la ley aprobada dice", "el hospital cerró".

EXCLUYE únicamente: opiniones puras sin dato ("creo que es injusto"), predicciones ("será el mejor"), saludos y transiciones narrativas.

Extrae hasta 5 afirmaciones. Si hay más de 5 elegibles, prioriza las que tengan CIFRAS CONCRETAS (criterio A).
Si genuinamente no hay nada verificable, retorna [].

JSON array:
[{"claim":"fragmento textual exacto del texto original","summary":"afirmación testeable y precisa en ${langName}","searchQuery":"búsqueda específica para verificar con fuentes oficiales o periodísticas peruanas"}]`;

    // Note: no jsonSchema — Gemini 2.5 Flash works better with prompt-driven
    // JSON structure. jsonMode forces JSON output, prompt defines the shape.
    const r = await callGemini(prompt, { temperature: 0.05, maxTokens: 1024, jsonMode: true });
    const parsed = parseJSON(r.text);
    return Array.isArray(parsed) ? parsed : [];
  }

  // ==========================================================
  // VERIFY CLAIM — con fuentes peruanas prioritarias
  // ==========================================================
  async function verifyClaim(claim) {
    const lang = getEffectiveLanguage();
    const langName = lang === 'es' ? 'español' : 'inglés';
    const prompt = `Eres un verificador de datos riguroso de El Comercio, el diario de mayor circulación de Perú. Tu trabajo: ENCONTRAR LOS DATOS. No digas "difícil de verificar" — BUSCA. Responde en ${langName}.

CONTEXTO: ${getContextString()}
AFIRMACIÓN: "${claim.summary || claim.text}"
Texto original: "${claim.text}"

${PERU_SOURCES}

TIENES GOOGLE SEARCH. ÚSALO como un experto en verificación de datos. Busca en las fuentes más autorizadas para el tema específico — repositorios y observatorios del Estado, medios periodísticos peruanos serios, cuentas verificadas en X y fact-checkers. No te limites a una lista fija: usa tu criterio para encontrar la fuente más relevante según el tipo de afirmación (salud → MINSA/Salud con Lupa, economía → BCRP/MEF, votaciones → congreso.gob.pe/ONPE, etc.).

REGLAS DE DECISIÓN:
1. BUSCA el dato específico (número, fecha, porcentaje, estadística, resultado) en la fuente más autorizada para ese tema.
2. Datos CONFIRMAN la afirmación (margen ±10-15%) → VERDADERO.
3. Datos CONTRADICEN la afirmación → FALSO.
4. La afirmación tiene datos reales pero INCOMPLETOS o fuera de contexto que inducen al error → ENGANOSO.
5. Mezcla algo verdadero con algo falso o exagerado → ENGANOSO.
6. No encuentras datos oficiales o verificados después de buscar → SIN_DATOS.
7. La afirmación es demasiado vaga para verificar con datos concretos → SIN_DATOS.

REGLAS ABSOLUTAS:
- NUNCA digas "difícil de verificar" para afirmaciones con números específicos o eventos políticos nombrados.
- NUNCA marques VERDADERO si tu explicación muestra números diferentes a los de la afirmación.
- USA ENGANOSO cuando el dato existe pero el contexto o presentación distorsiona su significado.
- SIEMPRE indica: "La afirmación dice [X]. Los datos/medios de [fuente peruana] muestran/confirman [Y]."
- La explicación DEBE ser consistente con el veredicto.
- Menciona la fuente peruana específica que usaste.
- Escribe la "explanation" en ${langName}. 2-3 oraciones. Siempre compara cifra/hecho afirmado vs cifra/hecho real.

CRÍTICO: Tu respuesta completa debe ser un único objeto JSON. Todo el análisis va dentro de "explanation".

{"verdict":"VERDADERO|FALSO|ENGANOSO|SIN_DATOS","confidence":0.0-1.0,"explanation":"La afirmación dice [X]. Según [fuente], el dato real es [Y]. Por lo tanto [veredicto].","needsClarification":false,"clarificationQuestion":null}`;

    try {
      const r = await callGemini(prompt, { grounded: true, maxTokens: 1024 });
      let p = parseJSON(r.text);
      if (!p && r.text && r.text.length > 10) {
        p = extractVerdictFromProse(r.text);
      }
      // Self-consistency check
      if (p && p.verdict) {
        const v = p.verdict.toUpperCase();
        const expl = (p.explanation || '').toLowerCase();
        if (v === 'TRUE') {
          const contradictionSignals = [
            /(?:datos?|cifras?|oficial|inei|bcrp|mef)\s+(?:muestran?|indica[n]?|registra[n]?|señala[n]?)\s+(?:un |una |el |la |los |las )?(?:\d|diferente|distint)/i,
            /(?:sin embargo|however|but|pero)\s.*?(?:\d+[.,]?\d*\s*%)/i,
            /(?:real|actual|oficial)\s+(?:figure|número|dato|cifra|porcentaje)\s.*?(?:differ|distint|no coincid)/i,
          ];
          for (const re of contradictionSignals) {
            if (re.test(p.explanation)) {
              p.verdict = 'SIN_DATOS';
              p.confidence = Math.min(p.confidence || 0.5, 0.5);
              break;
            }
          }
        }
      }

      if (p) {
        claim.status = 'verified';
        claim.verdict = normalizeVerdict(p.verdict);
        claim.confidence = p.confidence || 0.5;
        claim.explanation = p.explanation || '';
        claim.sources = r.sources || [];
        // Classify sources (EC, oficial, medio, otro)
        claim.sources = classifySources(claim.sources);
        if (p.needsClarification && p.clarificationQuestion) {
          const existing = findClarification(p.clarificationQuestion);
          if (existing) { claim.status = 'pending'; await reVerify(claim, p.clarificationQuestion, existing); return; }
          else { claim.needsClarification = true; claim.clarificationQuestion = p.clarificationQuestion; showClarification(claim.id, p.clarificationQuestion); }
        }
      } else {
        claim.status = 'verified'; claim.verdict = 'UNCERTAIN';
        const preview = (r.text || '').substring(0, 200).trim();
        claim.explanation = preview ? 'Formato inesperado de API: "' + preview + '..."' : 'Respuesta vacía de la API';
      }
    } catch (err) {
      if (err.message.startsWith('RATE_LIMITED')) {
        claim.explanation = 'Límite de tasa — en cola para reintento...';
        updateClaimInTranscript(claim);
        pendingVerifications.unshift(claim);
        const waitMs = parseInt(err.message.split(':')[1]) || 30000;
        await sleep(waitMs);
        return;
      }
      claim.status = 'verified'; claim.verdict = 'SIN_DATOS'; claim.explanation = 'Error: ' + err.message.substring(0, 100);
    }
    updateClaimInTranscript(claim);
    updateStats();
  }

  // Clasifica fuentes por tipo para mostrar badge correcto en el modal
  function classifySources(sources) {
    return sources.map(s => {
      const url = (s.url || '').toLowerCase();
      let type = 'otro';
      if (url.includes('elcomercio.pe')) type = 'ec';
      else if (url.includes('inei.gob.pe') || url.includes('bcrp.gob.pe') || url.includes('mef.gob.pe') ||
               url.includes('gob.pe') || url.includes('onpe.gob.pe') || url.includes('jne.gob.pe') ||
               url.includes('worldbank.org') || url.includes('imf.org') || url.includes('cepal.org') ||
               url.includes('paho.org') || url.includes('who.int')) type = 'oficial';
      else if (url.includes('rpp.pe') || url.includes('larepublica.pe') || url.includes('peru21.pe') ||
               url.includes('ojo-publico.com') || url.includes('idl-reporteros.pe') ||
               url.includes('gestión.pe') || url.includes('andina.pe')) type = 'medio';
      return { ...s, type };
    });
  }

  async function reVerify(claim, question, answer) {
    const prompt = `Verifica la afirmación con contexto adicional. ${getContextString()}\nPregunta: ${question}\nRespuesta: ${answer}\nAFIRMACIÓN: "${claim.text}"\n${PERU_SOURCES}\nJSON: {"verdict":"VERDADERO|FALSO|ENGANOSO|SIN_DATOS","confidence":0-1,"explanation":"..."}`;
    try {
      const r = await callGemini(prompt, { grounded: true, maxTokens: 512 });
      const p = parseJSON(r.text);
      if (p) {
        claim.status='verified'; claim.verdict=normalizeVerdict(p.verdict);
        claim.confidence=p.confidence||0.5; claim.explanation=p.explanation||'';
        claim.sources=classifySources(r.sources||[]); claim.needsClarification=false;
      }
    } catch { claim.status='verified'; claim.verdict='SIN_DATOS'; claim.explanation='Re-verificación fallida.'; }
    updateClaimInTranscript(claim);
    updateStats();
  }

  // ==========================================================
  // CLARIFICATIONS
  // ==========================================================
  function findClarification(q) {
    const ql = q.toLowerCase();
    for (const [k,v] of Object.entries(state.clarifications)) {
      if (ql.includes(k.toLowerCase()) || k.toLowerCase().includes(ql)) return v;
    }
    return null;
  }

  function showClarification(claimId, question) {
    state.pendingClarification = { claimId, question };
    dom.clarQuestion.textContent = question;
    dom.clarInput.value = '';
    dom.clarBanner.classList.remove('hidden');
    dom.clarInput.focus();
  }

  function submitClarification() {
    const answer = dom.clarInput.value.trim();
    if (!answer || !state.pendingClarification) return;
    const { claimId, question } = state.pendingClarification;
    state.clarifications[question] = answer;
    chrome.storage.local.set({ clarifications: state.clarifications });
    dom.clarBanner.classList.add('hidden');
    state.pendingClarification = null;
    const claim = state.claims.get(claimId);
    if (claim) { claim.status = 'pending'; updateClaimInTranscript(claim); reVerify(claim, question, answer); }
  }

  // ==========================================================
  // HIGHLIGHTING
  // ==========================================================
  function highlightClaimInTranscript(claim) {
    const blocks = dom.transcript.querySelectorAll('.transcript-block');
    const escaped = escapeRegExp(claim.text);
    for (const block of blocks) {
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walker.nextNode()) {
        if (!walker.currentNode.parentElement.classList.contains('claim-mark')) nodes.push(walker.currentNode);
      }
      for (const node of nodes) {
        const match = node.textContent.match(new RegExp(`(${escaped})`, 'i'));
        if (match) {
          const idx = match.index;
          const before = node.textContent.substring(0, idx);
          const matched = node.textContent.substring(idx, idx + match[1].length);
          const after = node.textContent.substring(idx + match[1].length);
          const mark = document.createElement('mark');
          mark.className = 'claim-mark claim-pending';
          mark.dataset.claimId = claim.id;
          mark.textContent = matched;
          const frag = document.createDocumentFragment();
          if (before) frag.appendChild(document.createTextNode(before));
          frag.appendChild(mark);
          if (after) frag.appendChild(document.createTextNode(after));
          node.parentNode.replaceChild(frag, node);
          return;
        }
      }
    }
    // Fuzzy fallback
    const claimWords = claim.text.toLowerCase().split(/\s+/).filter(w => w.length > 3);
    let best = null, bestScore = 0;
    for (const b of blocks) {
      const bt = b.textContent.toLowerCase();
      const score = claimWords.filter(w => bt.includes(w)).length;
      if (score > bestScore) { bestScore = score; best = b; }
    }
    if (best && bestScore >= Math.min(3, claimWords.length)) {
      const ind = document.createElement('mark');
      ind.className = 'claim-mark claim-pending';
      ind.dataset.claimId = claim.id;
      ind.textContent = ` [${claim.summary.substring(0,50)}...]`;
      ind.style.fontSize = '12px';
      best.appendChild(ind);
    }
  }

  function updateClaimInTranscript(claim) {
    const v = (claim.verdict || 'pending').toLowerCase();
    const cls = v === 'verdadero' ? 'claim-true' : v === 'falso' ? 'claim-false' : v === 'enganoso' ? 'claim-uncertain' : v === 'sin_datos' ? 'claim-nodata' : 'claim-pending';
    for (const mark of document.querySelectorAll(`.claim-mark[data-claim-id="${claim.id}"]`)) {
      mark.className = 'claim-mark ' + cls;
    }
  }

  // ==========================================================
  // TOOLTIP
  // ==========================================================
  const tooltip = $('#claimTooltip');

  function showClaimTooltip(mark, claim) {
    const v = (claim.verdict || 'pending').toLowerCase();
    const verdictLabels = { verdadero: '✓ VERDADERO', falso: '✗ FALSO', enganoso: '⚠ ENGAÑOSO', sin_datos: '— SIN DATOS', pending: '⟳ Verificando...' };
    const verdictColors = { verdadero: 'var(--green)', falso: 'var(--red)', enganoso: 'var(--orange)', sin_datos: 'var(--muted)', pending: 'var(--muted)' };

    tooltip.querySelector('.ct-verdict').textContent = verdictLabels[v] || 'Verificando...';
    tooltip.querySelector('.ct-verdict').style.color = verdictColors[v] || 'var(--text-muted)';
    tooltip.querySelector('.ct-summary').textContent = claim.summary || claim.text;
    const srcs = (claim.sources || []).slice(0, 2).map(s => s.title || s.url || s).join(' · ');
    tooltip.querySelector('.ct-sources').textContent = srcs ? '📎 ' + srcs : '';
    tooltip.querySelector('.ct-footer').textContent = 'Clic para ver detalles completos';

    const rect = mark.getBoundingClientRect();
    tooltip.style.left = Math.min(rect.left, window.innerWidth - 280) + 'px';
    tooltip.style.top = (rect.bottom + 6) + 'px';
    tooltip.classList.remove('hidden');
  }

  function hideClaimTooltip() {
    tooltip.classList.add('hidden');
  }

  // ==========================================================
  // MODAL
  // ==========================================================
  function openClaimDetail(claimId) {
    const claim = state.claims.get(claimId);
    if (!claim) return;

    const v = (claim.verdict || 'pending').toLowerCase();
    const verdictLabels = { verdadero: '✓ VERDADERO', falso: '✗ FALSO', enganoso: '⚠ ENGAÑOSO', sin_datos: '— SIN DATOS', pending: '⟳ Verificando...' };
    dom.modalVerdict.textContent = verdictLabels[v] || 'Verificando...';
    dom.modalVerdict.className = 'modal-verdict v-' + v.replace('_','-');
    dom.modalClaim.textContent = claim.text;
    dom.modalExplanation.textContent = claim.explanation || '';

    // Sources with type badges
    if (claim.sources?.length) {
      const badgeLabels = { ec: 'El Comercio', oficial: 'Oficial', medio: 'Medio', otro: 'Fuente' };
      dom.modalSources.innerHTML = '<h4>Fuentes</h4>' + claim.sources.map(s => {
        const badge = `<span class="source-badge ${s.type || 'otro'}">${badgeLabels[s.type || 'otro']}</span>`;
        return `<div class="source-item">${badge}<a href="${escapeHtml(s.url||s)}" target="_blank">${escapeHtml(s.title||s.url||s)}</a></div>`;
      }).join('');
    } else {
      dom.modalSources.innerHTML = '';
    }

    if (claim.confidence) {
      const pct = Math.round(claim.confidence * 100);
      dom.modalConfidence.innerHTML = `<span>Confianza: ${pct}%</span><div class="confidence-bar"><div class="confidence-fill" style="width:${pct}%"></div></div>`;
    } else {
      dom.modalConfidence.innerHTML = '';
    }

    dom.modal.classList.remove('hidden');
    hideClaimTooltip();
  }

  function closeModal() {
    dom.modal.classList.add('hidden');
  }

  // ==========================================================
  // EXPORT REPORT — con branding EC
  // ==========================================================
  function exportReport() {
    const now = new Date();
    const dateStr = now.toLocaleDateString('es-PE', { year:'numeric', month:'long', day:'numeric' });
    const timeStr = now.toLocaleTimeString('es-PE', { hour:'2-digit', minute:'2-digit' });
    const speaker = dom.ctxSpeaker.value.trim() || state.context.speaker || 'No especificado';
    const event = dom.ctxEvent.value.trim() || state.context.event || 'Sin título';
    const url = state.context.url || '';
    const platform = state.context.platform || '';
    const videoDate = state.context.date || '';
    const description = state.context.description || '';
    const duration = state.startTime ? Math.round((Date.now() - state.startTime) / 60000) : 0;

    const claimList = [...state.claims.values()];
    const trueCount = claimList.filter(c => c.verdict === 'VERDADERO').length;
    const falseCount = claimList.filter(c => c.verdict === 'FALSO').length;
    const uncertainCount = claimList.filter(c => c.verdict === 'ENGANOSO').length;
    const noDataCount = claimList.filter(c => c.verdict === 'SIN_DATOS').length;

    // Build transcript HTML with highlighted claims
    let transcriptHtml = '';
    for (const entry of state.transcript) {
      const timeStr2 = formatVideoTime(entry.timestamp);
      let text = escapeHtml(entry.text);
      for (const claim of claimList) {
        if (claim.verdict && entry.text.toLowerCase().includes((claim.text || '').toLowerCase().substring(0,30))) {
          const v = claim.verdict.toLowerCase();
          const cls = v === 'verdadero' ? 'claim-true' : v === 'falso' ? 'claim-false' : v === 'enganoso' ? 'claim-uncertain' : 'claim-nodata';
          const escaped = escapeRegExp(escapeHtml(claim.text.substring(0,60)));
          text = text.replace(new RegExp('(' + escaped + ')', 'i'), `<mark class="${cls}">$1</mark>`);
        }
      }
      transcriptHtml += `<div class="t-entry"><span class="t-time">${timeStr2}</span>${text}</div>`;
    }

    // Build claims HTML
    const verdictLabels = { VERDADERO: 'VERDADERO', FALSO: 'FALSO', ENGANOSO: 'ENGAÑOSO', SIN_DATOS: 'SIN DATOS' };
    const badgeLabels = { ec: 'El Comercio', oficial: 'Oficial', medio: 'Medio', otro: 'Fuente' };

    let claimsHtml = '';
    for (const c of claimList) {
      const v = (c.verdict || 'SIN_DATOS').toLowerCase();
      const cls = v === 'verdadero' ? 'v-true' : v === 'falso' ? 'v-false' : v === 'enganoso' ? 'v-uncertain' : 'v-nodata';
      const icon = v === 'true' ? '✓' : v === 'false' ? '✗' : '?';
      const label = verdictLabels[c.verdict || 'SIN_DATOS'] || 'SIN DATOS';
      const pct = c.confidence ? Math.round(c.confidence * 100) : 0;

      const sourcesHtml = (c.sources || []).map(s => {
        const btype = s.type || 'otro';
        return `<div class="source-item"><span class="source-badge ${btype}">${badgeLabels[btype]}</span><a href="${escapeHtml(s.url||s)}" target="_blank">${escapeHtml(s.title||s.url||s)}</a></div>`;
      }).join('');

      claimsHtml += `
      <div class="claim-card ${cls}">
        <div class="claim-header">
          <span class="verdict-badge ${cls}"><span class="v-icon">${icon}</span> ${label}</span>
          <span class="confidence">${pct}% confianza</span>
        </div>
        <blockquote>"${escapeHtml(c.text)}"</blockquote>
        <p class="explanation">${escapeHtml(c.explanation || '')}</p>
        ${sourcesHtml ? '<div class="sources">' + sourcesHtml + '</div>' : ''}
      </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Verificador EC — ${escapeHtml(event)}</title>
<style>
:root{
  --ec-blue:#003087;--ec-blue-light:#0050b3;--ec-red:#E31837;
  --bg:#0d1117;--bg2:#161b22;--bg3:#1c2128;--border:#2a3042;
  --text:#e2e5ed;--dim:#8b90a8;--muted:#545c72;
  --green:#22c55e;--yellow:#eab308;--red:#ef4444;--orange:#f97316;
}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:0}
.container{max-width:900px;margin:0 auto;padding:32px 24px 60px}
/* Header */
.report-header{padding:32px 32px 24px;background:linear-gradient(135deg,#0a1a3a 0%,#0d1117 60%,#1a0810 100%);border-bottom:3px solid var(--ec-red)}
.header-top{display:flex;align-items:center;gap:14px;margin-bottom:16px}
.ec-mark{width:44px;height:44px;background:var(--ec-red);border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:800;color:#fff;letter-spacing:1px;flex-shrink:0}
.header-titles h1{font-size:22px;font-weight:800;letter-spacing:-0.3px}
.header-titles h1 span{color:var(--ec-red)}
.header-titles .subtitle{color:var(--dim);font-size:13px;margin-top:2px}
.event-title{font-size:17px;font-weight:600;color:var(--text);margin-bottom:12px}
.meta-row{display:flex;gap:18px;flex-wrap:wrap;font-size:12px;color:var(--muted)}
.meta-row a{color:var(--ec-blue-light);text-decoration:none}
/* Stats */
.stats-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin:28px 0}
.stat-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center}
.stat-card .num{font-size:26px;font-weight:800}
.stat-card .lbl{font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--muted);margin-top:2px}
.stat-card.st-true .num{color:var(--green)}.stat-card.st-false .num{color:var(--red)}.stat-card.st-uncertain .num{color:var(--yellow)}
/* Section headers */
h2{font-size:16px;font-weight:700;margin:28px 0 14px;padding-bottom:8px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:8px}
h2 .count{font-size:12px;font-weight:500;color:var(--muted);background:var(--bg3);padding:2px 9px;border-radius:10px}
/* Claims */
.claim-card{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:16px;margin-bottom:12px;border-left:4px solid var(--muted)}
.claim-card.v-true{border-left-color:var(--green)}.claim-card.v-false{border-left-color:var(--red)}.claim-card.v-uncertain{border-left-color:var(--yellow)}
.claim-header{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.verdict-badge{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;display:flex;align-items:center;gap:4px;padding:3px 10px;border-radius:5px}
.verdict-badge.v-true{background:rgba(34,197,94,.15);color:var(--green)}.verdict-badge.v-false{background:rgba(239,68,68,.15);color:var(--red)}.verdict-badge.v-uncertain{background:rgba(234,179,8,.15);color:var(--yellow)}
.confidence{font-size:11px;color:var(--muted)}
blockquote{font-style:italic;padding:8px 12px;margin:8px 0;border-left:3px solid var(--border);background:var(--bg3);border-radius:0 6px 6px 0;font-size:13px}
.explanation{font-size:12.5px;color:var(--dim);margin-top:6px;line-height:1.55}
.sources{margin-top:10px;padding-top:8px;border-top:1px solid var(--border)}
.source-item{display:flex;align-items:flex-start;gap:6px;margin-bottom:4px}
.source-badge{font-size:9px;font-weight:700;text-transform:uppercase;padding:1px 5px;border-radius:3px;white-space:nowrap;flex-shrink:0}
.source-badge.ec{background:rgba(227,24,55,.2);color:#ff6b7a;border:1px solid rgba(227,24,55,.3)}
.source-badge.oficial{background:rgba(0,80,179,.2);color:#4d9fff}
.source-badge.medio{background:rgba(234,179,8,.15);color:var(--yellow)}
.source-badge.otro{background:var(--bg3);color:var(--muted)}
.source-item a{color:#4d9fff;text-decoration:none;font-size:11.5px;word-break:break-all}
.source-item a:hover{text-decoration:underline}
/* Transcript */
.transcript-section{background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:24px}
.t-entry{margin-bottom:5px;font-size:13px;line-height:1.7}
.t-time{font-size:10px;color:var(--muted);margin-right:7px;font-variant-numeric:tabular-nums}
mark{padding:1px 3px;border-radius:3px;border-bottom:2px solid transparent}
.claim-true{background:rgba(34,197,94,.15);border-bottom-color:var(--green)}
.claim-false{background:rgba(239,68,68,.15);border-bottom-color:var(--red)}
.claim-uncertain{background:rgba(249,115,22,.15);border-bottom-color:var(--orange)}
.claim-nodata{background:rgba(139,144,168,.12);border-bottom-color:var(--muted)}
/* Footer */
.report-footer{text-align:center;padding:20px;color:var(--muted);font-size:11px;border-top:1px solid var(--border);margin-top:24px}
.report-footer .ec-footer{color:var(--ec-red);font-weight:700}
.report-footer a{color:var(--ec-blue-light);text-decoration:none}
/* Print */
@media print{body{background:#fff;color:#111}.report-header{background:#f5f5f5;border-bottom:3px solid #E31837}.stat-card,.claim-card,.transcript-section{border-color:#ddd;background:#fafafa}mark{print-color-adjust:exact;-webkit-print-color-adjust:exact}}
@media(max-width:600px){.stats-grid{grid-template-columns:repeat(3,1fr)}.container{padding:16px}}
</style>
</head>
<body>
<div class="report-header">
  <div class="container" style="padding-top:0;padding-bottom:0">
    <div class="header-top">
      <div class="ec-mark">EC</div>
      <div class="header-titles">
        <h1>Verificador <span>EC</span></h1>
        <div class="subtitle">El Comercio · Perú · Verificación periodística de datos</div>
      </div>
    </div>
    <div class="event-title">${escapeHtml(event)}</div>
    <div class="meta-row">
      <span><strong>Orador:</strong> ${escapeHtml(speaker)}</span>
      ${videoDate ? '<span><strong>Fecha:</strong> ' + escapeHtml(videoDate) + '</span>' : ''}
      ${platform ? '<span><strong>Plataforma:</strong> ' + escapeHtml(platform) + '</span>' : ''}
      <span><strong>Analizado:</strong> ${escapeHtml(dateStr)} a las ${escapeHtml(timeStr)}</span>
      ${duration ? '<span><strong>Duración:</strong> ' + duration + ' min</span>' : ''}
      ${url ? '<span><a href="' + escapeHtml(url) + '" target="_blank">🔗 Ver video original</a></span>' : ''}
    </div>
  </div>
</div>
<div class="container">
  <div class="stats-grid">
    <div class="stat-card"><div class="num">${state.wordCount.toLocaleString()}</div><div class="lbl">Palabras</div></div>
    <div class="stat-card"><div class="num">${state.claims.size}</div><div class="lbl">Afirmaciones</div></div>
    <div class="stat-card st-true"><div class="num">${trueCount}</div><div class="lbl">Verdaderas</div></div>
    <div class="stat-card st-false"><div class="num">${falseCount}</div><div class="lbl">Falsas</div></div>
    <div class="stat-card st-uncertain"><div class="num">${uncertainCount}</div><div class="lbl">Inciertas</div></div>
  </div>

  ${claimList.length > 0 ? `
  <h2>Análisis de Afirmaciones <span class="count">${claimList.length} afirmaciones</span></h2>
  ${claimsHtml}
  ` : '<p style="color:var(--muted);text-align:center;padding:20px">No se identificaron afirmaciones verificables en esta sesión.</p>'}

  <h2 style="margin-top:32px">Transcripción Completa <span class="count">${state.transcript.length} segmentos</span></h2>
  <div class="transcript-section">
    ${transcriptHtml || '<p style="color:var(--muted)">No hay transcripción registrada.</p>'}
  </div>

  ${description ? `
  <h2>Descripción del Video</h2>
  <div class="transcript-section" style="font-size:12.5px;color:var(--dim)">${escapeHtml(description)}</div>
  ` : ''}
</div>
<div class="report-footer">
  <span class="ec-footer">Verificador EC</span> · <a href="https://elcomercio.pe" target="_blank">El Comercio</a> · Lima, Perú<br>
  Reporte generado el ${escapeHtml(dateStr)} a las ${escapeHtml(timeStr)} · Verificación automatizada con Gemini + Google Search
  <br><small style="color:var(--muted);margin-top:4px;display:block">Este reporte es un apoyo periodístico. Las conclusiones deben ser revisadas por un periodista antes de su publicación.</small>
</div>
</body>
</html>`;

    const blob = new Blob([html], { type: 'text/html' });
    const a = document.createElement('a');
    const filename = 'verificador-ec-' + event.replace(/[^a-zA-Z0-9áéíóúñ]/gi,'-').substring(0,40).replace(/-+$/,'') + '-' + now.toISOString().slice(0,10) + '.html';
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('¡Reporte exportado!');
  }

  // ==========================================================
  // UTILS
  // ==========================================================
  function formatVideoTime(ms) {
    const totalSec = Math.floor(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = totalSec % 60;
    if (h > 0) return h + ':' + String(m).padStart(2,'0') + ':' + String(s).padStart(2,'0');
    return m + ':' + String(s).padStart(2,'0');
  }
  function escapeHtml(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ==========================================================
  // BOOT
  // ==========================================================
  init();
})();
