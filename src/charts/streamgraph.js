/**
 * streamgraph.js — Streamgraph de energía por tier de popularidad v1
 *
 * Visualiza cómo se distribuye la energía promedio de los top-10 géneros
 * a lo largo de los 10 tiers de popularidad del dataset (Tier 1 = baja
 * popularidad → Tier 10 = alta popularidad).
 *
 * Features:
 *   - Stack offset "wiggle" (streamgraph clásico) con opción de cambiar
 *     a "expand" (área 100%) y "none" (stacked area normal)
 *   - Smooth curves con d3.curveCatmullRom
 *   - Hover individual de capa → tooltip + highlight coordinado
 *   - Clic en capa → selectGenre() (linked con treemap y scatter)
 *   - Recibe genre:select / filters:clear del bus global
 *   - Eje X con labels de tier legibles
 *   - Eje Y dinámico según el offset activo
 *   - Animación de entrada con stagger por capa
 *   - ResizeObserver con debounce
 *   - Toggle de feature: energy | danceability | valence
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import { genreColor, initGenreScale, FEATURE_LABELS, fmt } from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN       = { top: 24, right: 90, bottom: 36, left: 44 };
const TRANSITION   = 500;
const ENTER_DELAY  = 40;    // ms de stagger entre capas en la animación de entrada
const CURVE        = d3.curveCatmullRom.alpha(0.5);
const DEBOUNCE_MS  = 380;

// Features que se pueden visualizar en el eje Y de cada capa
const STREAM_FEATURES = ["energy", "danceability", "valence", "acousticness"];

// Offsets disponibles (streamgraph / expand / stacked)
const OFFSETS = {
  wiggle: { fn: d3.stackOffsetWiggle,  normalize: d3.stackOrderInsideOut, label: "Stream" },
  expand: { fn: d3.stackOffsetExpand,  normalize: d3.stackOrderNone,      label: "100%"   },
  none:   { fn: d3.stackOffsetNone,    normalize: d3.stackOrderNone,      label: "Stack"  },
};

// ─── Estado del módulo ────────────────────────────────────────────────────────
let _container     = null;
let _svg           = null;
let _gLayers       = null;
let _xScale        = null;
let _yScale        = null;
let _resizeObs     = null;
let _obsTimer      = null;
let _unsubs        = [];
let _prevW         = 0;
let _prevH         = 0;
let _activeGenre   = null;
let _hoveredGenre  = null;

// Estado de controles
let _feature       = "energy";
let _offsetKey     = "wiggle";

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initStreamgraph(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  const data = store.getData("temporalTrends");
  if (!data) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "temporalTrends") return;
      unsub();
      _container.classList.remove("loading");
      _build();
    });
    return;
  }
  _build();
}

// ─── Build principal ──────────────────────────────────────────────────────────
function _build() {
  const raw = store.getData("temporalTrends");
  if (!raw || !_container) return;

  const { w, h } = _dims();
  _prevW = w;
  _prevH = h;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  // Inicializar escala de géneros
  initGenreScale(raw.genres);

  // Limpiar DOM
  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles ─────────────────────────────────────────────────────────────
  _buildControls(raw.genres);
  _updatePanelTitle();

  // ── Dimensiones ───────────────────────────────────────────────────────────
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom;

  // ── SVG ───────────────────────────────────────────────────────────────────
  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top", "34px")
    .style("left", "0")
    .style("width", "100%")
    .style("height", "calc(100% - 34px)")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  const gRoot = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // Clip
  const clipId = "sg-clip-" + Math.random().toString(36).slice(2, 7);
  _svg.append("defs").append("clipPath").attr("id", clipId)
    .append("rect").attr("width", innerW).attr("height", innerH);

  // ── Escalas base ─────────────────────────────────────────────────────────
  _xScale = d3.scaleLinear()
    .domain([0, raw.data.length - 1])
    .range([0, innerW]);

  _yScale = d3.scaleLinear().range([innerH, 0]);

  // ── Ejes ──────────────────────────────────────────────────────────────────
  const gAxisX = gRoot.append("g").attr("class", "axis axis-x stream-axis-x")
    .attr("transform", `translate(0,${innerH})`);

  const gAxisY = gRoot.append("g").attr("class", "axis axis-y stream-axis-y");

  // ── Contenedor de capas ───────────────────────────────────────────────────
  _gLayers = gRoot.append("g")
    .attr("class", "stream-layers")
    .attr("clip-path", `url(#${clipId})`);

  // ── Leyenda ───────────────────────────────────────────────────────────────
  _buildLegend(raw.genres, gRoot, innerW, innerH);

  // ── Renderizado inicial ───────────────────────────────────────────────────
  _render(raw, innerW, innerH, gAxisX, gAxisY, true);

  // ── Listeners globales ────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyHighlight(genre);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre  = null;
      _hoveredGenre = null;
      _restoreAll();
    })
  );

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Render / re-render de capas ──────────────────────────────────────────────
function _render(raw, innerW, innerH, gAxisX, gAxisY, isInitial = false) {
  const { data, genres } = raw;
  const offsetCfg = OFFSETS[_offsetKey];

  // Preparar datos para d3.stack
  // Si _feature !== "energy" necesitamos recomputar valores.
  // temporalTrends solo tiene "energy" precalculado.
  // Para otras features usamos featuresSample como fallback agregado.
  const tableData = _resolveData(data, genres);

  // ── Stack ─────────────────────────────────────────────────────────────────
  const stack = d3.stack()
    .keys(genres)
    .offset(offsetCfg.fn)
    .order(offsetCfg.normalize);

  const series = stack(tableData);

  // ── Actualizar escala Y ────────────────────────────────────────────────────
  const yExtent = [
    d3.min(series, layer => d3.min(layer, d => d[0])),
    d3.max(series, layer => d3.max(layer, d => d[1])),
  ];
  _yScale.domain(yExtent).nice();

  // ── Generador de área ─────────────────────────────────────────────────────
  const area = d3.area()
    .x((_, i) => _xScale(i))
    .y0(d => _yScale(d[0]))
    .y1(d => _yScale(d[1]))
    .curve(CURVE);

  // ── Ejes ──────────────────────────────────────────────────────────────────
  const xTicks = data.map((d, i) => ({ i, label: d.label }));
  gAxisX
    .transition().duration(isInitial ? 0 : TRANSITION)
    .call(
      d3.axisBottom(_xScale)
        .tickValues(xTicks.map(t => t.i))
        .tickFormat((_, i) => xTicks[i]?.label ?? "")
        .tickSize(0)
        .tickPadding(8)
    );
  gAxisX.selectAll("text")
    .attr("fill", "var(--text-muted)")
    .attr("font-size", "9px");
  gAxisX.select(".domain").attr("stroke", "var(--border-soft)");

  if (_offsetKey !== "wiggle") {
    gAxisY
      .transition().duration(isInitial ? 0 : TRANSITION)
      .call(
        d3.axisLeft(_yScale)
          .ticks(4)
          .tickSize(0)
          .tickPadding(8)
          .tickFormat(_offsetKey === "expand" ? d3.format(".0%") : d => fmt(d, 2))
      );
    gAxisY.selectAll("text").attr("fill", "var(--text-muted)").attr("font-size", "9px");
    gAxisY.select(".domain").remove();
  } else {
    gAxisY.selectAll("*").remove(); // No hay eje Y útil en wiggle
  }

  // ── Capas ─────────────────────────────────────────────────────────────────
  const paths = _gLayers.selectAll(".stream-layer")
    .data(series, d => d.key);

  // ENTER
  const entering = paths.enter()
    .append("path")
    .attr("class",      "stream-layer")
    .attr("data-genre", d => d.key)
    .attr("fill",       d => genreColor(d.key))
    .attr("fill-opacity", 0)
    .attr("stroke",     "rgba(0,0,0,0.25)")
    .attr("stroke-width", 0.5)
    .attr("d",          area);

  if (isInitial) {
    // Animación de entrada staggered
    entering.each(function(d, i) {
      d3.select(this)
        .transition()
        .delay(i * ENTER_DELAY)
        .duration(TRANSITION)
        .attr("fill-opacity", _layerOpacity(d.key));
    });
  } else {
    entering.attr("fill-opacity", d => _layerOpacity(d.key));
  }

  // UPDATE
  paths.merge(entering)
    .on("mouseenter", function(event, d) { _onLayerEnter(event, d, tableData); })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function(_, d) { _onLayerLeave(d.key); })
    .on("click",      (_, d) => {
      if (_activeGenre === d.key) clearAllFilters();
      else selectGenre(d.key);
    })
    .each(() => _pauseObserver())
    .transition().duration(isInitial ? 0 : TRANSITION)
    .ease(d3.easeCubicInOut)
    .attr("d", area)
    .attr("fill-opacity", d => _layerOpacity(d.key))
    .on("end", () => _resumeObserver(TRANSITION));

  // EXIT
  paths.exit()
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0)
    .remove();
}

// ─── Resolver datos según feature activa ──────────────────────────────────────
// temporalTrends solo tiene "energy". Para otras features, se agregan
// desde featuresSample en tiempo real (ya está en memoria).
function _resolveData(rawData, genres) {
  if (_feature === "energy") return rawData;  // ya viene precomputado

  const sample = store.getData("featuresSample");
  if (!sample) return rawData; // fallback

  // Calcular media de _feature por género × tier de popularidad
  // Los tiers en features_sample se reconstruyen usando el mismo binning
  // que usó preprocess.py: 10 bins iguales sobre [0,100]
  const binWidth = 100 / 10;
  const grouped  = d3.group(sample, d => d.track_genre, d => Math.min(9, Math.floor(d.popularity / binWidth)));

  return rawData.map((row, tierIdx) => {
    const entry = { pop_bin: row.pop_bin, label: row.label };
    genres.forEach(g => {
      const byTier = grouped.get(g);
      const points = byTier?.get(tierIdx) ?? [];
      entry[g] = points.length
        ? d3.mean(points, d => d[_feature]) ?? 0
        : (row[g] ?? 0); // fallback al valor de energy si no hay datos
    });
    return entry;
  });
}

// ─── Highlight coordinado ─────────────────────────────────────────────────────
function _applyHighlight(genre) {
  if (!_gLayers) return;
  _pauseObserver();
  _gLayers.selectAll(".stream-layer")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", d => genre
      ? (d.key === genre ? 0.92 : 0.07)
      : _layerOpacity(d.key)
    )
    .on("end", () => _resumeObserver(TRANSITION));
    
  if (genre) {
    _gLayers.selectAll(`.stream-layer[data-genre="${CSS.escape(genre)}"]`).raise();
  }
}

function _restoreAll() {
  if (!_gLayers) return;
  _pauseObserver();
  _gLayers.selectAll(".stream-layer")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", d => _layerOpacity(d.key))
    .on("end", () => _resumeObserver(TRANSITION));
}

function _layerOpacity(genre) {
  if (_activeGenre)  return _activeGenre  === genre ? 0.92 : 0.07;
  if (_hoveredGenre) return _hoveredGenre === genre ? 0.92 : 0.18;
  return 0.72;
}

// ─── Hover de capa ────────────────────────────────────────────────────────────
function _onLayerEnter(event, d, tableData) {
  _hoveredGenre = d.key;
  const color   = genreColor(d.key);

  if (!_activeGenre) {
    _gLayers.selectAll(".stream-layer")
      .attr("fill-opacity", layer => layer.key === d.key ? 0.92 : 0.18);
    _gLayers.selectAll(`.stream-layer[data-genre="${CSS.escape(d.key)}"]`).raise();
  }

  // Calcular stats de la capa para el tooltip
  const values  = tableData.map(row => row[d.key] ?? 0).filter(v => v > 0);
  const avgVal  = values.length ? d3.mean(values) : 0;
  const maxVal  = values.length ? d3.max(values)  : 0;
  const minVal  = values.length ? d3.min(values)  : 0;

  // Tier con valor máximo
  const maxTier = tableData.reduce((best, row) =>
    (row[d.key] ?? 0) > (best[d.key] ?? 0) ? row : best, tableData[0]);

  tooltip.show(event, tooltip.html({
    title:    d.key,
    color,
    rows: [
      { key: `${FEATURE_LABELS[_feature] || _feature} media`, value: fmt(avgVal, 3) },
      { key: "Máximo",     value: fmt(maxVal, 3) },
      { key: "Mínimo",     value: fmt(minVal, 3) },
      { key: "Pico en",    value: maxTier?.label ?? "—" },
    ],
    footer: "Clic para filtrar todos los gráficos",
  }));
}

function _onLayerLeave(genreKey) {
  _hoveredGenre = null;
  tooltip.hide();
  if (!_activeGenre) _restoreAll();
}

// ─── Controles de feature y offset ────────────────────────────────────────────
function _buildControls(genres) {
  const bar = document.createElement("div");
  bar.className  = "stream-controls";
  bar.style.cssText = `
    box-sizing: border-box;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px;
    height: 34px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
  `;

  // Feature selector
  const featSel = _makeSelect(
    "Feature:",
    STREAM_FEATURES,
    f => FEATURE_LABELS[f] || f,
    _feature,
    val => {
      _feature = val;
      _fullRedraw(genres);
    }
  );

  // Offset toggle (3 pills)
  const pillWrap = document.createElement("div");
  pillWrap.style.cssText = "display:flex;gap:4px;margin-left:4px;";

  Object.entries(OFFSETS).forEach(([key, cfg]) => {
    const pill = document.createElement("button");
    pill.textContent  = cfg.label;
    pill.dataset.key  = key;
    pill.style.cssText = `
      padding: 2px 10px;
      border-radius: 12px;
      border: 1px solid var(--border-soft);
      background: ${key === _offsetKey ? "var(--spotify-green-soft)" : "transparent"};
      color: ${key === _offsetKey ? "var(--spotify-green)" : "var(--text-muted)"};
      font-size: 10px;
      cursor: pointer;
      transition: var(--transition);
    `;
    pill.addEventListener("click", () => {
      _offsetKey = key;
      pillWrap.querySelectorAll("button").forEach(b => {
        const isActive = b.dataset.key === key;
        b.style.background = isActive ? "var(--spotify-green-soft)" : "transparent";
        b.style.color      = isActive ? "var(--spotify-green)"      : "var(--text-muted)";
        b.style.borderColor= isActive ? "var(--spotify-green)"      : "var(--border-soft)";
      });
      _fullRedraw(genres);
    });
    pillWrap.appendChild(pill);
  });

  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);";
  hint.textContent   = "Hover para detalles · Clic para filtrar";

  bar.appendChild(featSel);
  bar.appendChild(pillWrap);
  bar.appendChild(hint);
  _container.appendChild(bar);
}

function _makeSelect(labelText, options, labelFn, current, onChange) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:6px;";

  const lbl = document.createElement("span");
  lbl.textContent   = labelText;
  lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;";

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
  options.forEach(opt => {
    const o   = document.createElement("option");
    o.value   = opt;
    o.text    = labelFn(opt);
    if (opt === current) o.selected = true;
    sel.appendChild(o);
  });
  sel.addEventListener("change", e => onChange(e.target.value));

  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

// ─── Leyenda inline ───────────────────────────────────────────────────────────
function _buildLegend(genres, gRoot, innerW, innerH) {
  // Leyenda minimalista a la derecha del SVG
  const legendG = gRoot.append("g")
    .attr("class", "stream-legend")
    .attr("transform", `translate(${innerW + 12}, 10)`);

  const itemH   = 16;
  const maxShow = Math.min(genres.length, 10);

  genres.slice(0, maxShow).forEach((g, i) => {
    const row = legendG.append("g")
      .attr("class",      "stream-legend-item")
      .attr("data-genre", g)
      .attr("transform",  `translate(0,${i * itemH})`)
      .style("cursor",    "pointer")
      .on("click", () => {
        if (_activeGenre === g) clearAllFilters();
        else selectGenre(g);
      });

    row.append("rect")
      .attr("x",      0).attr("y", 1)
      .attr("width",  8).attr("height", 8)
      .attr("rx",     2)
      .attr("fill",   genreColor(g));

    row.append("text")
      .attr("x",       14)
      .attr("y",       9)
      .attr("font-size", "10px")
      .attr("fill",    "var(--text-muted)")
      .text(g.length > 12 ? g.slice(0, 10) + "…" : g);
  });
}

// ─── Re-render completo al cambiar feature u offset ──────────────────────────
function _fullRedraw(genres) {
  const raw = store.getData("temporalTrends");
  if (!raw || !_svg) return;

  const { w, h }  = _dims();
  const innerW    = w - MARGIN.left - MARGIN.right;
  const innerH    = h - MARGIN.top  - MARGIN.bottom;
  const gAxisX    = _svg.select(".stream-axis-x");
  const gAxisY    = _svg.select(".stream-axis-y");

  _updatePanelTitle();
  _render(raw, innerW, innerH, gAxisX, gAxisY, false);
}

// ─── Rebuild en resize ────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (Math.abs(w - _prevW) < 6 && Math.abs(h - _prevH) < 6) return;
  const prevGenre = _activeGenre;
  _build();
  if (prevGenre) { _activeGenre = prevGenre; _applyHighlight(prevGenre); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 240), h: Math.max(r.height, 160) };
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
    const name = FEATURE_LABELS[_feature] || _feature;
    const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
    h2.textContent = `${cap(name)} por tier de popularidad`;
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

export default { initStreamgraph };