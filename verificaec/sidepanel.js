// VerificaEC — sidepanel.js
// Lógica principal: estado, API calls, rate limiter, i18n, auditoría, exportación

// ─── ESTADO GLOBAL ────────────────────────────────────────────────────────────
const state = {
  apiKey: '',
  mode: 'live',
  interval: 10000,
  isRunning: false,
  claims: [],           // Array de afirmaciones verificadas
  transcript: [],       // Segmentos de transcripción {start, text, speaker}
  speakers: {},         // Map speakerId → nombre
  currentView: 'cronologico',
  videoInfo: null,
  stats: { verdadero: 0, falso: 0, enganoso: 0, incierto: 0 },
  verifyTimer: null,
  captionQueue: [],
  currentSpeakerId: null, // para modal de etiquetado
};

// ─── i18n ────────────────────────────────────────────────────────────────────
let i18n = {};
async function loadI18n() {
  try {
    const r = await fetch(chrome.runtime.getURL('i18n/es-PE.json'));
    i18n = await r.json();
  } catch { i18n = {}; }
}
function t(key) { return i18n[key] || key; }

// ─── GEMINI API ───────────────────────────────────────────────────────────────
const GEMINI_MODEL = 'gemini-2.0-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

async function callGemini(prompt) {
  // Registrar llamada en el rate limiter global (background)
  await chrome.runtime.sendMessage({ type: 'REGISTER_API_CALL' });

  const response = await fetch(`${GEMINI_ENDPOINT}?key=${state.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
    })
  });

  if (!response.ok) {
    const err = await response.json();
    throw new Error(err.error?.message || 'Error de API');
  }

  const data = await response.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Esperar si hay restricción de rate limit
async function acquireApiSlot() {
  while (true) {
    const status = await chrome.runtime.sendMessage({ type: 'GET_RATE_STATUS' });
    if (status.canCall) break;
    updateRateBar(status.callsInWindow, status.limit);
    setStatus(`${t('rate_limit_wait')} (${Math.round(status.waitMs / 1000)}s)`);
    await sleep(Math.min(status.waitMs, 2000));
  }
}

// ─── PROMPTS ──────────────────────────────────────────────────────────────────
function buildIdentifyPrompt(text, context = '') {
  return `Eres un fact-checker experto del diario El Comercio de Perú. Analiza el siguiente texto y extrae ÚNICAMENTE afirmaciones verificables con datos específicos y comprobables.

TEXTO A ANALIZAR:
"${text}"

${context ? `CONTEXTO PREVIO: ${context}` : ''}

INSTRUCCIONES:
- Extrae solo afirmaciones con cifras, porcentajes, estadísticas, hechos históricos, declaraciones legales o datos verificables
- NO incluyas opiniones, predicciones o juicios de valor
- NO incluyas afirmaciones demasiado vagas para verificar
- Para cada afirmación, identifica el tema principal

Responde SOLO en JSON válido, sin texto adicional, con este formato exacto:
{
  "afirmaciones": [
    {
      "texto": "afirmación exacta tal como fue dicha",
      "tema": "uno de: economia|salud|educacion|elecciones|leyes|social|otro",
      "verificable": true
    }
  ]
}

Si no hay afirmaciones verificables, devuelve: {"afirmaciones": []}`;
}

function buildVerifyPrompt(claim, topic) {
  const sourcesConfig = getSuggestedSources(topic);
  
  return `Eres un fact-checker riguroso de El Comercio Perú. Debes verificar la siguiente afirmación con fuentes oficiales peruanas e internacionales confiables.

AFIRMACIÓN A VERIFICAR:
"${claim}"

TEMA: ${topic}
FUENTES RECOMENDADAS A CONSULTAR: ${sourcesConfig}

INSTRUCCIONES DE VERIFICACIÓN:
1. Busca datos específicos que confirmen o refuten la afirmación
2. Usa Google Search grounding para encontrar las fuentes más recientes
3. Para cifras económicas, prioriza BCRP e INEI
4. Para datos electorales, prioriza JNE
5. Para salud, prioriza MINSA y OPS
6. Una afirmación es ENGAÑOSA si: es técnicamente correcta pero omite contexto crucial, usa período engañoso, compara categorías incomparables, o el énfasis distorsiona la realidad
7. Solo marca como VERDADERO si los datos coinciden claramente
8. Marca como INCIERTO si no encuentras datos suficientes

VEREDICTOS POSIBLES: VERDADERO | FALSO | ENGAÑOSO | INCIERTO

Responde SOLO en JSON válido, sin texto adicional:
{
  "veredicto": "VERDADERO|FALSO|ENGAÑOSO|INCIERTO",
  "confianza": 85,
  "explicacion": "Explicación clara en 2-3 oraciones para el lector peruano",
  "fuentes": [
    {
      "nombre": "Nombre de la institución/medio",
      "url": "https://...",
      "dato": "Dato específico encontrado"
    }
  ],
  "contexto_omitido": "Si es ENGAÑOSO, describe qué contexto falta"
}`;
}

function getSuggestedSources(topic) {
  const router = {
    economia: 'BCRP (bcrp.gob.pe), INEI (inei.gob.pe), MEF (mef.gob.pe), FMI, Banco Mundial',
    salud: 'MINSA (gob.pe/minsa), OPS (paho.org), INEI',
    educacion: 'MINEDU/ESCALE (escale.minedu.gob.pe), INEI, CEPAL',
    elecciones: 'JNE (jne.gob.pe), Infogob, Congreso (congreso.gob.pe)',
    leyes: 'Congreso (congreso.gob.pe), SPIJ (spij.minjus.gob.pe), El Peruano',
    social: 'INEI (inei.gob.pe), CEPAL, PNUD, Banco Mundial',
    otro: 'INEI, El Comercio Archivo, AFP, Reuters'
  };
  return router[topic] || router.otro;
}

// ─── LÓGICA DE VERIFICACIÓN ───────────────────────────────────────────────────
async function identifyClaims(text) {
  await acquireApiSlot();
  const prompt = buildIdentifyPrompt(text, state.transcript.slice(-3).map(s => s.text).join(' '));
  const raw = await callGemini(prompt);
  
  try {
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    const parsed = JSON.parse(clean);
    return parsed.afirmaciones || [];
  } catch {
    return [];
  }
}

async function verifyClaim(claimObj) {
  await acquireApiSlot();
  const prompt = buildVerifyPrompt(claimObj.texto, claimObj.tema);
  const raw = await callGemini(prompt);

  try {
    const clean = raw.replace(/```json\n?|\n?```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return {
      veredicto: 'INCIERTO',
      confianza: 0,
      explicacion: 'No se pudo procesar la verificación.',
      fuentes: []
    };
  }
}

// ─── PROCESAMIENTO DE SUBTÍTULOS (MODO LIVE) ──────────────────────────────────
async function processCaption(text) {
  if (!text || text.length < 20) return;

  // Agregar a transcripción
  state.transcript.push({
    start: Date.now(),
    text,
    speaker: state.speakers['default'] || t('speaker_unknown')
  });

  // Identificar afirmaciones
  let claims;
  try {
    claims = await identifyClaims(text);
  } catch (err) {
    console.error('Error identificando afirmaciones:', err);
    return;
  }

  for (const claim of claims) {
    // Agregar como pendiente
    const claimId = `claim-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const claimData = {
      id: claimId,
      texto: claim.texto,
      tema: claim.tema,
      speaker: state.speakers['default'] || t('speaker_unknown'),
      timestamp: new Date().toLocaleTimeString('es-PE'),
      videoTime: null,
      veredicto: null,
      confianza: 0,
      explicacion: '',
      fuentes: [],
      auditStatus: 'pendiente', // pendiente|aprobado|modificado|omitido
      verificando: true
    };
    state.claims.unshift(claimData);
    renderClaims();

    // Verificar
    try {
      const result = await verifyClaim(claim);
      const idx = state.claims.findIndex(c => c.id === claimId);
      if (idx !== -1) {
        state.claims[idx] = {
          ...state.claims[idx],
          veredicto: result.veredicto,
          confianza: result.confianza,
          explicacion: result.explicacion,
          fuentes: result.fuentes || [],
          contextoOmitido: result.contexto_omitido,
          verificando: false,
          auditStatus: 'propuesto'
        };
        updateStats();
        renderClaims();
        updateExportVisibility();
      }
    } catch (err) {
      console.error('Error verificando:', err);
      const idx = state.claims.findIndex(c => c.id === claimId);
      if (idx !== -1) {
        state.claims[idx].verificando = false;
        state.claims[idx].veredicto = 'INCIERTO';
        state.claims[idx].auditStatus = 'propuesto';
        renderClaims();
      }
    }
  }
}

// ─── MODO BATCH ───────────────────────────────────────────────────────────────
async function runBatchAnalysis() {
  if (!validateSetup()) return;

  setRunningState(false);
  showProgress(true, 'Extrayendo transcripción...', 0);

  // 1. Extraer transcripción
  let transcriptData;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TRANSCRIPT' });
    if (!response.success || !response.data) {
      showProgress(false);
      setStatus(t('no_transcript'));
      return;
    }
    transcriptData = response.data;
    state.videoInfo = { title: transcriptData.title, url: transcriptData.url };
    showVideoInfo(transcriptData.title);
    state.transcript = transcriptData.segments.map(s => ({ ...s, speaker: t('speaker_unknown') }));
  } catch (err) {
    showProgress(false);
    setStatus('Error: ' + err.message);
    return;
  }

  // 2. Identificar afirmaciones en chunks
  const fullText = transcriptData.fullText;
  const chunkSize = 1500; // chars
  const chunks = [];
  for (let i = 0; i < fullText.length; i += chunkSize) {
    chunks.push(fullText.slice(i, i + chunkSize));
  }

  let allClaims = [];
  for (let i = 0; i < chunks.length; i++) {
    const pct = Math.round((i / chunks.length) * 40);
    showProgress(true, `${t('phase1')} (${i + 1}/${chunks.length})`, pct);
    try {
      const claims = await identifyClaims(chunks[i]);
      allClaims = [...allClaims, ...claims];
    } catch (err) {
      console.warn('Error en chunk', i, err);
    }
  }

  // Deduplicar afirmaciones similares
  allClaims = deduplicateClaims(allClaims);

  if (allClaims.length === 0) {
    showProgress(false);
    setStatus('No se encontraron afirmaciones verificables en este video.');
    return;
  }

  // 3. Verificar afirmaciones una por una
  for (let i = 0; i < allClaims.length; i++) {
    const pct = 40 + Math.round((i / allClaims.length) * 60);
    showProgress(true, `${t('phase2')}: ${i + 1} ${t('of')} ${allClaims.length}`, pct);

    const claim = allClaims[i];
    const claimId = `batch-${Date.now()}-${i}`;

    // Encontrar timestamp aproximado en la transcripción
    const segment = findSegmentForClaim(claim.texto, transcriptData.segments);

    const claimData = {
      id: claimId,
      texto: claim.texto,
      tema: claim.tema,
      speaker: t('speaker_unknown'),
      timestamp: segment ? formatTime(segment.start) : '—',
      videoTime: segment?.start || null,
      veredicto: null,
      confianza: 0,
      explicacion: '',
      fuentes: [],
      auditStatus: 'propuesto',
      verificando: true
    };
    state.claims.unshift(claimData);
    renderClaims();

    try {
      const result = await verifyClaim(claim);
      const idx = state.claims.findIndex(c => c.id === claimId);
      if (idx !== -1) {
        state.claims[idx] = {
          ...state.claims[idx],
          veredicto: result.veredicto,
          confianza: result.confianza,
          explicacion: result.explicacion,
          fuentes: result.fuentes || [],
          contextoOmitido: result.contexto_omitido,
          verificando: false
        };
        updateStats();
        renderClaims();
      }
    } catch (err) {
      const idx = state.claims.findIndex(c => c.id === claimId);
      if (idx !== -1) {
        state.claims[idx].verificando = false;
        state.claims[idx].veredicto = 'INCIERTO';
        renderClaims();
      }
    }
  }

  showProgress(false);
  updateExportVisibility();
  setStatus(t('complete'));
}

function deduplicateClaims(claims) {
  const seen = new Set();
  return claims.filter(c => {
    const key = c.texto.slice(0, 50).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function findSegmentForClaim(claimText, segments) {
  const words = claimText.toLowerCase().split(' ').slice(0, 5);
  return segments.find(s => words.some(w => s.text.toLowerCase().includes(w)));
}

function formatTime(seconds) {
  if (!seconds) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─── ESTADÍSTICAS ─────────────────────────────────────────────────────────────
function updateStats() {
  const counts = { verdadero: 0, falso: 0, enganoso: 0, incierto: 0 };
  state.claims.forEach(c => {
    if (!c.veredicto) return;
    const k = c.veredicto.toLowerCase();
    if (k === 'engañoso') counts.enganoso++;
    else if (counts[k] !== undefined) counts[k]++;
  });
  state.stats = counts;

  document.getElementById('stat-v').textContent = `V: ${counts.verdadero}`;
  document.getElementById('stat-f').textContent = `F: ${counts.falso}`;
  document.getElementById('stat-e').textContent = `E: ${counts.enganoso}`;
  document.getElementById('stat-i').textContent = `?: ${counts.incierto}`;
  const total = state.claims.filter(c => c.veredicto).length;
  document.getElementById('stat-total').textContent = `${total} ${t('verificadas')}`;
  document.getElementById('stats-bar').classList.remove('hidden');
}

// ─── RENDER ───────────────────────────────────────────────────────────────────
function renderClaims() {
  const container = document.getElementById('claims-container');

  if (state.claims.length === 0) {
    container.innerHTML = `
      <div id="empty-state">
        <p>Inicia la verificación para comenzar a identificar y verificar afirmaciones.</p>
        <p class="hint">Funciona con cualquier video de YouTube con subtítulos activados.</p>
      </div>`;
    document.getElementById('view-switcher').classList.add('hidden');
    return;
  }

  document.getElementById('view-switcher').classList.remove('hidden');

  if (state.currentView === 'cronologico') {
    container.innerHTML = state.claims.map(renderClaimCard).join('');
  } else {
    // Agrupar por hablante
    const groups = {};
    state.claims.forEach(c => {
      const key = c.speaker || t('speaker_unknown');
      if (!groups[key]) groups[key] = [];
      groups[key].push(c);
    });
    container.innerHTML = Object.entries(groups).map(([speaker, claims]) => `
      <div class="speaker-group-header">👤 ${escHtml(speaker)} (${claims.length})</div>
      ${claims.map(renderClaimCard).join('')}
    `).join('');
  }

  // Bind events
  container.querySelectorAll('.claim-header[data-id]').forEach(el => {
    el.addEventListener('click', () => openClaimModal(el.dataset.id));
  });
  container.querySelectorAll('.claim-speaker[data-speaker-id]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      openSpeakerModal(el.dataset.speakerId, el.dataset.claimId);
    });
  });
  container.querySelectorAll('.audit-btn.approve').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); auditClaim(el.dataset.id, 'aprobado'); });
  });
  container.querySelectorAll('.audit-btn.modify').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); openModifyModal(el.dataset.id); });
  });
  container.querySelectorAll('.audit-btn.skip').forEach(el => {
    el.addEventListener('click', (e) => { e.stopPropagation(); auditClaim(el.dataset.id, 'omitido'); });
  });
}

function renderClaimCard(claim) {
  const verdictLabel = claim.verificando ? t('verificando') : (claim.veredicto || '—');
  const verdictClass = claim.verificando ? 'verificando' : (claim.veredicto?.toLowerCase().replace('ñ', 'n') || 'incierto');
  const normClass = verdictClass === 'eng' ? 'enganoso' : verdictClass;

  const confidenceColor = {
    verdadero: '#27ae60', falso: '#e74c3c', engañoso: '#e67e22',
    enganoso: '#e67e22', incierto: '#7f8c8d'
  }[normClass] || '#7f8c8d';

  const auditBadge = claim.auditStatus && claim.auditStatus !== 'pendiente' && claim.auditStatus !== 'propuesto'
    ? `<span class="audit-status ${claim.auditStatus}">${claim.auditStatus === 'aprobado' ? '✓ Aprobado' : claim.auditStatus === 'modificado' ? '✏ Modificado' : '⏭ Omitido'}</span>`
    : '';

  const auditButtons = !claim.verificando && claim.auditStatus === 'propuesto'
    ? `<div class="audit-buttons">
        <button class="audit-btn approve" data-id="${claim.id}">✓ Aprobar</button>
        <button class="audit-btn modify" data-id="${claim.id}">✏ Modificar</button>
        <button class="audit-btn skip" data-id="${claim.id}">Omitir</button>
       </div>`
    : '';

  const sourceTags = (claim.fuentes || []).slice(0, 3).map(f =>
    `<a class="source-tag" href="${escHtml(f.url || '#')}" target="_blank">${escHtml(f.nombre || 'Fuente')}</a>`
  ).join('');

  return `
    <div class="claim-card" id="card-${claim.id}">
      <div class="claim-header" data-id="${claim.id}">
        <span class="verdict-badge ${normClass}">${verdictLabel}</span>
        <span class="claim-speaker" data-speaker-id="default" data-claim-id="${claim.id}">
          👤 ${escHtml(claim.speaker)}
        </span>
        <span class="claim-timestamp">${claim.timestamp}</span>
      </div>
      <div class="claim-text">${escHtml(claim.texto)}</div>
      ${!claim.verificando && claim.veredicto ? `
        <div class="claim-body">
          <div class="confidence-bar">
            <div class="confidence-fill" style="width:${claim.confianza}%;background:${confidenceColor}"></div>
          </div>
          ${claim.explicacion ? `<div class="claim-explanation">${escHtml(claim.explicacion)}</div>` : ''}
          ${sourceTags ? `<div class="claim-sources">${sourceTags}</div>` : ''}
          ${auditBadge}
          ${auditButtons}
        </div>` : ''}
    </div>`;
}

// ─── MODAL DE DETALLE ─────────────────────────────────────────────────────────
function openClaimModal(id) {
  const claim = state.claims.find(c => c.id === id);
  if (!claim || claim.verificando) return;

  const verdictClass = (claim.veredicto?.toLowerCase().replace('ñ', 'n')) || 'incierto';
  const normClass = verdictClass === 'eng' ? 'enganoso' : verdictClass;

  const sourcesHtml = (claim.fuentes || []).map(f => `
    <a class="source-link" href="${escHtml(f.url || '#')}" target="_blank">
      🔗 ${escHtml(f.nombre)} ${f.dato ? `— <em>${escHtml(f.dato.slice(0, 100))}</em>` : ''}
    </a>`).join('');

  document.getElementById('modal-content').innerHTML = `
    <div class="modal-verdict">
      <span class="verdict-badge ${normClass}" style="font-size:14px;padding:5px 12px">${claim.veredicto}</span>
      ${claim.confianza ? `<span style="font-size:12px;color:#7c8099;margin-left:8px">Confianza: ${claim.confianza}%</span>` : ''}
    </div>
    <h3>"${escHtml(claim.texto)}"</h3>
    <p style="font-size:11px;color:#7c8099;margin-bottom:12px">
      👤 ${escHtml(claim.speaker)} · ${claim.timestamp} · Tema: ${claim.tema}
    </p>
    ${claim.explicacion ? `<div class="modal-explanation">${escHtml(claim.explicacion)}</div>` : ''}
    ${claim.contextoOmitido ? `<div class="modal-explanation" style="color:#e67e22"><strong>Contexto omitido:</strong> ${escHtml(claim.contextoOmitido)}</div>` : ''}
    ${sourcesHtml ? `<div class="modal-sources"><h4>Fuentes consultadas</h4>${sourcesHtml}</div>` : ''}
  `;

  document.getElementById('modal-overlay').classList.remove('hidden');
}

// ─── MODAL DE HABLANTE ────────────────────────────────────────────────────────
let speakerModalCallback = null;

function openSpeakerModal(speakerId, claimId) {
  state.currentSpeakerId = speakerId;
  const current = state.speakers[speakerId] || '';
  document.getElementById('speaker-name-input').value = current;
  document.getElementById('speaker-modal-overlay').classList.remove('hidden');
  document.getElementById('speaker-name-input').focus();

  speakerModalCallback = (name) => {
    state.speakers[speakerId] = name;
    // Actualizar todas las afirmaciones con ese speakerId
    state.claims.forEach(c => { if (!c.namedSpeaker) c.speaker = name; });
    renderClaims();
  };
}

// ─── AUDITORÍA ────────────────────────────────────────────────────────────────
function auditClaim(id, status) {
  const idx = state.claims.findIndex(c => c.id === id);
  if (idx === -1) return;
  state.claims[idx].auditStatus = status;
  state.claims[idx].auditedAt = new Date().toISOString();
  renderClaims();
}

function openModifyModal(id) {
  const claim = state.claims.find(c => c.id === id);
  if (!claim) return;
  const current = claim.veredicto;
  const newVerdict = prompt(
    `Veredicto actual: ${current}\nCambia a (VERDADERO / FALSO / ENGAÑOSO / INCIERTO):`,
    current
  );
  if (newVerdict && ['VERDADERO','FALSO','ENGAÑOSO','INCIERTO'].includes(newVerdict.toUpperCase())) {
    const idx = state.claims.findIndex(c => c.id === id);
    state.claims[idx].veredicto = newVerdict.toUpperCase();
    state.claims[idx].auditStatus = 'modificado';
    state.claims[idx].auditedAt = new Date().toISOString();
    updateStats();
    renderClaims();
  }
}

// ─── EXPORTACIÓN ─────────────────────────────────────────────────────────────
function exportHTML() {
  const approvedClaims = state.claims.filter(c => c.veredicto && c.auditStatus !== 'omitido');

  const verdictColor = { VERDADERO: '#27ae60', FALSO: '#e74c3c', ENGAÑOSO: '#e67e22', INCIERTO: '#7f8c8d' };

  const claimsHtml = approvedClaims.map(c => `
    <div style="border:1px solid #ddd;border-radius:8px;margin-bottom:16px;overflow:hidden">
      <div style="background:${verdictColor[c.veredicto]};color:#fff;padding:10px 14px;display:flex;gap:12px;align-items:center">
        <span style="font-weight:800;font-size:14px">${c.veredicto}</span>
        <span style="opacity:0.85;font-size:12px">${c.speaker} · ${c.timestamp}</span>
        ${c.auditStatus === 'modificado' ? '<span style="margin-left:auto;font-size:11px;opacity:0.75">✏ Modificado por periodista</span>' : ''}
      </div>
      <div style="padding:14px">
        <p style="font-size:15px;margin-bottom:10px;color:#1a1a1a"><em>"${escHtml(c.texto)}"</em></p>
        ${c.explicacion ? `<p style="font-size:13px;color:#444;margin-bottom:10px">${escHtml(c.explicacion)}</p>` : ''}
        ${c.contextoOmitido ? `<p style="font-size:13px;color:#e67e22;margin-bottom:10px"><strong>Contexto:</strong> ${escHtml(c.contextoOmitido)}</p>` : ''}
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${(c.fuentes || []).map(f => `<a href="${f.url}" target="_blank" style="font-size:12px;background:#f0f0f0;padding:3px 8px;border-radius:4px;text-decoration:none;color:#333">${escHtml(f.nombre)}</a>`).join('')}
        </div>
      </div>
    </div>`).join('');

  const transcriptHtml = state.transcript.map(s =>
    `<p style="margin-bottom:6px;font-size:13px;color:#555">
      <span style="color:#999;font-size:11px">[${formatTime(s.start)}]</span> ${escHtml(s.text)}
    </p>`
  ).join('');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>VerificaEC — ${escHtml(state.videoInfo?.title || 'Verificación')}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#1a1a1a}
  h1{color:#e63946;border-bottom:3px solid #e63946;padding-bottom:10px}
  .meta{color:#666;font-size:13px;margin-bottom:30px}
  .stats{display:flex;gap:10px;margin-bottom:30px;flex-wrap:wrap}
  .stat{padding:6px 14px;border-radius:4px;color:#fff;font-weight:700;font-size:13px}
  h2{margin:30px 0 16px;font-size:18px;color:#333}
  footer{margin-top:40px;padding-top:20px;border-top:1px solid #ddd;font-size:11px;color:#999}
</style>
</head>
<body>
<h1>VerificaEC — Verificador de Hechos</h1>
<div class="meta">
  ${state.videoInfo?.title ? `<strong>${escHtml(state.videoInfo.title)}</strong><br>` : ''}
  ${state.videoInfo?.url ? `<a href="${escHtml(state.videoInfo.url)}">${escHtml(state.videoInfo.url)}</a><br>` : ''}
  Generado: ${new Date().toLocaleString('es-PE')} · VerificaEC v1.0 · El Comercio Perú
</div>
<div class="stats">
  <div class="stat" style="background:#27ae60">✅ Verdadero: ${state.stats.verdadero}</div>
  <div class="stat" style="background:#e74c3c">❌ Falso: ${state.stats.falso}</div>
  <div class="stat" style="background:#e67e22">⚠️ Engañoso: ${state.stats.enganoso}</div>
  <div class="stat" style="background:#7f8c8d">❓ Incierto: ${state.stats.incierto}</div>
</div>
<h2>Afirmaciones verificadas (${approvedClaims.length})</h2>
${claimsHtml}
${state.transcript.length > 0 ? `<h2>Transcripción completa</h2>${transcriptHtml}` : ''}
<footer>
  Generado por VerificaEC — Herramienta de apoyo para fact-checking periodístico.<br>
  La IA sugiere veredictos; el periodista los revisa y aprueba antes de publicar.<br>
  El Comercio Perú · ${new Date().getFullYear()}
</footer>
</body></html>`;

  downloadFile(html, `verificaec_${Date.now()}.html`, 'text/html');
}

function exportJSON() {
  const exportData = {
    meta: {
      tool: 'VerificaEC',
      version: '1.0.0',
      generatedAt: new Date().toISOString(),
      videoTitle: state.videoInfo?.title,
      videoUrl: state.videoInfo?.url,
      stats: state.stats
    },
    claims: state.claims.filter(c => c.veredicto).map(c => ({
      '@context': 'https://schema.org',
      '@type': 'ClaimReview',
      claimReviewed: c.texto,
      reviewRating: {
        '@type': 'Rating',
        ratingValue: { VERDADERO: 1, ENGAÑOSO: 2, INCIERTO: 3, FALSO: 4 }[c.veredicto] || 3,
        bestRating: 1,
        worstRating: 4,
        alternateName: c.veredicto
      },
      author: { '@type': 'Organization', name: 'El Comercio Perú' },
      claimAppearance: { '@type': 'CreativeWork', url: state.videoInfo?.url },
      explanation: c.explicacion,
      confidence: c.confianza,
      sources: c.fuentes,
      speaker: c.speaker,
      timestamp: c.timestamp,
      auditStatus: c.auditStatus,
      topic: c.tema
    }))
  };
  downloadFile(JSON.stringify(exportData, null, 2), `verificaec_${Date.now()}.json`, 'application/json');
}

function exportTranscript() {
  if (state.transcript.length === 0) {
    alert('No hay transcripción disponible.');
    return;
  }
  const txt = state.transcript.map(s => `[${formatTime(s.start)}] ${s.speaker}: ${s.text}`).join('\n');
  downloadFile(txt, `transcripcion_${Date.now()}.txt`, 'text/plain');
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── UI HELPERS ───────────────────────────────────────────────────────────────
function setStatus(msg) {
  const el = document.getElementById('rate-text');
  if (el) el.textContent = msg;
}

function showProgress(visible, label = '', pct = 0) {
  const area = document.getElementById('progress-area');
  if (!visible) { area.classList.add('hidden'); return; }
  area.classList.remove('hidden');
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-fill').style.width = `${pct}%`;
}

function showVideoInfo(title) {
  const el = document.getElementById('video-info');
  document.getElementById('video-title-display').textContent = title;
  el.classList.remove('hidden');
}

function updateRateBar(used, max) {
  const fill = document.getElementById('rate-fill');
  const pct = Math.round((used / max) * 100);
  fill.style.width = `${pct}%`;
  fill.style.background = pct > 80 ? '#e74c3c' : pct > 50 ? '#e67e22' : '#27ae60';
  setStatus(`API: ${used}/${max} req/min`);
}

function setRunningState(running) {
  state.isRunning = running;
  document.getElementById('btn-start').classList.toggle('hidden', running);
  document.getElementById('btn-stop').classList.toggle('hidden', !running);
}

function updateExportVisibility() {
  const hasClaims = state.claims.some(c => c.veredicto);
  document.getElementById('export-area').classList.toggle('hidden', !hasClaims);
}

function validateSetup() {
  if (!state.apiKey) {
    alert(t('error_no_key'));
    document.getElementById('settings-panel').classList.remove('hidden');
    return false;
  }
  return true;
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── STORAGE ──────────────────────────────────────────────────────────────────
async function loadSettings() {
  const data = await chrome.storage.local.get(['apiKey', 'mode', 'interval']);
  if (data.apiKey) state.apiKey = data.apiKey;
  if (data.mode) state.mode = data.mode;
  if (data.interval) state.interval = parseInt(data.interval);

  document.getElementById('api-key-input').value = state.apiKey;
  document.getElementById('mode-select').value = state.mode;
  document.getElementById('interval-select').value = state.interval;
}

async function saveSettings() {
  state.apiKey = document.getElementById('api-key-input').value.trim();
  state.mode = document.getElementById('mode-select').value;
  state.interval = parseInt(document.getElementById('interval-select').value);
  await chrome.storage.local.set({ apiKey: state.apiKey, mode: state.mode, interval: state.interval });
  document.getElementById('settings-panel').classList.add('hidden');
  setStatus('Configuración guardada.');
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
async function init() {
  await loadI18n();
  await loadSettings();

  // Botones principales
  document.getElementById('btn-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.toggle('hidden');
  });
  document.getElementById('btn-close-settings').addEventListener('click', () => {
    document.getElementById('settings-panel').classList.add('hidden');
  });
  document.getElementById('btn-save-settings').addEventListener('click', saveSettings);

  document.getElementById('btn-start').addEventListener('click', () => {
    if (!validateSetup()) return;
    setRunningState(true);
    setStatus('Escuchando...');
    // El content script ya está capturando; aquí solo marcamos como running
    // y procesamos los mensajes que llegan
  });

  document.getElementById('btn-stop').addEventListener('click', () => {
    setRunningState(false);
    setStatus('Detenido.');
  });

  document.getElementById('btn-batch').addEventListener('click', runBatchAnalysis);

  // Exportación
  document.getElementById('btn-export-html').addEventListener('click', exportHTML);
  document.getElementById('btn-export-json').addEventListener('click', exportJSON);
  document.getElementById('btn-export-txt').addEventListener('click', exportTranscript);

  // Modal
  document.getElementById('modal-close').addEventListener('click', () => {
    document.getElementById('modal-overlay').classList.add('hidden');
  });
  document.getElementById('modal-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('modal-overlay')) {
      document.getElementById('modal-overlay').classList.add('hidden');
    }
  });

  // Modal de hablante
  document.getElementById('speaker-save-btn').addEventListener('click', () => {
    const name = document.getElementById('speaker-name-input').value.trim();
    if (name && speakerModalCallback) speakerModalCallback(name);
    document.getElementById('speaker-modal-overlay').classList.add('hidden');
  });
  document.getElementById('speaker-cancel-btn').addEventListener('click', () => {
    document.getElementById('speaker-modal-overlay').classList.add('hidden');
  });

  // View switcher
  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.currentView = btn.dataset.view;
      renderClaims();
    });
  });

  // Escuchar subtítulos del content script
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'NEW_CAPTION_SEGMENT' && state.isRunning) {
      processCaption(message.text);
    }
  });

  // Rate bar update periódico
  setInterval(async () => {
    const status = await chrome.runtime.sendMessage({ type: 'GET_RATE_STATUS' });
    updateRateBar(status.callsInWindow, status.limit);
  }, 3000);

  renderClaims();
}

document.addEventListener('DOMContentLoaded', init);
