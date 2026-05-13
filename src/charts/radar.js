/**
 * radar.js — Radar Chart de perfil de género v1
 *
 * Muestra el perfil de audio de uno o dos géneros superpuestos sobre
 * los mismos 7 ejes de features. Diseño tipo "spider web" premium.
 *
 * Features:
 *   - Hasta 2 géneros comparados simultáneamente (A vs B)
 *   - Selector primario + selector de comparación opcional
 *   - Polígonos rellenos semitransparentes con stroke animado
 *   - Animación de entrada: los polígonos "crecen" desde el centro
 *   - Puntos de control en cada eje con tooltip individual por eje
 *   - Recibe genre:select del bus → actualiza el género primario
 *   - Fondo con anillos concéntricos y etiquetas de nivel (0.25 / 0.5 / 0.75 / 1.0)
 *   - Etiquetas de eje con iconos de color por feature (FEATURE_COLORS)
 *   - ResizeObserver con debounce
 *   - Emite genre:select al clicar en la leyenda (linked views)
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import {
  genreColor, initGenreScale,
  FEATURE_LABELS, FEATURE_COLORS, fmt,
} from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const TRANSITION  = 450;
const DEBOUNCE_MS = 380;

// Los 7 ejes del radar (todos en rango [0,1] en el dataset)
const AXES = [
  "danceability",
  "energy",
  "valence",
  "acousticness",
  "speechiness",
  "liveness",
  "instrumentalness",
];

// Niveles de referencia del fondo (0 → 1)
const LEVELS = [0.25, 0.5, 0.75, 1.0];

// ─── Estado del módulo ────────────────────────────────────────────────────────
let _container    = null;
let _svg          = null;
let _gWeb         = null;   // anillos + ejes del fondo
let _gPolygons    = null;   // polígonos de los géneros
let _gDots        = null;   // puntos de control
let _gLabels      = null;   // etiquetas de eje
let _center       = { x: 0, y: 0 };
let _radius       = 0;
let _resizeObs    = null;
let _unsubs       = [];
let _prevW        = 0;
let _prevH        = 0;
let _statsWrap    = null;

// Géneros seleccionados para el radar
let _genreA       = null;   // primario (puede venir del bus)
let _genreB       = null;   // comparación (solo desde el select local)

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initRadar(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  const data = store.getData("genresSummary");
  if (!data) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "genresSummary") return;
      unsub();
      _container.classList.remove("loading");
      _build();
    });
    return;
  }
  _build();
}

// ─── Build ────────────────────────────────────────────────────────────────────
function _build() {
  const data = store.getData("genresSummary");
  if (!data || !_container) return;

  const { w, h } = _dims();
  _prevW = w;
  _prevH = h;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  initGenreScale(data.map(d => d.track_genre));

  // Género por defecto: el de mayor popularidad
  if (!_genreA) {
    _genreA = [...data].sort((a, b) => b.popularity - a.popularity)[0]?.track_genre ?? null;
  }

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles ─────────────────────────────────────────────────────────────
  _buildControls(data);

  // ── Layout Split ──────────────────────────────────────────────────────────
  const CTRL_H = 36;
  const bodyWrap = document.createElement("div");
  bodyWrap.style.cssText = `position:absolute;top:${CTRL_H}px;left:0;width:100%;height:calc(100% - ${CTRL_H}px);display:flex;flex-direction:row;`;
  _container.appendChild(bodyWrap);

  const chartWrap = document.createElement("div");
  chartWrap.style.cssText = `flex: 1; position: relative; overflow: hidden;`;
  bodyWrap.appendChild(chartWrap);

  _statsWrap = document.createElement("div");
  _statsWrap.style.cssText = `width: 200px; border-left: 1px solid var(--border-subtle); background: var(--glass-medium); overflow-y: auto; padding: 16px;`;
  bodyWrap.appendChild(_statsWrap);

  // ── Dimensiones ───────────────────────────────────────────────────────────
  const chartW = Math.max(w - 200, 200);
  const chartH = h - CTRL_H;

  const PADDING    = 75; // Medida perfecta para "Instrumentalness" sin encoger el gráfico
  const available  = Math.min(chartW, chartH) - PADDING * 2;
  _radius          = Math.max(available / 2, 80);
  _center          = { x: chartW / 2, y: chartH / 2 + 8 };

  _svg = d3.select(chartWrap)
    .append("svg")
    .style("position", "absolute")
    .style("top", "0")
    .style("left", "0")
    .style("width", "100%")
    .style("height", "100%")
    .attr("viewBox", `0 0 ${chartW} ${chartH}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Grupos en orden de capas (fondo → polígonos → dots → labels)
  _gWeb      = _svg.append("g").attr("class", "radar-web");
  _gPolygons = _svg.append("g").attr("class", "radar-polygons");
  _gDots     = _svg.append("g").attr("class", "radar-dots");
  _gLabels   = _svg.append("g").attr("class", "radar-labels");

  _drawWeb();
  _drawLabels();
  _drawPolygons(data, true);
  _buildStats(data);

  // ── Listeners globales ────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _genreA = genre;
      _drawPolygons(data, false);
      _buildStats(data);
      _syncSelects();
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _genreB = null;
      _drawPolygons(data, false);
      _buildStats(data);
      _syncSelects();
    })
  );

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Web de fondo (anillos + líneas de eje) ───────────────────────────────────
function _drawWeb() {
  _gWeb.selectAll("*").remove();

  const n = AXES.length;

  // Anillos concéntricos
  LEVELS.reverse().forEach((level, i) => { // Renderizar de afuera hacia adentro para superponer fills
    const points = _polygonPoints(level);
    _gWeb.append("polygon")
      .attr("points",        points.map(p => `${p.x},${p.y}`).join(" "))
      .attr("fill",          i % 2 === 0 ? "var(--glass-subtle)" : "transparent")
      .attr("stroke",        level === 1.0 ? "var(--glass-strong)" : "var(--glass-soft)")
      .attr("stroke-width",  level === 1.0 ? 1.5 : 1)
      .attr("stroke-dasharray", level === 1.0 ? "none" : "4 4");
  });
  LEVELS.reverse(); // Restaurar orden original por si acaso

  // Líneas desde el centro a cada vértice
  _polygonPoints(1.0).forEach((pt, i) => {
    _gWeb.append("line")
      .attr("x1", _center.x).attr("y1", _center.y)
      .attr("x2", pt.x)     .attr("y2", pt.y)
      .attr("stroke",       "var(--glass-medium)")
      .attr("stroke-width", 1);
  });
}

// ─── Etiquetas de eje ─────────────────────────────────────────────────────────
function _drawLabels() {
  _gLabels.selectAll("*").remove();

  const outerPoints = _polygonPoints(1.0);
  const LABEL_PAD   = 14;

  AXES.forEach((axis, i) => {
    const pt    = outerPoints[i];
    const angle = _axisAngle(i);   // radianes desde arriba

    // Dirección de empuje para la etiqueta
    const dx = Math.sin(angle);
    const dy = -Math.cos(angle);

    const lx = pt.x + dx * LABEL_PAD;
    const ly = pt.y + dy * LABEL_PAD;

    // Ancla de texto según cuadrante
    const anchor = Math.abs(dx) < 0.1 ? "middle"
      : dx > 0 ? "start" : "end";

    const label = _gLabels.append("g")
      .attr("class", "radar-axis-label")
      .style("cursor", "default");

    // Pastilla de color del feature
    label.append("circle")
      .attr("cx",   lx + (dx > 0 ? -6 : dx < 0 ? 6 : 0) - (anchor === "start" ? 6 : anchor === "end" ? -6 : 0))
      .attr("cy",   ly)
      .attr("r",    3.5)
      .attr("fill", FEATURE_COLORS[axis] || "var(--spotify-green)");

    label.append("text")
      .attr("x",            lx)
      .attr("y",            ly + 4)
      .attr("text-anchor",  anchor)
      .attr("font-size",    "10px")
      .attr("font-weight",  "600")
      .attr("fill",         "var(--text-primary)")
      .text(FEATURE_LABELS[axis] || axis);
  });

  // Etiquetas de escala interna (ej. 0.25, 0.50, 0.75) por encima de los polígonos
  LEVELS.forEach(level => {
    if (level >= 1.0 || level <= 0) return;
    const ly = _center.y - _radius * level;
    
    // Pastilla de fondo
    _gLabels.append("rect")
      .attr("x", _center.x - 12)
      .attr("y", ly - 7)
      .attr("width", 24)
      .attr("height", 14)
      .attr("rx", 7)
      .attr("fill", "var(--bg-panel)")
      .attr("stroke", "var(--border-subtle)")
      .attr("stroke-width", 1)
      .style("pointer-events", "none");

    // Texto del nivel
    _gLabels.append("text")
      .attr("x", _center.x)
      .attr("y", ly + 0.5) // ajuste óptico para alinear al medio de la pastilla
      .attr("font-size", "8.5px")
      .attr("font-weight", "700")
      .attr("fill", "var(--text-secondary)")
      .attr("text-anchor", "middle")
      .attr("dominant-baseline", "middle")
      .style("pointer-events", "none")
      .text(level.toFixed(2));
  });
}

// ─── Polígonos de géneros ─────────────────────────────────────────────────────
function _drawPolygons(data, isInitial) {
  _gPolygons.selectAll("*").remove();
  _gDots.selectAll("*").remove();

  const genresData = [];
  if (_genreA) {
    const d = data.find(g => g.track_genre === _genreA);
    if (d) genresData.push({ d, isA: true });
  }
  if (_genreB && _genreB !== _genreA) {
    const d = data.find(g => g.track_genre === _genreB);
    if (d) genresData.push({ d, isA: false });
  }

  if (!genresData.length) {
    _drawPlaceholder();
    return;
  }

  genresData.forEach(({ d, isA }, gi) => {
    const color   = genreColor(d.track_genre);
    const values  = AXES.map(ax => +d[ax] ?? 0);
    const pts     = values.map((v, i) => _pointOnAxis(i, v));

    const polyStr = pts.map(p => `${p.x},${p.y}`).join(" ");

    // ── Área rellena ───────────────────────────────────────────────────────
    const poly = _gPolygons.append("polygon")
      .attr("class",        `radar-poly radar-poly-${isA ? "a" : "b"}`)
      .attr("data-genre",   d.track_genre)
      .attr("points",       polyStr)
      .attr("fill",         color)
      .attr("fill-opacity", isA ? 0.45 : 0.25)
      .attr("stroke",       color)
      .attr("stroke-width", isA ? 2.5 : 1.5)
      .attr("stroke-opacity", 0)
      .style("cursor",      "pointer")
      .on("mouseenter", function() {
        d3.select(this)
          .attr("fill-opacity",   isA ? 0.6 : 0.4)
          .attr("stroke-width",   isA ? 3 : 2)
          .attr("stroke-opacity", 1);
      })
      .on("mouseleave", function() {
        d3.select(this)
          .attr("fill-opacity",   isA ? 0.45 : 0.25)
          .attr("stroke-width",   isA ? 2.5 : 1.5)
          .attr("stroke-opacity", 1);
      })
      .on("click", () => {
        if (!isA) return; // La comparación no dispara filtro global
        if (store.get("filters.genre") === d.track_genre) clearAllFilters();
        else selectGenre(d.track_genre);
      });

    if (isInitial) {
      // Animación: crecer desde el centro
      poly
        .attr("transform",   `scale(0)`)
        .attr("transform-origin", `${_center.x}px ${_center.y}px`)
        .attr("stroke-opacity", 0)
        .transition().duration(TRANSITION).delay(gi * 120)
        .ease(d3.easeBackOut.overshoot(0.6))
        .attr("transform",      "scale(1)")
        .attr("stroke-opacity", 1);
    } else {
      poly.attr("stroke-opacity", 1);
    }

    // ── Puntos de control en cada eje ──────────────────────────────────────
    pts.forEach((pt, axIdx) => {
      const axisName = AXES[axIdx];
      const val      = values[axIdx];

      const dot = _gDots.append("circle")
        .attr("class",        "radar-dot")
        .attr("data-genre",   d.track_genre)
        .attr("cx",           pt.x)
        .attr("cy",           pt.y)
        .attr("r",            isInitial ? 0 : 3.5)
        .attr("fill",         color)
        .attr("stroke",       "var(--bg-base)")
        .attr("stroke-width", 1.5)
        .style("cursor",      "crosshair")
        .on("mouseenter", function(event) {
          d3.select(this).attr("r", 5.5);
          tooltip.show(event, tooltip.html({
            title:    d.track_genre,
            color,
            rows: [
              { key: FEATURE_LABELS[axisName] || axisName, value: fmt(val, 3), color },
              { key: "Popularidad", value: fmt(d.popularity, 1) },
            ],
            footer: isA ? "Género principal" : "Género de comparación",
          }));
        })
        .on("mousemove",  event => tooltip.move(event))
        .on("mouseleave", function() {
          d3.select(this).attr("r", 3.5);
          tooltip.hide();
        });

      if (isInitial) {
        dot.transition()
          .duration(TRANSITION * 0.6)
          .delay(gi * 120 + TRANSITION * 0.5)
          .attr("r", 3.5);
      }
    });
  });
}

// ─── Placeholder cuando no hay género seleccionado ────────────────────────────
function _drawPlaceholder() {
  _gPolygons.append("text")
    .attr("x",           _center.x)
    .attr("y",           _center.y + 4)
    .attr("text-anchor", "middle")
    .attr("font-size",   "12px")
    .attr("fill",        "var(--text-hint)")
    .text("Selecciona un género en el treemap");
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls(data) {
  const sorted = [...data].sort((a, b) =>
    a.track_genre.localeCompare(b.track_genre)
  );

  const bar = document.createElement("div");
  bar.className  = "radar-controls";
  bar.style.cssText = `
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 14px;
    height: 36px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
  `;

  // Select A (primario)
  const selA = _makeSelect("Género A", sorted, _genreA, val => {
    _genreA = val || null;
    const d = store.getData("genresSummary");
    if (d) _drawPolygons(d, false);
    if (_genreA) selectGenre(_genreA);
    else clearAllFilters();
  }, "var(--spotify-green)");

  // Separador
  const vs = document.createElement("span");
  vs.textContent  = "vs";
  vs.style.cssText = "color:var(--text-hint);font-size:10px;font-weight:600;";

  // Select B (comparación)
  const selB = _makeSelect("Género B (opcional)", sorted, _genreB, val => {
    _genreB = val || null;
    const d = store.getData("genresSummary");
    if (d) {
      _drawPolygons(d, false);
      _buildStats(d);
    }
  }, "var(--accent-blue)", true);

  // Hint
  const hint = document.createElement("span");
  hint.id            = "radar-selects-hint";
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);";
  hint.textContent   = "Hover en punto para detalle · Clic para filtrar";

  bar.appendChild(selA);
  bar.appendChild(vs);
  bar.appendChild(selB);
  bar.appendChild(hint);
  _container.appendChild(bar);
}

function _makeSelect(placeholder, sorted, current, onChange, accentColor, allowEmpty = false) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:5px;";

  // Punto de color
  const dot = document.createElement("span");
  dot.style.cssText = `
    width: 7px; height: 7px;
    border-radius: 50%;
    background: ${accentColor};
    flex-shrink: 0;
  `;

  const sel = document.createElement("select");
  sel.id = "radar-sel-" + Math.random().toString(36).slice(2, 6);
  sel.style.cssText = `
    background: var(--bg-elevated);
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    color: var(--text-primary);
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
    outline: none;
    max-width: 160px;
  `;

  if (allowEmpty) {
    const emptyOpt   = document.createElement("option");
    emptyOpt.value   = "";
    emptyOpt.text    = placeholder;
    emptyOpt.selected = !current;
    sel.appendChild(emptyOpt);
  }

  sorted.forEach(g => {
    const opt   = document.createElement("option");
    opt.value   = g.track_genre;
    opt.text    = g.track_genre;
    if (g.track_genre === current) opt.selected = true;
    sel.appendChild(opt);
  });

  sel.addEventListener("change", e => onChange(e.target.value));
  sel.dataset.radarSelect = "true";

  wrap.appendChild(dot);
  wrap.appendChild(sel);
  return wrap;
}

// ─── Sincronizar selects con estado externo (genre:select del bus) ────────────
function _syncSelects() {
  const sels = _container.querySelectorAll("[data-radar-select]");
  if (sels[0] && _genreA !== undefined) sels[0].value = _genreA ?? "";
  if (sels[1] && _genreB !== undefined) sels[1].value = _genreB ?? "";
}

// ─── Panel Lateral de Estadísticas ────────────────────────────────────────────
function _buildStats(data) {
  if (!_statsWrap) return;
  _statsWrap.innerHTML = "";

  if (!_genreA) {
    _statsWrap.innerHTML = `<div style="color:var(--text-hint);font-size:12px;text-align:center;margin-top:20px;">Selecciona un género</div>`;
    return;
  }

  const dA = data.find(g => g.track_genre === _genreA);
  const dB = _genreB ? data.find(g => g.track_genre === _genreB) : null;
  const colorA = genreColor(_genreA);
  const colorB = dB ? genreColor(_genreB) : null;

  const title = document.createElement("div");
  title.style.cssText = "font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:20px;text-transform:uppercase;letter-spacing:1px;";
  title.textContent = "Perfil de Audio";
  _statsWrap.appendChild(title);

  AXES.forEach(ax => {
    const valA = dA[ax] || 0;
    const valB = dB ? (dB[ax] || 0) : null;

    const block = document.createElement("div");
    block.style.cssText = "margin-bottom: 16px;";

    // Header
    const header = document.createElement("div");
    header.style.cssText = "display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:11px;";

    const name = document.createElement("div");
    name.style.cssText = `color:${FEATURE_COLORS[ax] || 'var(--text-secondary)'};font-weight:600;`;
    name.textContent = FEATURE_LABELS[ax] || ax;

    const vals = document.createElement("div");
    vals.style.cssText = "display:flex;gap:8px;font-weight:700;font-variant-numeric: tabular-nums;";
    vals.innerHTML = `<span style="color:${colorA}">${fmt(valA, 2)}</span>` + 
                     (dB ? `<span style="color:${colorB}">${fmt(valB, 2)}</span>` : "");

    header.appendChild(name);
    header.appendChild(vals);
    block.appendChild(header);

    // Barra A
    const barA = document.createElement("div");
    barA.style.cssText = `height:6px;background:var(--glass-soft);border-radius:3px;overflow:hidden;margin-bottom:${dB ? '2px' : '0'};`;
    barA.innerHTML = `<div style="height:100%;width:${valA * 100}%;background:${colorA};border-radius:3px;transition:width 0.4s ease;"></div>`;
    block.appendChild(barA);

    // Barra B
    if (dB) {
      const barB = document.createElement("div");
      barB.style.cssText = `height:6px;background:var(--glass-soft);border-radius:3px;overflow:hidden;`;
      barB.innerHTML = `<div style="height:100%;width:${valB * 100}%;background:${colorB};border-radius:3px;transition:width 0.4s ease;"></div>`;
      block.appendChild(barB);
    }

    _statsWrap.appendChild(block);
  });
}

// ─── Helpers geométricos ──────────────────────────────────────────────────────

/** Ángulo en radianes del eje i (empezando desde arriba, sentido horario) */
function _axisAngle(i) {
  return (2 * Math.PI * i) / AXES.length - Math.PI / 2;
}

/** Punto en el eje i a una fracción [0,1] del radio */
function _pointOnAxis(i, value) {
  const angle = _axisAngle(i);
  return {
    x: _center.x + _radius * value * Math.cos(angle),
    y: _center.y + _radius * value * Math.sin(angle),
  };
}

/** Array de puntos del polígono a un nivel [0,1] dado */
function _polygonPoints(level) {
  return AXES.map((_, i) => _pointOnAxis(i, level));
}

// ─── Rebuild en resize ────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return; // Prevent building when hidden
  if (Math.abs(w - _prevW) < 6 && Math.abs(h - _prevH) < 6) return;
  _build();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 200), h: Math.max(r.height, 200) };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initRadar };