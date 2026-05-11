/**
 * bubble.js — Bubble Chart de Top Artistas v1
 *
 * Visualiza los top-300 artistas del dataset usando burbujas donde:
 *   - Tamaño     → popularidad del artista (d3.scaleSqrt)
 *   - Color      → género principal del artista
 *   - Posición X → danceability media
 *   - Posición Y → energy media
 *
 * Features:
 *   - Simulación de fuerzas d3.forceSimulation para evitar solapamiento
 *   - Zoom + pan con d3.zoom (rueda del mouse)
 *   - Hover → burbuja se expande + tooltip con stats completas
 *   - Clic en burbuja → selectGenre() del género del artista
 *   - Etiquetas de nombre visible solo en burbujas grandes (r > umbral)
 *   - Linked views: genre:select → resalta todas las burbujas del género,
 *     atenúa el resto
 *   - Controles: eje X, eje Y, tamaño (popularity / track_count / energy)
 *   - Botón reset zoom
 *   - Animación de entrada: burbujas caen desde arriba con stagger
 *   - ResizeObserver con debounce
 *
 * Datos: artists_top.json → top 300 artistas con features de audio medias
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import {
  initGenreScale, genreColor,
  FEATURE_LABELS, FEATURE_COLORS, bubbleScale, fmt,
} from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN       = { top: 20, right: 20, bottom: 52, left: 54 };
const CTRL_H       = 34;
const TRANSITION   = 320;
const DEBOUNCE_MS  = 380;
const LABEL_MIN_R  = 14;    // radio mínimo para mostrar etiqueta de nombre
const MIN_R        = 4;
const MAX_R        = 36;

// Features disponibles para ejes
const AXIS_OPTS = [
  "danceability", "energy", "valence", "acousticness",
  "speechiness", "liveness", "tempo",
];

// Opciones de tamaño de burbuja
const SIZE_OPTS = {
  popularity:  "Popularidad",
  track_count: "Nº de tracks",
  energy:      "Energy media",
};

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container   = null;
let _svg         = null;
let _gBubbles    = null;
let _simulation  = null;
let _zoom        = null;
let _resizeObs   = null;
let _obsTimer    = null;
let _unsubs      = [];
let _prevW       = 0;
let _prevH       = 0;

let _featureX    = "danceability";
let _featureY    = "energy";
let _sizeKey     = "popularity";
let _activeGenre = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initBubble(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  const data = store.getData("artistsTop");
  if (!data) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "artistsTop") return;
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
  const data = store.getData("artistsTop");
  if (!data || !_container) return;

  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  _prevW = w; _prevH = h;

  // Detener simulación previa
  if (_simulation) { _simulation.stop(); _simulation = null; }

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  const genres = [...new Set(data.map(d => d.genres))];
  initGenreScale(genres);

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles ─────────────────────────────────────────────────────────────
  _buildControls(data);

  // ── Dimensiones ───────────────────────────────────────────────────────────
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom - CTRL_H;

  // ── SVG ───────────────────────────────────────────────────────────────────
  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top",  `${CTRL_H}px`)
    .style("left", "0")
    .style("width",  "100%")
    .style("height", `calc(100% - ${CTRL_H}px)`)
    .attr("viewBox", `0 0 ${w} ${h - CTRL_H}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Clip (0,0 porque el grupo ya tiene translate)
  const clipId = `bb-clip-${Math.random().toString(36).slice(2, 7)}`;
  _svg.append("defs").append("clipPath").attr("id", clipId)
    .append("rect")
      .attr("x", 0).attr("y", 0)
      .attr("width", innerW).attr("height", innerH);

  const gRoot = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // ── Escalas ───────────────────────────────────────────────────────────────
  const xScale = d3.scaleLinear()
    .domain(d3.extent(data, d => +d[_featureX])).nice()
    .range([0, innerW]);

  const yScale = d3.scaleLinear()
    .domain(d3.extent(data, d => +d[_featureY])).nice()
    .range([innerH, 0]);

  const rScale = bubbleScale(data, _sizeKey, MIN_R, MAX_R);

  // ── Grid ──────────────────────────────────────────────────────────────────
  const gGrid = gRoot.append("g").attr("class", "bb-grid")
    .style("pointer-events", "none");

  gGrid.selectAll(".bb-gx")
    .data(xScale.ticks(5))
    .join("line")
      .attr("class", "bb-gx")
      .attr("x1", d => xScale(d)).attr("x2", d => xScale(d))
      .attr("y1", 0).attr("y2", innerH)
      .attr("stroke", "rgba(255,255,255,0.04)").attr("stroke-width", 0.8);

  gGrid.selectAll(".bb-gy")
    .data(yScale.ticks(5))
    .join("line")
      .attr("class", "bb-gy")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", d => yScale(d)).attr("y2", d => yScale(d))
      .attr("stroke", "rgba(255,255,255,0.04)").attr("stroke-width", 0.8);



  // Labels de ejes
  _svg.append("text")
    .attr("x", MARGIN.left + innerW / 2)
    .attr("y", h - CTRL_H - 6)
    .attr("text-anchor", "middle")
    .attr("fill", FEATURE_COLORS[_featureX] || "var(--text-muted)")
    .attr("font-size", "11px").attr("font-weight", "500")
    .text(FEATURE_LABELS[_featureX] || _featureX);

  _svg.append("text")
    .attr("transform", `translate(14,${MARGIN.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill", FEATURE_COLORS[_featureY] || "var(--text-muted)")
    .attr("font-size", "11px").attr("font-weight", "500")
    .text(FEATURE_LABELS[_featureY] || _featureY);

  // ── Contenedor de burbujas con clip ───────────────────────────────────────
  const gClipped = gRoot.append("g")
    .attr("class", "bb-clipped-area")
    .attr("clip-path", `url(#${clipId})`);

  _gBubbles = gClipped.append("g").attr("class", "bb-bubbles");

  // ── Ejes (encima de las burbujas) ─────────────────────────────────────────
  const gAxis = gRoot.append("g").attr("class", "bb-axes");
  const gAxisX = gAxis.append("g").attr("class", "axis bb-axis-x")
    .attr("transform", `translate(0,${innerH})`);
  const gAxisY = gAxis.append("g").attr("class", "axis bb-axis-y");

  gAxisX.call(d3.axisBottom(xScale).ticks(5).tickSize(0).tickPadding(8))
    .call(g => g.select(".domain").attr("stroke", "rgba(255,255,255,0.08)"))
    .selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");

  gAxisY.call(d3.axisLeft(yScale).ticks(5).tickSize(0).tickPadding(8))
    .call(g => g.select(".domain").remove())
    .selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");

  // ── Posición inicial de cada artista ─────────────────────────────────────
  const nodes = data.map(d => ({
    ...d,
    targetX: xScale(+d[_featureX]),
    targetY: yScale(+d[_featureY]),
    r:       rScale(+d[_sizeKey] || 1),
  }));

  // ── Simulación de fuerzas (evita solapamiento) ────────────────────────────
  _simulation = d3.forceSimulation(nodes)
    .force("x",       d3.forceX(d => d.targetX).strength(0.45))
    .force("y",       d3.forceY(d => d.targetY).strength(0.45))
    .force("collide", d3.forceCollide(d => d.r + 1.5).strength(0.7))
    .alphaDecay(0.04)
    .velocityDecay(0.3)
    .stop();

  // Calentar la simulación sin renderizar (evita jank visual)
  for (let i = 0; i < 80; i++) _simulation.tick();

  // ── Renderizar burbujas ───────────────────────────────────────────────────
  const bubbles = _gBubbles.selectAll(".bb-node")
    .data(nodes, d => d.artist)
    .join("g")
      .attr("class",      "bb-node")
      .attr("data-genre", d => d.genres)
      .attr("transform",  d => `translate(${d.x},${d.y})`)
      .style("cursor", "pointer");

  // Círculo base
  bubbles.append("circle")
    .attr("class",        "bb-circle")
    .attr("r",            0)
    .attr("fill",         d => genreColor(d.genres))
    .attr("fill-opacity", d => _bubbleOpacity(d))
    .attr("stroke",       d => genreColor(d.genres))
    .attr("stroke-width", 1)
    .attr("stroke-opacity", 0.4)
    .transition()
    .delay((_, i) => i * 3)
    .duration(TRANSITION)
    .ease(d3.easeBackOut.overshoot(0.5))
    .attr("r", d => d.r);

  // Etiquetas (solo burbujas grandes)
  bubbles.filter(d => d.r >= LABEL_MIN_R)
    .append("text")
      .attr("class",          "bb-label")
      .attr("text-anchor",    "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size",      d => Math.min(d.r * 0.38, 10) + "px")
      .attr("font-weight",    "600")
      .attr("fill",           "#fff")
      .attr("fill-opacity",   0.9)
      .attr("pointer-events", "none")
      .attr("user-select",    "none")
      .text(d => _truncate(d.artist, Math.floor(d.r / 4.5)));

  // Interactividad
  bubbles
    .on("mouseenter", function(event, d) {
      if (_activeGenre && _activeGenre !== d.genres) return;
      const color = genreColor(d.genres);
      d3.select(this).select(".bb-circle")
        .interrupt()
        .transition().duration(100)
        .attr("r",            d.r * 1.2)
        .attr("fill-opacity", 1)
        .attr("stroke-width", 2)
        .attr("stroke-opacity", 1);

      tooltip.show(event, tooltip.html({
        title:    d.artist,
        subtitle: `Género: ${d.genres}`,
        color,
        rows: [
          { key: "Tracks",       value: d.track_count },
          { key: "Popularidad",  value: fmt(d.popularity, 1) },
          { key: FEATURE_LABELS[_featureX] || _featureX, value: fmt(d[_featureX], 3) },
          { key: FEATURE_LABELS[_featureY] || _featureY, value: fmt(d[_featureY], 3) },
          { key: "Valence",      value: fmt(d.valence, 3) },
          { key: "Acousticness", value: fmt(d.acousticness, 3) },
        ],
        footer: "Clic para filtrar todos los gráficos",
      }));
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function(_, d) {
      tooltip.hide();
      d3.select(this).select(".bb-circle")
        .interrupt()
        .transition().duration(150)
        .attr("r",            d.r)
        .attr("fill-opacity", _bubbleOpacity(d))
        .attr("stroke-width", 1)
        .attr("stroke-opacity", 0.4);
    })
    .on("click", (_, d) => {
      if (_activeGenre === d.genres) clearAllFilters();
      else selectGenre(d.genres);
    });

  // ── Zoom ──────────────────────────────────────────────────────────────────
  _zoom = d3.zoom()
    .scaleExtent([0.5, 8])
    .on("zoom", ({ transform }) => {
      _gBubbles.attr("transform", transform);
      // Actualizar ejes
      const newX = transform.rescaleX(xScale);
      const newY = transform.rescaleY(yScale);
      gAxisX.call(d3.axisBottom(newX).ticks(5).tickSize(0).tickPadding(8));
      gAxisY.call(d3.axisLeft(newY).ticks(5).tickSize(0).tickPadding(8));
      gAxisX.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
      gAxisY.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
      gAxisX.select(".domain").remove();
      gAxisY.select(".domain").remove();
    });

  _svg.call(_zoom).on("dblclick.zoom", null);
  _buildZoomReset();

  // ── Linked views ──────────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyGenreHighlight(genre);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _restoreAll();
    })
  );

  if (_activeGenre) _applyGenreHighlight(_activeGenre);

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Highlight ───────────────────────────────────────────────────────────────
function _applyGenreHighlight(genre) {
  if (!_gBubbles) return;
  _pauseObserver();

  _gBubbles.selectAll(".bb-node")
    .interrupt()
    .transition().duration(TRANSITION)
    .style("opacity", d => d.genres === genre ? 1 : 0.06)
    .on("end", () => _resumeObserver(TRANSITION));

  // Llevar al frente las del género activo
  _gBubbles.selectAll(`.bb-node[data-genre="${CSS.escape(genre)}"]`).raise();
}

function _restoreAll() {
  if (!_gBubbles) return;
  _pauseObserver();
  _gBubbles.selectAll(".bb-node")
    .interrupt()
    .transition().duration(TRANSITION)
    .style("opacity", 1)
    .on("end", () => _resumeObserver(TRANSITION));
  _gBubbles.selectAll(".bb-circle")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.75);
}

function _bubbleOpacity(d) {
  if (!_activeGenre) return 0.75;
  return d.genres === _activeGenre ? 1 : 0.06;
}

// ─── Leyenda de tamaño ────────────────────────────────────────────────────────
function _buildSizeLegend(data, rScale, gRoot, innerW, innerH) {
  const maxVal = d3.max(data, d => +d[_sizeKey] || 0);
  const steps  = [1.0, 0.5, 0.25].map(f => ({ // Orden descendente para nesting
    val: maxVal * f,
    r:   rScale(maxVal * f),
  }));

  const lgX = innerW - 100;
  const lgY = 40;
  const lg  = gRoot.append("g")
    .attr("class", "bb-size-legend")
    .attr("transform", `translate(${lgX},${lgY})`)
    .style("pointer-events", "none");

  lg.append("text")
    .attr("x", 0).attr("y", -25)
    .attr("font-size", "10px").attr("font-weight", "600")
    .attr("fill", "var(--text-muted)")
    .text(SIZE_OPTS[_sizeKey] || _sizeKey);

  // Círculos concéntricos (comparten el punto inferior)
  const maxR = steps[0].r;
  steps.forEach(({ val, r }) => {
    const g = lg.append("g");
    
    g.append("circle")
      .attr("cx", 0)
      .attr("cy", maxR - r)
      .attr("r", r)
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.2)")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "2 2");

    g.append("text")
      .attr("x", r + 5)
      .attr("y", maxR - r * 2 + 3)
      .attr("font-size", "9px")
      .attr("fill", "var(--text-hint)")
      .text(_sizeKey === "track_count" ? Math.round(val) : fmt(val, 1));
  });
}

// ─── Botón reset zoom ─────────────────────────────────────────────────────────
function _buildZoomReset() {
  const existing = _container.querySelector(".bb-zoom-reset");
  if (existing) existing.remove();

  const btn = document.createElement("button");
  btn.className = "bb-zoom-reset";
  btn.title     = "Restablecer zoom";
  btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" width="12" height="12">
    <path d="M2 8A6 6 0 0 1 8 2M8 2l-2 2M8 2l2 2M14 8a6 6 0 0 1-6 6M8 14l-2-2M8 14l2-2"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  btn.style.cssText = `
    position:absolute;top:${CTRL_H + 8}px;right:8px;z-index:20;
    width:26px;height:26px;background:var(--bg-elevated);
    border:1px solid var(--border-soft);border-radius:6px;
    color:var(--text-secondary);cursor:pointer;
    display:flex;align-items:center;justify-content:center;
    transition:var(--transition);
  `;
  btn.addEventListener("mouseenter", () => { btn.style.background = "var(--bg-hover)"; btn.style.color = "#fff"; });
  btn.addEventListener("mouseleave", () => { btn.style.background = "var(--bg-elevated)"; btn.style.color = "var(--text-secondary)"; });
  btn.addEventListener("click", () => {
    _svg.transition().duration(400).call(_zoom.transform, d3.zoomIdentity);
  });
  _container.style.position = "relative";
  _container.appendChild(btn);
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls(data) {
  const bar = document.createElement("div");
  bar.style.cssText = `
    box-sizing:border-box;display:flex;align-items:center;gap:10px;
    padding:4px 12px;height:${CTRL_H}px;
    border-bottom:1px solid var(--border-subtle);
    font-size:11px;color:var(--text-muted);
  `;

  bar.appendChild(_makeSelect("Eje X →", AXIS_OPTS, _featureX, val => {
    _featureX = val;
    _build();
  }));

  bar.appendChild(_makeSelect("Eje Y ↑", AXIS_OPTS, _featureY, val => {
    _featureY = val;
    _build();
  }));

  const sep = document.createElement("div");
  sep.style.cssText = "width:1px;height:18px;background:var(--border-subtle);flex-shrink:0;";
  bar.appendChild(sep);

  bar.appendChild(_makeSelect("Tamaño", Object.keys(SIZE_OPTS), _sizeKey, val => {
    _sizeKey = val;
    _build();
  }, SIZE_OPTS));

  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);white-space:nowrap;";
  hint.textContent   = `${data.length} artistas · Rueda para zoom · Clic para filtrar`;
  bar.appendChild(hint);

  _container.appendChild(bar);
}

function _makeSelect(labelText, options, current, onChange, labelMap = null) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:5px;";

  const lbl = document.createElement("span");
  lbl.textContent   = labelText;
  lbl.style.cssText = "font-size:10px;white-space:nowrap;text-transform:uppercase;letter-spacing:0.5px;";

  const sel = document.createElement("select");
  sel.style.cssText = `
    background:var(--bg-elevated);border:1px solid var(--border-soft);
    border-radius:6px;color:var(--text-primary);font-size:11px;
    padding:2px 8px;cursor:pointer;outline:none;
  `;
  options.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f;
    opt.text  = labelMap ? (labelMap[f] || f) : (FEATURE_LABELS[f] || f);
    if (f === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", e => onChange(e.target.value));

  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  if (Math.abs(w - _prevW) < 8 && Math.abs(h - _prevH) < 8) return;
  const prevGenre = _activeGenre;
  if (_simulation) { _simulation.stop(); _simulation = null; }
  _build();
  if (prevGenre) { _activeGenre = prevGenre; _applyGenreHighlight(prevGenre); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 240), h: Math.max(r.height, 200) };
}

function _truncate(str, max) {
  if (!str || max < 1) return "";
  if (str.length <= max) return str;
  return max >= 3 ? str.slice(0, max - 1) + "…" : str.slice(0, max);
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function _pauseObserver() {
  if (_resizeObs) _resizeObs.disconnect();
  clearTimeout(_obsTimer);
}

function _resumeObserver(delay = 50) {
  clearTimeout(_obsTimer);
  _obsTimer = setTimeout(() => {
    if (_resizeObs && _container) {
      const { w, h } = _dims();
      _prevW = w; _prevH = h;
      _resizeObs.observe(_container);
    }
  }, delay);
}

export default { initBubble };