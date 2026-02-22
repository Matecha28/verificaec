# Verificador EC — El Comercio Perú

Extensión de Chrome para verificación periodística de hechos en tiempo real, adaptada para el ecosistema informativo peruano.

Basada en [Live Fact Checker](https://github.com/alandaitch/live-fact-checker) por [@alandaitch](https://twitter.com/alandaitch).

## ¿Qué hace diferente a esta versión?

- **Branding El Comercio** — colores azul y rojo EC, logo, footer institucional
- **Fuentes peruanas prioritarias** — el prompt de verificación prioriza: INEI, BCRP, MEF, ONPE, JNE, Congreso, Ojo Público, RPP, La República, Peru21, IDL Reporteros
- **Busca en elcomercio.pe** — el Verificador EC busca en el archivo del propio diario
- **Badges de fuentes** — las fuentes en el reporte se clasifican como: 🔴 El Comercio / 🔵 Oficial (INEI, etc.) / 🟡 Medio / Otro
- **Idioma español por defecto** — con locale `es-PE` en el reconocimiento de voz
- **Exportación mejorada** — reporte HTML con branding EC, nota de responsabilidad editorial
- **Aviso de revisión** — el reporte exportado incluye: *"Este reporte es un apoyo periodístico. Las conclusiones deben ser revisadas por un periodista antes de su publicación."*

## Instalación

1. **Obtén una API key de Gemini** en [Google AI Studio](https://aistudio.google.com/apikey) (gratuita)

2. **Carga la extensión en Chrome**:
   - Ve a `chrome://extensions/`
   - Activa el **Modo desarrollador** (switch arriba a la derecha)
   - Haz clic en **Cargar descomprimida** y selecciona esta carpeta

3. **Agrega los íconos** (ver sección Íconos abajo)

4. **Configura**:
   - Abre el panel lateral haciendo clic en el ícono de la extensión
   - Haz clic en ⚙️ y pega tu clave API de Gemini
   - Elige el modo de transcripción

## Uso

### Verificación en tiempo real (debates, conferencias, live streams)
1. Abre el video de YouTube (o cualquier pestaña con audio)
2. Haz clic en el ícono de la extensión para abrir el panel lateral
3. Presiona **Iniciar Verificación**
4. Las afirmaciones se identifican y verifican en tiempo real

### Análisis de video completo (ya publicado)
1. Abre cualquier video de YouTube
2. Haz clic en **⚡ Analizar Video**
3. La extensión obtiene la transcripción completa y la procesa en dos fases:
   - Fase 1 (0–40%): Identifica todas las afirmaciones
   - Fase 2 (40–100%): Verifica cada afirmación con Google Search

### Exportar reporte
Haz clic en **Exportar** para descargar un reporte HTML autocontenido con:
- Todas las afirmaciones con veredicto (VERDADERO / FALSO / INCIERTO)
- Fuentes clasificadas (El Comercio, Oficial, Medio)
- Transcripción completa con afirmaciones resaltadas
- Metadatos del evento

## Íconos

Necesitas crear o agregar íconos en la carpeta `icons/`:
- `icons/icon16.png` (16×16 px)
- `icons/icon48.png` (48×48 px)  
- `icons/icon128.png` (128×128 px)

Sugerencia: usar el logo de El Comercio o diseñar un ícono con las iniciales "EC" en rojo sobre fondo oscuro.

## Modos de transcripción

| Modo | Descripción | Mejor para |
|---|---|---|
| Subtítulos YouTube | Lee los CC directamente de la página | Videos de YouTube con subtítulos |
| Audio de pestaña (Whisper) | Captura el audio y transcribe localmente (~75MB descarga única) | Cualquier pestaña, streams sin CC |
| Micrófono | Web Speech API vía tu micrófono | Audio externo, televisión |

## Fuentes de verificación incluidas en el prompt

| Fuente | Tipo | Uso |
|---|---|---|
| INEI (inei.gob.pe) | Oficial | Pobreza, PBI, demografía, empleo |
| BCRP (bcrp.gob.pe) | Oficial | Inflación, tipo de cambio, reservas |
| MEF (mef.gob.pe) | Oficial | Presupuesto, deuda, gasto público |
| ONPE / JNE | Oficial | Resultados electorales, normativa |
| Congreso (congreso.gob.pe) | Oficial | Votaciones, leyes |
| El Comercio (elcomercio.pe) | EC | Verificaciones previas, archivo |
| Ojo Público | Medio | Investigaciones periodísticas |
| RPP, La República, Peru21 | Medio | Contexto noticioso |
| Banco Mundial, FMI, CEPAL | Internacional | Indicadores comparados |

## Límites de la API gratuita de Gemini

| Límite | Valor |
|---|---|
| Solicitudes por minuto | 15 RPM |
| Solicitudes por día | 1,500 RPD |
| Tokens por minuto | 1,000,000 TPM |

La extensión gestiona automáticamente estos límites con un rate limiter de ventana deslizante.

## Arquitectura

```
verificador-ec/
├── manifest.json           # Config Manifest V3
├── background.js           # Service worker: routing, extracción de transcripción
├── content.js              # Script de contenido: captura de CC de YouTube
├── sidepanel.html          # UI del panel lateral (branding EC)
├── sidepanel.css           # Estilos oscuros con colores EC
├── sidepanel.js            # Lógica principal: estado, API, rate limiter, exportación
├── whisper-sandbox.html    # Iframe sandboxed para Whisper local
└── icons/                  # Íconos de la extensión (16, 48, 128px)
```

## Créditos

Adaptado por El Comercio Perú a partir de [Live Fact Checker](https://github.com/alandaitch/live-fact-checker) de [@alandaitch](https://twitter.com/alandaitch).

Motor de verificación: [Gemini 2.0 Flash](https://ai.google.dev/) con Google Search grounding  
Transcripción de audio: [Whisper](https://huggingface.co/Xenova/whisper-tiny) vía [transformers.js](https://github.com/xenova/transformers.js)

## Licencia

MIT — ver [LICENSE](LICENSE)
