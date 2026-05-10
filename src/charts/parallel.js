/**
 * parallel.js — Parallel Coordinates por GÉNERO v3
 *
 * Solución al solapamiento: opacidad base muy baja (0.18) + hover potente.
 * El gráfico funciona como "exploración activa": el usuario descubre géneros
 * haciendo hover, no mirando todas las líneas a la vez.
 *
 * Mejoras clave sobre v2:
 *   - OP_BASE bajada a 0.18 → menos ruido visual
 *   - Color del stroke más saturado en hover (sin mix-blend)
 *   - "Modo cluster": agrupa géneros por similitud en un color más oscuro
 *   - Highlight de vecinos al hacer hover (géneros con perfil parecido)
 *   - Eje de popularidad a la DERECHA como destino narrativo
 *   - Etiqueta flotante al lado derecho de la línea en hover
 *   - Brush multi-eje con contador de géneros que quedan
 *   - stroke-width más delgado en base (0.8) y más grueso en hover (3.5)
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
const MARGIN      = { top: 64, right: 120, bottom: 24, left: 32 };
const CTRL_H      = 36;
const BRUSH_W     = 18;
const AXIS_PAD    = 10;
const TRANSITION  = 240;
const DEBOUNCE_MS = 380;

// Opacidades — la clave está aquí
const OP_BASE      = 0.18;   // casi invisible: el gráfico no es para mirar todo junto
const OP_NEIGHBOR  = 0.45;   // géneros "vecinos" en hover
const OP_HOVER     = 1.0;    // género hovered
const OP_SELECTED  = 0.90;   // género seleccionado globalmente
const OP_DIM       = 0.04;   // fuera de brush o filtro
const OP_BRUSHED   = 0.55;   // dentro del brush pero no hovered

// Stroke widths
const SW_BASE     = 0.9;
const SW_NEIGHBOR = 1.4;
const SW_HOVER    = 3.2;
const SW_SELECTED = 2.4;

// Dimensiones en orden narrativo (features → resultado popularidad al final)
const DEFAULT_DIMS = [
  "energy",
  "danceability",
  "valence",
  "acousticness",
  "instrumentalness",
  "speechiness",
  "liveness",
  "popularity",    // resultado al final → narrativa causal
];

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container    = null;
let _svg          = null;
let _gLines       = null;
let _gAxes        = null;
let _gLabels      = null;   // etiquetas flotantes en hover
let _resizeObs    = null;
let _unsubs       = [];
let _prevW        = 0;
let _prevH        = 0;

let _dims         = [...DEFAULT_DIMS];
let _brushExtents = new Map();
let _activeGenre  = null;
let _hoveredGenre = null;
let _neighbors    = new Set();   // géneros parecidos al hovered

let _data         = null;
let _xScale       = null;
let _yScales      = {};

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initParallel(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  const raw = store.getData("genresSummary");
  if (!raw) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "genresSummary") return;
      unsub();
      _container.classList.remove("loading");
      _data = store.getData("genresSummary");
      _build();
    });
    return;
  }
  _data = raw;
  _build();
}

// ─── Build ────────────────────────────────────────────────────────────────────
function _build() {
  if (!_data || !_container) return;

  const { w, h } = _dims_px();
  if (w === 0 || h === 0) return;
  _prevW = w; _prevH = h;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  initGenreScale(_data.map(d => d.track_genre));

  _container.innerHTML = "";
  _container.classList.remove("loading");

  _buildControls();

  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom - CTRL_H;

  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top",  `${CTRL_H}px`)
    .style("left", "0")
    .style("width",  "100%")
    .style("height", `calc(100% - ${CTRL_H}px)`)
    .attr("viewBox", `0 0 ${w} ${h - CTRL_H}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .on("mouseleave", _onLeave);

  // Fondo reactivo para asegurar limpieza de hover
  _svg.append("rect")
    .attr("width", w)
    .attr("height", h - CTRL_H)
    .attr("fill", "transparent")
    .style("pointer-events", "all");

  const gRoot = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // ── Escalas ───────────────────────────────────────────────────────────────
  _xScale = d3.scalePoint()
    .domain(_dims)
    .range([0, innerW])
    .padding(0.1);

  _dims.forEach(dim => {
    const ext = d3.extent(_data, d => +d[dim]);
    _yScales[dim] = d3.scaleLinear()
      .domain(ext).range([innerH, 0]).nice();
  });

  // ── Bandas de rango IQR por eje ───────────────────────────────────────────
  _drawBands(gRoot, innerH);

  // ── Líneas ────────────────────────────────────────────────────────────────
  _gLines = gRoot.append("g").attr("class", "pc-lines");
  _renderLines(true);

  // ── Etiquetas hover ───────────────────────────────────────────────────────
  _gLabels = gRoot.append("g").attr("class", "pc-hover-labels")
    .style("pointer-events", "none");

  // ── Ejes + brushes + drag ─────────────────────────────────────────────────
  _gAxes = gRoot.append("g").attr("class", "pc-axes");
  _drawAxes(innerH, innerW);

  // ── Hint flotante ─────────────────────────────────────────────────────────
  _drawHint(gRoot, innerW, innerH);

  // ── Listeners globales ────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _neighbors.clear();
      _applyVisualState();
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre  = null;
      _hoveredGenre = null;
      _neighbors.clear();
      _brushExtents.clear();
      _resetBrushUI();
      _applyVisualState();
      _updateCounter();
      _clearHoverLabel();
    })
  );

  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);

  _updateCounter();
}

// ─── Bandas IQR ───────────────────────────────────────────────────────────────
function _drawBands(gRoot, innerH) {
  const gB = gRoot.append("g").attr("class", "pc-bands")
    .style("pointer-events", "none");

  _dims.forEach(dim => {
    const ys   = _yScales[dim];
    const vals = _data.map(d => +d[dim]).sort(d3.ascending);
    const q1   = d3.quantile(vals, 0.25);
    const q3   = d3.quantile(vals, 0.75);
    const med  = d3.quantile(vals, 0.5);
    const x    = _xScale(dim);
    const col  = FEATURE_COLORS[dim] || "#1DB954";

    // IQR box
    gB.append("rect")
      .attr("x",            x - 10)
      .attr("y",            ys(q3))
      .attr("width",        20)
      .attr("height",       Math.max(1, ys(q1) - ys(q3)))
      .attr("fill",         col)
      .attr("fill-opacity", 0.07)
      .attr("rx",           3);

    // Mediana
    gB.append("line")
      .attr("x1", x - 10).attr("x2", x + 10)
      .attr("y1", ys(med)).attr("y2", ys(med))
      .attr("stroke",       col)
      .attr("stroke-width", 1.2)
      .attr("stroke-opacity", 0.3);
  });
}

// ─── Hint texto ───────────────────────────────────────────────────────────────
function _drawHint(gRoot, innerW, innerH) {
  gRoot.append("text")
    .attr("x", innerW / 2)
    .attr("y", innerH / 2)
    .attr("text-anchor", "middle")
    .attr("font-size", "12px")
    .attr("fill", "rgba(255,255,255,0.12)")
    .attr("font-weight", "400")
    .attr("class", "pc-hint")
    .text("Pasa el cursor sobre una línea para explorar");
}

// ─── Renderizar líneas ────────────────────────────────────────────────────────
function _renderLines(isInitial) {
  _gLines.selectAll("*").remove();

  // Orden: primero los dimmed (fondo), luego los activos (encima)
  const sorted = [..._data].sort((a, b) => {
    const scoreA = _lineScore(a.track_genre);
    const scoreB = _lineScore(b.track_genre);
    return scoreA - scoreB; // menor score = fondo
  });

  sorted.forEach((d, i) => {
    const color = genreColor(d.track_genre);
    const op    = _opacity(d.track_genre);
    const sw    = _strokeW(d.track_genre);

    const line = _gLines.append("path")
      .attr("class",           "pc-line")
      .attr("data-genre",      d.track_genre)
      .attr("fill",            "none")
      .attr("stroke",          color)
      .attr("stroke-linecap",  "round")
      .attr("stroke-linejoin", "round")
      .style("cursor",         "pointer");

    if (isInitial) {
      line
        .attr("d", _linePath(d))
        .attr("stroke-width",   sw)
        .attr("stroke-opacity", 0)
        .transition()
        .delay(i * 5)
        .duration(TRANSITION)
        .ease(d3.easeCubicOut)
        .attr("stroke-opacity", op);
    } else {
      line
        .attr("d", _linePath(d))
        .attr("stroke-width",   sw)
        .attr("stroke-opacity", op);
    }

    line
      .on("mouseenter", function(event) { _onEnter(event, d, color, this); })
      .on("mousemove",  event => tooltip.move(event))
      .on("mouseleave", function() { _onLeave(); })
      .on("click", () => {
        if (_activeGenre === d.track_genre) clearAllFilters();
        else selectGenre(d.track_genre);
      });
  });
}

// Score para ordenar render (mayor = encima)
function _lineScore(genre) {
  if (genre === _hoveredGenre)   return 4;
  if (genre === _activeGenre)    return 3;
  if (_neighbors.has(genre))     return 2;
  if (_passesBrush(genre))       return 1;
  return 0;
}

function _linePath(d) {
  const points = _dims.map(dim => [_xScale(dim), _yScales[dim](+d[dim])]);
  return d3.line().curve(d3.curveCatmullRom.alpha(0.5))(points);
}

// ─── Opacidad y grosor por estado ─────────────────────────────────────────────
function _opacity(genre) {
  const brushed = _passesBrush(genre);
  if (!brushed) return OP_DIM;

  if (genre === _hoveredGenre)                           return OP_HOVER;
  if (_neighbors.has(genre))                             return OP_NEIGHBOR;
  if (genre === _activeGenre)                            return OP_SELECTED;

  // Si hay algo activo o hovered → atenuar el resto
  if (_hoveredGenre || _activeGenre || _brushExtents.size > 0) {
    return _brushExtents.size > 0 ? OP_BRUSHED : OP_DIM;
  }

  return OP_BASE;
}

function _strokeW(genre) {
  if (genre === _hoveredGenre) return SW_HOVER;
  if (_neighbors.has(genre))   return SW_NEIGHBOR;
  if (genre === _activeGenre)  return SW_SELECTED;
  return SW_BASE;
}

// ─── Vecinos: géneros con perfil de audio similar ─────────────────────────────
function _computeNeighbors(targetGenre, topN = 5) {
  const target = _data.find(d => d.track_genre === targetGenre);
  if (!target) return;

  const featureDims = _dims.filter(d => d !== "popularity");

  const distances = _data
    .filter(d => d.track_genre !== targetGenre)
    .map(d => {
      const dist = featureDims.reduce((sum, dim) => {
        const ys  = _yScales[dim];
        const [lo, hi] = ys.domain();
        const rng = hi - lo || 1;
        const diff = (+d[dim] - +target[dim]) / rng;
        return sum + diff * diff;
      }, 0);
      return { genre: d.track_genre, dist };
    })
    .sort((a, b) => a.dist - b.dist);

  _neighbors = new Set(distances.slice(0, topN).map(x => x.genre));
}

// ─── Etiqueta flotante en hover ───────────────────────────────────────────────
function _showHoverLabel(d, color) {
  _gLabels.selectAll("*").remove();

  const lastDim = _dims[_dims.length - 1];
  const xBase   = _xScale(lastDim) + 14;
  const targetY = _yScales[lastDim](+d[lastDim]);

  // 1. Etiqueta del GÉNERO PRINCIPAL (Pill destacado)
  const labelG = _gLabels.append("g").attr("transform", `translate(${xBase},${targetY})`);
  const name   = d.track_genre;
  const textW  = Math.min(name.length * 7 + 20, 140);

  labelG.append("rect")
    .attr("x", 0).attr("y", -11)
    .attr("width", textW).attr("height", 22)
    .attr("rx", 11)
    .attr("fill", color)
    .attr("fill-opacity", 0.8)
    .attr("stroke", "#fff")
    .attr("stroke-width", 1.5);

  labelG.append("text")
    .attr("x", 10).attr("y", 5)
    .attr("font-size", "11px")
    .attr("font-weight", "800")
    .attr("fill", "#fff")
    .text(name);

  // 2. LISTADO DE VECINOS (Vertical para evitar solapamiento)
  if (_neighbors.size > 0) {
    const neighborData = _data
      .filter(r => _neighbors.has(r.track_genre))
      .sort((a, b) => (+b[lastDim]) - (+a[lastDim])); // Ordenar por popularidad

    // Altura estimada del listado: encabezado(20) + n*filas(14) + margen(10)
    const listH = 30 + neighborData.length * 14;
    
    // Dimensiones del área segura (dentro de gRoot)
    const { h: containerH } = _dims_px();
    const safeH = containerH - CTRL_H - MARGIN.top - MARGIN.bottom;
    
    // Intentar abajo primero
    let listY = targetY + 18;
    
    // Si se sale por abajo...
    if (listY + listH > safeH) {
      // ...intentar arriba
      listY = targetY - listH - 10;
      
      // Si también se sale por arriba o pisa los títulos del eje...
      if (listY < -15) {
        // Forzar a que se quede pegado abajo si hay más espacio
        if (targetY < safeH / 2) listY = targetY + 18;
        else listY = targetY - listH - 10;
      }
    }

    // Clampeado final absoluto para no pisar el header ni el footer
    listY = Math.max(-10, Math.min(listY, safeH - listH + 10));

    const listG = _gLabels.append("g")
      .attr("transform", `translate(${xBase + 4}, ${listY})`);

    listG.append("text")
      .attr("y", 10)
      .attr("font-size", "9px")
      .attr("font-weight", "700")
      .attr("fill", "var(--text-hint)")
      .attr("text-transform", "uppercase")
      .attr("letter-spacing", "0.5px")
      .text("Similares:");

    neighborData.forEach((neighbor, i) => {
      const nCol = genreColor(neighbor.track_genre);
      const rowG = listG.append("g").attr("transform", `translate(0, ${24 + i * 14})`);

      rowG.append("circle")
        .attr("r", 3)
        .attr("fill", nCol);

      rowG.append("text")
        .attr("x", 8)
        .attr("y", 3.5)
        .attr("font-size", "10px")
        .attr("fill", nCol)
        .attr("fill-opacity", 0.9)
        .text(neighbor.track_genre);
    });
  }
}

function _clearHoverLabel() {
  if (_gLabels) _gLabels.selectAll("*").remove();
}

// ─── Hover handlers ───────────────────────────────────────────────────────────
function _onEnter(event, d, color, el) {
  _hoveredGenre = d.track_genre;
  _computeNeighbors(d.track_genre);

  // Ocultar hint
  _svg.select(".pc-hint").attr("fill-opacity", 0);

  // Traer al frente
  el.parentNode.appendChild(el);
  _applyVisualState();
  _showHoverLabel(d, color);

  tooltip.show(event, tooltip.html({
    title:    d.track_genre,
    color,
    rows: [
      { key: "Tracks",           value: (d.count ?? 0).toLocaleString("es") },
      { key: "Popularidad",      value: fmt(d.popularity, 1) },
      { key: "Energy",           value: fmt(d.energy, 2) },
      { key: "Danceability",     value: fmt(d.danceability, 2) },
      { key: "Valence",          value: fmt(d.valence, 2) },
      { key: "Acousticness",     value: fmt(d.acousticness, 2) },
      { key: "Instrumentalness", value: fmt(d.instrumentalness, 2) },
      { key: "Speechiness",      value: fmt(d.speechiness, 2) },
    ],
    footer: "Clic para filtrar todos los gráficos",
  }));
}

function _onLeave() {
  _hoveredGenre = null;
  _neighbors.clear();
  _applyVisualState();
  _clearHoverLabel();
  tooltip.hide();
}

// ─── Aplicar estado visual a todas las líneas ─────────────────────────────────
function _applyVisualState() {
  if (!_gLines) return;
  _gLines.selectAll(".pc-line")
    .interrupt()
    .transition().duration(TRANSITION)
    .attr("stroke-opacity", function() {
      return _opacity(d3.select(this).attr("data-genre"));
    })
    .attr("stroke-width", function() {
      return _strokeW(d3.select(this).attr("data-genre"));
    });

  // Reordenar: traer activos al frente
  ["pc-line"].forEach(cls => {
    if (_activeGenre) _gLines.selectAll(`.${cls}[data-genre="${CSS.escape(_activeGenre)}"]`).raise();
    _neighbors.forEach(g => _gLines.selectAll(`.${cls}[data-genre="${CSS.escape(g)}"]`).raise());
    if (_hoveredGenre) _gLines.selectAll(`.${cls}[data-genre="${CSS.escape(_hoveredGenre)}"]`).raise();
  });
}

// ─── Brush ────────────────────────────────────────────────────────────────────
function _passesBrush(genre) {
  if (_brushExtents.size === 0) return true;
  const d = _data.find(r => r.track_genre === genre);
  if (!d) return false;
  for (const [dim, [lo, hi]] of _brushExtents) {
    const v = +d[dim];
    if (v < lo || v > hi) return false;
  }
  return true;
}

// ─── Ejes, brushes y drag ─────────────────────────────────────────────────────
function _drawAxes(innerH, innerW) {
  _gAxes.selectAll("*").remove();

  let dragging = {};

  function xPos(dim) {
    return dragging[dim] != null ? dragging[dim] : _xScale(dim);
  }

  const drag = d3.drag()
    .subject((_, dim) => ({ x: _xScale(dim) }))
    .on("start", (_, dim) => { dragging[dim] = _xScale(dim); })
    .on("drag",  function(event, dim) {
      dragging[dim] = Math.max(0, Math.min(innerW, event.x));
      _dims.sort((a, b) => xPos(a) - xPos(b));
      _xScale.domain(_dims);
      _gAxes.selectAll(".pc-axis-g").attr("transform", d => `translate(${xPos(d)},0)`);
      _gLines.selectAll(".pc-line").attr("d", d => {
        const pts = _dims.map(dm => [xPos(dm), _yScales[dm](+d[dm])]);
        return d3.line().curve(d3.curveCatmullRom.alpha(0.5))(pts);
      });
    })
    .on("end", (_, dim) => {
      delete dragging[dim];
      _dims.sort((a, b) => _xScale(a) - _xScale(b));
      _xScale.domain(_dims);
      _gAxes.selectAll(".pc-axis-g")
        .transition().duration(TRANSITION)
        .attr("transform", d => `translate(${_xScale(d)},0)`);
      _gLines.selectAll(".pc-line")
        .transition().duration(TRANSITION)
        .attr("d", d => _linePath(d));
    });

  const axisG = _gAxes.selectAll(".pc-axis-g")
    .data(_dims)
    .join("g")
      .attr("class",     "pc-axis-g")
      .attr("transform", d => `translate(${_xScale(d)},0)`)
      .call(drag)
      .style("cursor", "grab");

  // Línea del eje
  axisG.append("line")
    .attr("y1", -AXIS_PAD)
    .attr("y2", innerH + AXIS_PAD)
    .attr("stroke",        d => d === "popularity"
      ? "var(--spotify-green)"
      : (FEATURE_COLORS[d] || "rgba(255,255,255,0.15)"))
    .attr("stroke-width",  d => d === "popularity" ? 2 : 1.5)
    .attr("stroke-opacity", d => d === "popularity" ? 0.6 : 0.4);

  // Ticks + valores
  axisG.each(function(dim) {
    const g  = d3.select(this);
    const ys = _yScales[dim];
    ys.ticks(5).forEach(t => {
      g.append("line")
        .attr("x1", -4).attr("x2", 4)
        .attr("y1", ys(t)).attr("y2", ys(t))
        .attr("stroke", "rgba(255,255,255,0.18)")
        .attr("stroke-width", 1);
      g.append("text")
        .attr("x", -7).attr("y", ys(t) + 3.5)
        .attr("text-anchor", "end")
        .attr("font-size",   "7.5px")
        .attr("fill",        "rgba(255,255,255,0.28)")
        .text(_fmtTick(dim, t));
    });
  });

  // Etiqueta del eje
  axisG.each(function(dim) {
    const g     = d3.select(this);
    const color = dim === "popularity" ? "var(--spotify-green)" : (FEATURE_COLORS[dim] || "#aaa");
    const label = (FEATURE_LABELS[dim] || dim)
      .replace("ibility", "y")
      .replace("ness", "");

    g.append("circle")
      .attr("cy",   -MARGIN.top + 16)
      .attr("r",    dim === "popularity" ? 5 : 4)
      .attr("fill", color)
      .attr("fill-opacity", 0.85)
      .style("pointer-events", "none");

    g.append("text")
      .attr("y",            -MARGIN.top + 33)
      .attr("text-anchor",  "middle")
      .attr("font-size",    dim === "popularity" ? "11px" : "10px")
      .attr("font-weight",  "700")
      .attr("fill",         color)
      .attr("letter-spacing", "0.4px")
      .style("pointer-events", "none")
      .text(label);

    // "→ resultado" bajo el eje de popularidad
    if (dim === "popularity") {
      g.append("text")
        .attr("y",           -MARGIN.top + 47)
        .attr("text-anchor", "middle")
        .attr("font-size",   "8px")
        .attr("fill",        "var(--spotify-green)")
        .attr("fill-opacity", 0.6)
        .style("pointer-events", "none")
        .text("resultado");
    }
  });

  // Brush por eje
  axisG.each(function(dim) {
    const g     = d3.select(this);
    const ys    = _yScales[dim];
    const color = dim === "popularity" ? "var(--spotify-green)" : (FEATURE_COLORS[dim] || "var(--spotify-green)");

    const brushY = d3.brushY()
      .extent([[-BRUSH_W / 2, 0], [BRUSH_W / 2, innerH]])
      .on("brush end", function(event) {
        if (!event.selection) {
          _brushExtents.delete(dim);
        } else {
          const [y0, y1] = event.selection;
          _brushExtents.set(dim, [ys.invert(y1), ys.invert(y0)]);
        }
        _applyVisualState();
        _updateCounter();
      });

    const bg = g.append("g")
      .attr("class", `pc-brush pc-brush-${dim.replace(/[^a-z0-9]/gi, "_")}`)
      .call(brushY);

    bg.select(".selection")
      .attr("fill",         color)
      .attr("fill-opacity", 0.15)
      .attr("stroke",       color)
      .attr("stroke-width", 1.5)
      .attr("rx",           4);

    bg.selectAll(".handle")
      .attr("fill",         color)
      .attr("fill-opacity", 0.65)
      .attr("rx",           2);
  });
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls() {
  const bar = document.createElement("div");
  bar.style.cssText = `
    box-sizing:border-box;display:flex;align-items:center;gap:10px;
    padding:4px 14px;height:${CTRL_H}px;
    border-bottom:1px solid var(--border-subtle);
    font-size:11px;color:var(--text-muted);
  `;

  const hint = document.createElement("span");
  hint.style.cssText = "font-size:10px;color:var(--text-hint);";
  hint.textContent   = "Hover para explorar · Brush en eje para filtrar · Arrastra eje para reordenar";

  const counter = document.createElement("span");
  counter.id            = "pc-counter";
  counter.style.cssText = "font-size:11px;color:var(--spotify-green);font-weight:600;";

  const resetBtn = document.createElement("button");
  resetBtn.textContent  = "Limpiar filtros";
  resetBtn.style.cssText = `
    margin-left:auto;padding:2px 12px;border-radius:12px;
    border:1px solid var(--border-soft);background:transparent;
    color:var(--text-muted);font-size:10px;cursor:pointer;
  `;
  resetBtn.addEventListener("mouseenter", () => { resetBtn.style.background="var(--bg-hover)"; resetBtn.style.color="#fff"; });
  resetBtn.addEventListener("mouseleave", () => { resetBtn.style.background="transparent"; resetBtn.style.color="var(--text-muted)"; });
  resetBtn.addEventListener("click", () => clearAllFilters());

  bar.appendChild(hint);
  bar.appendChild(counter);
  bar.appendChild(resetBtn);
  _container.appendChild(bar);
}

function _updateCounter() {
  const el = document.getElementById("pc-counter");
  if (!el) return;
  const vis = _data.filter(d => _passesBrush(d.track_genre)).length;
  el.textContent = `${vis} / ${_data.length} géneros`;
}

function _resetBrushUI() {
  if (!_gAxes) return;
  _gAxes.selectAll(".pc-brush").each(function() {
    d3.select(this).call(d3.brushY().move, null);
  });
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims_px();
  if (w === 0 || h === 0) return;
  if (Math.abs(w - _prevW) < 12 && Math.abs(h - _prevH) < 12) return;
  const prev    = _activeGenre;
  const prevBr  = new Map(_brushExtents);
  _brushExtents.clear();
  _hoveredGenre = null;
  _neighbors.clear();
  _build();
  _activeGenre  = prev;
  _brushExtents = prevBr;
  if (prev) _applyVisualState();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _fmtTick(dim, v) {
  if (dim === "popularity" || dim === "tempo") return Math.round(v);
  return v.toFixed(1);
}

function _dims_px() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 320), h: Math.max(r.height, 240) };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initParallel };