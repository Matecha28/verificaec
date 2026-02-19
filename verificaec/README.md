# VerificaEC — Verificador de Hechos en Video con IA

> **Extensión de Chrome para fact-checking periodístico en tiempo real y análisis por lotes de videos de YouTube.**  
> Desarrollado para el equipo de datos de **El Comercio Perú**.

---

## ¿Qué es VerificaEC?

VerificaEC es una extensión de Chrome que ayuda a los periodistas a verificar afirmaciones en videos de YouTube en tiempo real o en modo análisis completo. Usa **Gemini 2.0 Flash** para identificar afirmaciones verificables y las contrasta con **fuentes oficiales peruanas e internacionales curadas**.

**Inspirado en** [live-fact-checker](https://github.com/alandaitch/live-fact-checker) de @alandaitch, mejorado con:
- Veredicto **ENGAÑOSO** (ausente en el original — crítico para periodismo)
- Router de fuentes peruanas: INEI, BCRP, SUNAT, JNE, Congreso, MINSA...
- **Dashboard de auditoría editorial**: la IA propone, el periodista aprueba
- Exportación HTML editorial-ready + JSON con schema **ClaimReview** (Google)
- Atribución y etiquetado de hablantes
- 100% en español peruano

---

## Veredictos

| Veredicto | Significado |
|-----------|-------------|
| ✅ **VERDADERO** | Confirmado por fuente primaria verificable |
| ❌ **FALSO** | Contradice directamente los datos oficiales |
| ⚠️ **ENGAÑOSO** | Técnicamente correcto pero omite contexto esencial, usa períodos o denominadores engañosos |
| ❓ **INCIERTO** | No hay datos suficientes para verificar |

---

## Instalación

### 1. Obtén una clave API de Gemini (gratis)

1. Ve a [Google AI Studio](https://aistudio.google.com/apikey)
2. Crea una clave gratuita
3. El nivel gratuito da **15 solicitudes/minuto** y **1.500/día** — suficiente para verificaciones en tiempo real

### 2. Descarga la extensión

**Opción A — Desde GitHub (recomendado):**
```bash
git clone https://github.com/Matecha28/verificaec.git
```

**Opción B — Descargar ZIP:**  
→ Botón verde "Code" → "Download ZIP" → Descomprime

### 3. Instala en Chrome

1. Abre `chrome://extensions/`
2. Activa **Modo desarrollador** (esquina superior derecha)
3. Haz clic en **Cargar descomprimida**
4. Selecciona la carpeta `verificaec`

### 4. Configura tu clave

1. Abre un video de YouTube
2. Haz clic en el ícono de VerificaEC en la barra de Chrome
3. Haz clic en ⚙️ y pega tu clave API de Gemini
4. Guarda

---

## Uso

### Verificación en tiempo real

1. Abre un **video o transmisión en vivo de YouTube** con subtítulos activados
2. Abre el panel lateral de VerificaEC (clic en el ícono)
3. Presiona **▶ Iniciar verificación**
4. Las afirmaciones se identifican y verifican automáticamente conforme avanza el video
5. Revisa cada veredicto y **aprueba o modifica** antes de publicar

### Análisis por lotes (video completo)

1. Abre cualquier video de YouTube (no necesita estar en vivo)
2. Haz clic en **⚡ Analizar video completo**
3. El sistema extrae la transcripción y la procesa en dos fases:
   - **Fase 1 (0–40%)**: Identifica todas las afirmaciones
   - **Fase 2 (40–100%)**: Verifica cada una con fuentes curadas
4. Revisa, aprueba y exporta el informe

### Etiquetar hablantes

- Haz clic en el nombre del hablante (👤) en cualquier afirmación
- Escribe el nombre real del hablante
- Se aplica automáticamente a todas sus afirmaciones en la sesión

### Exportar informe

Una vez que hayas aprobado las verificaciones:
- **📄 Exportar HTML**: Informe listo para publicar o incrustar en el CMS
- **{ } Exportar JSON**: Formato ClaimReview para Google y bases de datos
- **📝 Transcripción TXT**: Transcripción completa con timestamps

---

## Fuentes curadas

### Nivel 1 — Oficiales peruanas (máxima prioridad)
| Institución | Datos |
|-------------|-------|
| INEI | Estadísticas poblacionales, pobreza, economía |
| BCRP | Inflación, PBI, tipo de cambio |
| MEF | Presupuesto público, deuda |
| SUNAT | Recaudación, comercio exterior |
| Congreso | Leyes, votaciones, asistencias |
| JNE | Resultados electorales, candidatos |
| MINSA | Salud, epidemiología |
| MINEDU/ESCALE | Estadísticas educativas |
| OSINERGMIN | Precios combustibles, tarifas |

### Nivel 2 — Fact-checkers verificados
Chequeado · Factchequeado · AFP Factual · Reuters Fact Check · El Comercio Verificador

### Nivel 3 — Internacionales
Banco Mundial · FMI · CEPAL · OPS · PNUD

---

## Arquitectura

```
verificaec/
├── manifest.json          # Manifest V3
├── background.js          # Service worker: mensajes, transcripción, rate limiter
├── content.js             # Content script: captura subtítulos YouTube
├── sidepanel.html         # UI del panel lateral
├── sidepanel.css          # Tema oscuro
├── sidepanel.js           # Lógica: estado, Gemini API, auditoría, exportación
├── whisper-sandbox.html   # Sandbox para transcripción local con Whisper.js
├── sources-config.json    # Fuentes curadas y router temático
├── i18n/
│   └── es-PE.json         # Traducciones español peruano
└── icons/                 # Íconos 16, 48, 128px
```

---

## Configuración

| Ajuste | Opciones | Por defecto |
|--------|----------|-------------|
| Modo | Tiempo real / Análisis completo / Micrófono | Tiempo real |
| Intervalo | ~5s / ~10s / ~20s | ~10s |
| Idioma | Español peruano | es-PE |

---

## Límites de API (nivel gratuito de Gemini)

| Límite | Valor |
|--------|-------|
| Solicitudes por minuto | 15 RPM |
| Solicitudes por día | 1.500 RPD |
| Tokens por minuto | 1.000.000 TPM |

VerificaEC usa un rate limiter interno que se mantiene en 12 RPM para dar margen.

---

## Principio editorial

> **La IA sugiere. El periodista decide y publica.**

Todos los veredictos exportados incluyen el estado de auditoría (aprobado / modificado / omitido). Ninguna afirmación se exporta sin que el periodista la haya revisado.

---

## Stack tecnológico

- **Gemini 2.0 Flash** — Identificación de afirmaciones y verificación con Google Search Grounding
- **Whisper.js** (Xenova/whisper-tiny via transformers.js) — Transcripción local de audio
- **Chrome Side Panel API** — Panel lateral nativo de Chrome
- **Manifest V3** — Estándar actual de extensiones de Chrome
- **Schema.org ClaimReview** — Estándar de Google para fact-checks en buscadores

---

## Créditos

- Basado en [live-fact-checker](https://github.com/alandaitch/live-fact-checker) de @alandaitch (MIT)
- Desarrollado para El Comercio Perú — Unidad de Datos
- Mantenido por [@Matecha28](https://github.com/Matecha28)

---

## Licencia

MIT — Ver [LICENSE](LICENSE)

---

*VerificaEC es una herramienta de apoyo periodístico. Los veredictos generados por IA deben ser revisados y aprobados por un periodista antes de su publicación.*
