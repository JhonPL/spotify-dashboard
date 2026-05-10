/**
 * scatterplot.js — Scatterplot interactivo con brushing y linked views v1
 *
 * Features:
 *   - Brush rectangular para selección múltiple (cross-filtering)
 *   - Ejes intercambiables (X / Y) desde dropdowns
 *   - Zoom + pan con d3.zoom
 *   - Tooltips avanzados por canción
 *   - Highlight coordinado cuando genre:select o brush:update se disparan
 *   - Marcadores coloreados por género con escala ordinal central
 *   - Progressive rendering: agrupa por género y renderiza en microtareas
 *   - ResizeObserver con debounce para responsividad
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { updateBrush, clearAllFilters, selectGenre } from "../core/filters.js";
import { initGenreScale, genreColor, FEATURE_LABELS, fmt } from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN = { top: 16, right: 20, bottom: 48, left: 52 };
const POINT_R = 3.2;          // radio base de los puntos
const POINT_R_HOVER = 5.5;    // radio al hacer hover
const TRANSITION = 220;
const DEBOUNCE_RESIZE = 380;

// Features disponibles para los ejes
const AXIS_FEATURES = [
  "energy", "danceability", "valence", "acousticness",
  "speechiness", "liveness", "instrumentalness",
];

// ─── Estado del módulo ────────────────────────────────────────────────────────
let _container  = null;
let _svg        = null;
let _gPoints    = null;   // <g> que contiene los puntos (dentro del clip)
let _xScale     = null;
let _yScale     = null;
let _xAxis      = null;
let _yAxis      = null;
let _brush      = null;
let _zoom       = null;
let _resizeObs  = null;
let _obsTimer   = null;
let _unsubs     = [];
let _prevW      = 0;
let _prevH      = 0;

// Feature actualmente mapeada a cada eje
let _featureX = store.get("filters.featureX") || "energy";
let _featureY = store.get("filters.featureY") || "danceability";

// IDs de puntos dentro del brush (null = sin brush activo)
let _brushedIds = null;

// Género filtrado globalmente
let _activeGenre = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initScatter(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  const data = store.getData("featuresSample");
  if (!data) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "featuresSample") return;
      unsub();
      _container.classList.remove("loading");
      _build();
    });
    return;
  }
  _build();
}

// ─── Build completo ───────────────────────────────────────────────────────────
function _build() {
  const data = store.getData("featuresSample");
  if (!data || !_container) return;

  const { w, h } = _dims();
  _prevW = w;
  _prevH = h;

  // Limpiar listeners previos
  _unsubs.forEach(fn => fn());
  _unsubs = [];

  // Inicializar escala de géneros
  const genres = [...new Set(data.map(d => d.track_genre))];
  initGenreScale(genres);

  // Limpiar DOM
  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles de ejes ────────────────────────────────────────────────────
  _buildAxisControls();
  _updatePanelTitle();

  // ── SVG base ─────────────────────────────────────────────────────────────

  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom;

  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top", "32px")
    .style("left", "0")
    .style("width", "100%")
    .style("height", "calc(100% - 32px)")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Clip path — los puntos no salen fuera del área del gráfico al hacer zoom
  const clipId = "scatter-clip-" + Math.random().toString(36).slice(2, 7);
  _svg.append("defs")
    .append("clipPath")
    .attr("id", clipId)
    .append("rect")
    .attr("x", 0).attr("y", 0)
    .attr("width", innerW).attr("height", innerH);

  const gRoot = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // ── Escalas ──────────────────────────────────────────────────────────────
  _xScale = d3.scaleLinear().domain([0, 1]).range([0, innerW]).nice();
  _yScale = d3.scaleLinear().domain([0, 1]).range([innerH, 0]).nice();

  // ── Grid lines ───────────────────────────────────────────────────────────
  const gGridX = gRoot.append("g").attr("class", "grid grid-x");
  const gGridY = gRoot.append("g").attr("class", "grid grid-y");

  function drawGrid() {
    gGridX.selectAll("line")
      .data(_xScale.ticks(6))
      .join("line")
      .attr("class", "grid-line")
      .attr("x1", d => _xScale(d)).attr("x2", d => _xScale(d))
      .attr("y1", 0).attr("y2", innerH);

    gGridY.selectAll("line")
      .data(_yScale.ticks(6))
      .join("line")
      .attr("class", "grid-line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", d => _yScale(d)).attr("y2", d => _yScale(d));
  }
  drawGrid();

  // ── Ejes ─────────────────────────────────────────────────────────────────
  const gAxisX = gRoot.append("g").attr("class", "axis axis-x")
    .attr("transform", `translate(0,${innerH})`);
  const gAxisY = gRoot.append("g").attr("class", "axis axis-y");

  const gLabelX = _svg.append("text")
    .attr("class", "axis-label")
    .attr("x", MARGIN.left + innerW / 2)
    .attr("y", h - 8)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--text-muted)")
    .attr("font-size", "11px");

  const gLabelY = _svg.append("text")
    .attr("class", "axis-label")
    .attr("transform", `translate(14,${MARGIN.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--text-muted)")
    .attr("font-size", "11px");

  function drawAxes() {
    _xAxis = d3.axisBottom(_xScale).ticks(6).tickSize(0).tickPadding(8);
    _yAxis = d3.axisLeft(_yScale).ticks(6).tickSize(0).tickPadding(8);
    gAxisX.call(_xAxis);
    gAxisY.call(_yAxis);
    gLabelX.text(FEATURE_LABELS[_featureX] || _featureX);
    gLabelY.text(FEATURE_LABELS[_featureY] || _featureY);

    // Estilizar ticks
    gAxisX.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
    gAxisY.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
    gAxisX.select(".domain").remove();
    gAxisY.select(".domain").remove();
  }
  drawAxes();

  // ── Contenedor de puntos con clip ─────────────────────────────────────────
  const gClipped = gRoot.append("g")
    .attr("clip-path", `url(#${clipId})`);

  _gPoints = gClipped.append("g").attr("class", "scatter-points");

  // ── Brush ─────────────────────────────────────────────────────────────────
  const gBrush = gClipped.append("g").attr("class", "scatter-brush");

  _brush = d3.brush()
    .extent([[0, 0], [innerW, innerH]])
    .on("brush",  _onBrush)
    .on("end",    _onBrushEnd);

  gBrush.call(_brush);

  // Estilizar brush selection
  gBrush.select(".selection")
    .attr("fill",         "rgba(29,185,84,0.08)")
    .attr("stroke",       "var(--spotify-green)")
    .attr("stroke-width", 1);

  // ── Zoom ─────────────────────────────────────────────────────────────────
  _zoom = d3.zoom()
    .scaleExtent([0.5, 10])
    .translateExtent([[-innerW, -innerH], [2 * innerW, 2 * innerH]])
    .filter(event => !event.ctrlKey && event.type !== "dblclick")
    .on("zoom", ({ transform }) => {
      const newX = transform.rescaleX(_xScale);
      const newY = transform.rescaleY(_yScale);

      _gPoints.attr("transform", transform);

      // Actualizar ejes con la nueva escala
      gAxisX.call(d3.axisBottom(newX).ticks(6).tickSize(0).tickPadding(8));
      gAxisY.call(d3.axisLeft(newY).ticks(6).tickSize(0).tickPadding(8));
      gAxisX.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
      gAxisY.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
      gAxisX.select(".domain").remove();
      gAxisY.select(".domain").remove();

      // Actualizar grid
      gGridX.selectAll("line")
        .data(newX.ticks(6))
        .join("line").attr("class", "grid-line")
        .attr("x1", d => newX(d)).attr("x2", d => newX(d))
        .attr("y1", 0).attr("y2", innerH);
      gGridY.selectAll("line")
        .data(newY.ticks(6))
        .join("line").attr("class", "grid-line")
        .attr("x1", 0).attr("x2", innerW)
        .attr("y1", d => newY(d)).attr("y2", d => newY(d));
    });

  // Aplicar zoom al SVG (rueda del mouse), pero NO al gBrush para que
  // el brush capture los eventos de arrastre
  _svg.call(_zoom).on("dblclick.zoom", null);

  // ── Renderizar puntos ─────────────────────────────────────────────────────
  _renderPoints(data);

  // ── Linked views: escuchar eventos globales ───────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyGenreFilter(genre);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _brushedIds  = null;
      _restoreAll();
      gBrush.call(_brush.move, null);
    })
  );
  _unsubs.push(
    on("genre:hover", ({ genre }) => {
      if (_activeGenre) return; // Si hay selección fija, no sobreescribir
      if (genre) _dimAllExcept(genre);
      else _restoreAll();
    })
  );

  // ── Botón reset zoom ─────────────────────────────────────────────────────
  _buildZoomButton(() => {
    _svg.transition().duration(400).call(_zoom.transform, d3.zoomIdentity);
  });

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_RESIZE));
  _resizeObs.observe(_container);
}

// ─── Render de puntos ──────────────────────────────────────────────────────────
function _renderPoints(data) {
  if (!_gPoints) return;

  // Actualizar dominio de escalas según features activos
  _xScale.domain(d3.extent(data, d => d[_featureX])).nice();
  _yScale.domain(d3.extent(data, d => d[_featureY])).nice();

  const byGenre = d3.group(data, d => d.track_genre);
  const genres  = [...byGenre.keys()];

  _gPoints.selectAll("*").remove();

  for (const genre of genres) {
    const points = byGenre.get(genre);
    const color  = genreColor(genre);

    _gPoints.append("g")
      .attr("class", "genre-group")
      .attr("data-genre", genre)
      .selectAll("circle")
      .data(points, d => d.track_id)
      .join("circle")
        .attr("class",     "scatter-dot")
        .attr("data-id",   d => d.track_id)
        .attr("data-genre",d => d.track_genre)
        .attr("cx",        d => _xScale(d[_featureX]))
        .attr("cy",        d => _yScale(d[_featureY]))
        .attr("r",         POINT_R)
        .attr("fill",      color)
        .attr("fill-opacity", 0.75)
        .attr("stroke",    "rgba(0,0,0,0.3)")
        .attr("stroke-width", 0.5)
        .on("mouseenter", function(event, d) { _onPointEnter(event, d, color, this); })
        .on("mousemove",  event => tooltip.move(event))
        .on("mouseleave", function(event, d) { _onPointLeave(this); })
        .on("click", (_, d) => {
          if (_activeGenre === d.track_genre) clearAllFilters();
          else selectGenre(d.track_genre);
        });
  }

  if (_activeGenre) _applyGenreFilter(_activeGenre);
}

// ─── Hover individual ─────────────────────────────────────────────────────────
function _onPointEnter(event, d, color, el) {
  d3.select(el)
    .transition().duration(80)
    .attr("r", POINT_R_HOVER)
    .attr("fill-opacity", 1)
    .attr("stroke", color)
    .attr("stroke-width", 1.5);

  tooltip.show(event, tooltip.html({
    title:    d.track_name,
    subtitle: d.artists,
    color,
    rows: [
      { key: "Género",    value: d.track_genre },
      { key: "Popularidad", value: d.popularity },
      { key: FEATURE_LABELS[_featureX] || _featureX, value: fmt(d[_featureX], 3) },
      { key: FEATURE_LABELS[_featureY] || _featureY, value: fmt(d[_featureY], 3) },
      { key: "Valence",   value: fmt(d.valence, 2) },
      { key: "Tempo",     value: `${Math.round(d.tempo)} BPM` },
    ],
  }));
}

function _onPointLeave(el) {
  // Restaurar tamaño — pero respetar el dimming si hay filtro activo
  const isDimmed = d3.select(el).classed("dimmed");
  d3.select(el)
    .transition().duration(120)
    .attr("r", POINT_R)
    .attr("fill-opacity", isDimmed ? 0.08 : 0.75)
    .attr("stroke", "rgba(0,0,0,0.3)")
    .attr("stroke-width", 0.5);

  tooltip.hide();
}

// ─── Brush handlers ───────────────────────────────────────────────────────────
function _onBrush(event) {
  if (!event.selection) return;
  const [[x0, y0], [x1, y1]] = event.selection;

  _gPoints.selectAll(".scatter-dot")
    .attr("fill-opacity", d => {
      const cx = _xScale(d[_featureX]);
      const cy = _yScale(d[_featureY]);
      return (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) ? 0.9 : 0.06;
    })
    .attr("r", d => {
      const cx = _xScale(d[_featureX]);
      const cy = _yScale(d[_featureY]);
      return (cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1) ? POINT_R + 0.5 : POINT_R;
    });
}

function _onBrushEnd(event) {
  if (!event.selection) {
    // Brush eliminado → limpiar filtro brush pero respetar filtro de género
    _brushedIds = null;
    updateBrush(null);
    if (_activeGenre) _applyGenreFilter(_activeGenre);
    else _restoreAll();
    return;
  }

  const [[x0, y0], [x1, y1]] = event.selection;

  // Convertir pixel extent a dominio
  const domX0 = _xScale.invert(x0), domX1 = _xScale.invert(x1);
  const domY0 = _yScale.invert(y1), domY1 = _yScale.invert(y0); // Y invertido

  // Calcular IDs dentro del brush
  const data    = store.getData("featuresSample") || [];
  _brushedIds   = new Set(
    data
      .filter(d =>
        d[_featureX] >= domX0 && d[_featureX] <= domX1 &&
        d[_featureY] >= domY0 && d[_featureY] <= domY1 &&
        (!_activeGenre || d.track_genre === _activeGenre)
      )
      .map(d => d.track_id)
  );

  // Emitir al bus con el extent en coordenadas de dominio
  updateBrush([[domX0, domY0], [domX1, domY1]]);
}

// ─── Aplicar filtro de género (highlight coordinado) ──────────────────────────
function _applyGenreFilter(genre) {
  if (!_gPoints) return;
  _pauseObserver();

  _gPoints.selectAll(".scatter-dot")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      const g = d3.select(this).attr("data-genre");
      return g === genre ? 0.85 : 0.05;
    })
    .attr("r", function() {
      const g = d3.select(this).attr("data-genre");
      return g === genre ? POINT_R + 0.6 : POINT_R;
    })
    .on("end", () => _resumeObserver(TRANSITION));

  // Los del género activo van arriba visualmente
  _gPoints.selectAll(`.scatter-dot[data-genre="${CSS.escape(genre)}"]`)
    .raise();
}

// ─── Dim todos excepto un género (hover rápido) ───────────────────────────────
function _dimAllExcept(genre) {
  if (!_gPoints) return;
  _gPoints.selectAll(".scatter-dot")
    .attr("fill-opacity", function() {
      return d3.select(this).attr("data-genre") === genre ? 0.85 : 0.05;
    });
}

// ─── Restaurar todos los puntos ────────────────────────────────────────────────
function _restoreAll() {
  if (!_gPoints) return;
  _pauseObserver();
  _gPoints.selectAll(".scatter-dot")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.75)
    .attr("r", POINT_R)
    .on("end", () => _resumeObserver(TRANSITION));
}

// ─── Cambiar feature de eje ────────────────────────────────────────────────────
function _updateAxis(axis, feature) {
  if (axis === "x") {
    _featureX = feature;
    store.set("filters.featureX", feature);
  } else {
    _featureY = feature;
    store.set("filters.featureY", feature);
  }

  _updatePanelTitle();

  const data = store.getData("featuresSample");
  if (!data || !_gPoints) return;

  if (axis === "x") _xScale.domain(d3.extent(data, d => d[_featureX])).nice();
  else              _yScale.domain(d3.extent(data, d => d[_featureY])).nice();

  // Actualizar ejes
  const gAxisX = _svg.select(".axis-x");
  const gAxisY = _svg.select(".axis-y");
  const labelX = _svg.select(".axis-label:nth-of-type(1)");
  const labelY = _svg.select(".axis-label:nth-of-type(2)");

  if (axis === "x") {
    gAxisX.transition().duration(TRANSITION)
      .call(d3.axisBottom(_xScale).ticks(6).tickSize(0).tickPadding(8));
    gAxisX.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
    gAxisX.select(".domain").remove();
    _svg.selectAll(".axis-label").filter((_, i) => i === 0)
      .text(FEATURE_LABELS[_featureX] || _featureX);
  } else {
    gAxisY.transition().duration(TRANSITION)
      .call(d3.axisLeft(_yScale).ticks(6).tickSize(0).tickPadding(8));
    gAxisY.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "10px");
    gAxisY.select(".domain").remove();
    _svg.selectAll(".axis-label").filter((_, i) => i === 1)
      .text(FEATURE_LABELS[_featureY] || _featureY);
  }

  // Animar puntos a nueva posición
  _gPoints.selectAll(".scatter-dot")
    .transition().duration(TRANSITION)
    .ease(d3.easeCubicInOut)
    .attr("cx", d => _xScale(d[_featureX]))
    .attr("cy", d => _yScale(d[_featureY]));
}

// ─── Construir controles de eje ────────────────────────────────────────────────
function _buildAxisControls() {
  const bar = document.createElement("div");
  bar.className = "scatter-controls";
  bar.style.cssText = `
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    height: 32px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
  `;

  function makeSelect(label, currentFeature, axis) {
    const wrap = document.createElement("div");
    wrap.style.cssText = "display:flex;align-items:center;gap:6px;";

    const lbl = document.createElement("span");
    lbl.textContent = label;
    lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;";

    const sel = document.createElement("select");
    sel.style.cssText = `
      background: var(--bg-elevated);
      border: 1px solid var(--border-soft);
      border-radius: 6px;
      color: var(--text-primary);
      font-size: 11px;
      padding: 2px 8px;
      cursor: pointer;
      outline: none;
    `;
    AXIS_FEATURES.forEach(f => {
      const opt = document.createElement("option");
      opt.value = f;
      opt.textContent = FEATURE_LABELS[f] || f;
      if (f === currentFeature) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", e => _updateAxis(axis, e.target.value));

    wrap.appendChild(lbl);
    wrap.appendChild(sel);
    return wrap;
  }

  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);";
  hint.textContent   = "Arrastra para seleccionar · Rueda para zoom · Clic en punto para filtrar";

  bar.appendChild(makeSelect("Eje X →", _featureX, "x"));
  bar.appendChild(makeSelect("Eje Y ↑", _featureY, "y"));
  bar.appendChild(hint);

  _container.appendChild(bar);
}

// ─── Botón reset zoom ──────────────────────────────────────────────────────────
function _buildZoomButton(onClick) {
  const btn = document.createElement("button");
  btn.className = "zoom-btn scatter-zoom-reset";
  btn.title     = "Restablecer zoom";
  btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" width="12" height="12">
    <path d="M2 8A6 6 0 0 1 8 2M8 2l-2 2M8 2l2 2M14 8a6 6 0 0 1-6 6M8 14l-2-2M8 14l2-2"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  btn.style.cssText = `
    position: absolute;
    top: 8px;
    right: 8px;
    z-index: 20;
    width: 26px;
    height: 26px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-soft);
    border-radius: 6px;
    color: var(--text-secondary);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: var(--transition);
  `;
  btn.addEventListener("mouseenter", () => { btn.style.background = "var(--bg-hover)"; btn.style.color = "var(--text-primary)"; });
  btn.addEventListener("mouseleave", () => { btn.style.background = "var(--bg-elevated)"; btn.style.color = "var(--text-secondary)"; });
  btn.addEventListener("click", onClick);
  _container.style.position = "relative";
  _container.appendChild(btn);
}

// ─── Rebuild en resize ────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return; // Prevent building when hidden
  if (Math.abs(w - _prevW) < 6 && Math.abs(h - _prevH) < 6) return;
  const prevGenre = _activeGenre;
  _build();
  if (prevGenre) { _activeGenre = prevGenre; _applyGenreFilter(prevGenre); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 240), h: Math.max(r.height, 180) };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function _updatePanelTitle() {
  const panel = _container.closest(".panel");
  if (!panel) return;
  const h2 = panel.querySelector(".panel__header h2");
  if (h2) {
    const nameX = FEATURE_LABELS[_featureX] || _featureX;
    const nameY = FEATURE_LABELS[_featureY] || _featureY;
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    h2.textContent = `${cap(nameX)} vs ${cap(nameY)}`;
  }
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
      _prevW = w;
      _prevH = h;
      _resizeObs.observe(_container);
    }
  }, delay);
}

export default { initScatter };