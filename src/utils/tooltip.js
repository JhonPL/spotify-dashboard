/**
 * tooltip.js — Tooltip global reutilizable
 *
 * Un único elemento DOM compartido entre todos los gráficos.
 * API:
 *   tooltip.show(event, html)   — mostrar con contenido HTML
 *   tooltip.move(event)         — mover siguiendo el cursor
 *   tooltip.hide()              — ocultar
 *   tooltip.html(data, config)  — generar HTML estándar del dashboard
 *
 * Uso:
 *   import tooltip from "../utils/tooltip.js";
 *   ...
 *   .on("mouseover", (event, d) => tooltip.show(event, tooltip.html({...})))
 *   .on("mousemove", (event)    => tooltip.move(event))
 *   .on("mouseleave",()         => tooltip.hide())
 */

// El elemento ya existe en index.html: <div class="tooltip" id="global-tooltip">
const el = document.getElementById("global-tooltip");

// Margen de separación respecto al cursor (px)
const OFFSET_X = 14;
const OFFSET_Y = -10;

// ─── Posición segura: evitar que se salga de la ventana ─────────────────────
function safePosition(clientX, clientY) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Dimensiones reales del tooltip (ya renderizadas)
  const rect = el.getBoundingClientRect();
  const w = rect.width  || 220;
  const h = rect.height || 80;

  let x = clientX + OFFSET_X;
  let y = clientY + OFFSET_Y;

  // No salir por la derecha
  if (x + w > vw - 8) x = clientX - w - OFFSET_X;
  // No salir por abajo
  if (y + h > vh - 8) y = vh - h - 8;
  // No salir por arriba
  if (y < 8) y = 8;

  return { x, y };
}

// ─── API pública ─────────────────────────────────────────────────────────────

/**
 * Muestra el tooltip con contenido HTML en la posición del evento.
 * @param {MouseEvent} event
 * @param {string} html — contenido HTML interno
 */
function show(event, html) {
  el.innerHTML = html;
  el.classList.add("visible");

  const { x, y } = safePosition(event.clientX, event.clientY);
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
}

/**
 * Mueve el tooltip siguiendo el cursor (usar en mousemove).
 * @param {MouseEvent} event
 */
function move(event) {
  if (!el.classList.contains("visible")) return;
  const { x, y } = safePosition(event.clientX, event.clientY);
  el.style.left = `${x}px`;
  el.style.top  = `${y}px`;
}

/**
 * Oculta el tooltip.
 */
function hide() {
  el.classList.remove("visible");
}

// ─── Generadores de HTML estándar ────────────────────────────────────────────

/**
 * Tooltip genérico del dashboard.
 *
 * @param {Object} config
 * @param {string}  config.title       — título principal (negrita)
 * @param {string}  [config.subtitle]  — subtítulo gris bajo el título
 * @param {string}  [config.color]     — color del punto de acento (•)
 * @param {Array}   [config.rows]      — [{ key, value, color? }] filas de datos
 * @param {string}  [config.footer]    — texto pequeño al pie
 *
 * @returns {string} HTML
 */
function html({ title, subtitle, color, rows = [], footer } = {}) {
  let out = "";

  // Título
  if (title) {
    const dot = color
      ? `<span style="color:${color};margin-right:6px">●</span>`
      : "";
    out += `<div class="tooltip-title">${dot}${escHtml(title)}</div>`;
  }

  // Subtítulo
  if (subtitle) {
    out += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px">${escHtml(subtitle)}</div>`;
  }

  // Filas key → value
  rows.forEach(({ key, value, color: rowColor }) => {
    const valStyle = rowColor ? `color:${rowColor}` : "color:var(--spotify-green)";
    out += `
      <div class="tooltip-row">
        <span class="tooltip-key">${escHtml(key)}</span>
        <span class="tooltip-val" style="${valStyle}">${escHtml(String(value))}</span>
      </div>`;
  });

  // Footer
  if (footer) {
    out += `<div style="font-size:10px;color:var(--text-hint);margin-top:6px;border-top:1px solid var(--border-subtle);padding-top:5px">${escHtml(footer)}</div>`;
  }

  return out;
}

/**
 * Tooltip específico para un género (treemap, heatmap, radar…).
 *
 * @param {Object} d  — objeto del género (genres_summary)
 * @param {string} color
 * @returns {string} HTML
 */
function genreHtml(d, color) {
  return html({
    title:    d.track_genre,
    color,
    rows: [
      { key: "Tracks",       value: d.count?.toLocaleString("es") ?? "—" },
      { key: "Popularidad",  value: fmt1(d.popularity) },
      { key: "Energy",       value: fmt2(d.energy) },
      { key: "Danceability", value: fmt2(d.danceability) },
      { key: "Valence",      value: fmt2(d.valence) },
    ],
  });
}

/**
 * Tooltip para una canción individual (scatterplot, hexbin…).
 *
 * @param {Object} d — objeto del sample
 * @param {string} color
 * @returns {string} HTML
 */
function trackHtml(d, color) {
  return html({
    title:    d.track_name,
    subtitle: d.artists,
    color,
    rows: [
      { key: "Género",       value: d.track_genre },
      { key: "Popularidad",  value: d.popularity },
      { key: "Energy",       value: fmt2(d.energy) },
      { key: "Danceability", value: fmt2(d.danceability) },
      { key: "Valence",      value: fmt2(d.valence) },
      { key: "Tempo",        value: `${Math.round(d.tempo)} BPM` },
    ],
  });
}

/**
 * Tooltip para un artista (bubble, force graph…).
 *
 * @param {Object} d — objeto del artista
 * @param {string} color
 * @returns {string} HTML
 */
function artistHtml(d, color) {
  return html({
    title:    d.artist,
    subtitle: `Género: ${d.genres}`,
    color,
    rows: [
      { key: "Tracks",       value: d.track_count },
      { key: "Popularidad",  value: fmt1(d.popularity) },
      { key: "Energy",       value: fmt2(d.energy) },
      { key: "Danceability", value: fmt2(d.danceability) },
      { key: "Valence",      value: fmt2(d.valence) },
    ],
  });
}

// ─── Helpers internos ────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const fmt1 = (v) => v != null ? Number(v).toFixed(1) : "—";
const fmt2 = (v) => v != null ? Number(v).toFixed(2) : "—";

// ─── Exportar ────────────────────────────────────────────────────────────────

export default { show, move, hide, html, genreHtml, trackHtml, artistHtml };