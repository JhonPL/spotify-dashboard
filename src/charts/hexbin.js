/**
 * hexbin.js — Hexbin Density Map v1
 *
 * Visualiza la densidad de canciones en un espacio 2D de audio features.
 * Cada hexágono representa una celda de densidad; el color y tamaño codifican
 * cuántas canciones caen en esa región.
 *
 * Features:
 *   - d3-hexbin para agrupación eficiente de 5700+ puntos en hexágonos
 *   - Ejes intercambiables con dropdown (X / Y) — mismo set que el scatterplot
 *   - Dos modos de codificación: color por densidad / color por feature media
 *   - Escala de color secuencial oscuro → verde Spotify
 *   - Zoom + pan con d3.zoom (rueda del mouse)
 *   - Tooltip con nº de canciones, feature media y top-3 géneros en esa celda
 *   - Highlight coordinado: genre:select → hexágonos que no pertenecen al
 *     género se atenúan; los que sí, se iluminan
 *   - Leyenda de color interactiva (gradiente horizontal)
 *   - ResizeObserver con debounce
 *   - Crosshair siguiendo el cursor para facilitar lectura de ejes
 *
 * Datos: features_sample.json → array de tracks con audio features
 *
 * Uso:
 *   import { initHexbin } from "../charts/hexbin.js";
 *   initHexbin(document.getElementById("chart-hexbin"));
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import {
  initGenreScale, genreColor,
  FEATURE_LABELS, FEATURE_COLORS, fmt,
} from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN        = { top: 20, right: 30, bottom: 75, left: 75 };
const CTRL_H        = 34;
const TRANSITION    = 300;
const DEBOUNCE_MS   = 380;
const MIN_HEX_R     = 4;
const MAX_HEX_R     = 24;   // radio base del hexágono; se ajusta con zoom

// Features disponibles para ejes
const AXIS_FEATURES = [
  "energy", "danceability", "valence", "acousticness",
  "speechiness", "liveness", "instrumentalness", "popularity",
];

// Modos de coloreo
const COLOR_MODES = {
  density:  "Densidad (canciones)",
  energy:   "Energy media",
  valence:  "Valence media",
  popularity: "Popularidad media",
};

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container   = null;
let _svg         = null;
let _gHex        = null;
let _gAxis       = null;
let _gCross      = null;   // crosshair
let _xScale      = null;
let _yScale      = null;
let _colorScale  = null;
let _zoom        = null;
let _hexbin      = null;
let _resizeObs   = null;
let _obsTimer    = null;
let _unsubs      = [];
let _prevW       = 0;
let _prevH       = 0;

let _featureX    = "energy";
let _featureY    = "danceability";
let _colorMode   = "density";
let _activeGenre = null;
let _hexRadius   = 18;   // radio actual (ajustado por resize)

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initHexbin(container) {
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

// ─── Build ────────────────────────────────────────────────────────────────────
function _build() {
  const data = store.getData("featuresSample");
  if (!data || !_container) return;

  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  _prevW = w;
  _prevH = h;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  const genres = [...new Set(data.map(d => d.track_genre))];
  initGenreScale(genres);

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles ─────────────────────────────────────────────────────────────
  _buildControls();

  // ── Dimensiones ───────────────────────────────────────────────────────────
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom - CTRL_H;

  // Radio del hexágono adaptativo al tamaño del panel
  _hexRadius = Math.max(MIN_HEX_R, Math.min(MAX_HEX_R, Math.floor(innerW / 28)));

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

  // Clip (El rect debe estar en 0,0 porque el grupo ya tiene el translate)
  const clipId = "hb-clip-" + Math.random().toString(36).slice(2, 7);
  _svg.append("defs").append("clipPath").attr("id", clipId)
    .append("rect")
      .attr("x", 0).attr("y", 0)
      .attr("width", innerW).attr("height", innerH);

  const gRoot = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // ── Escalas ───────────────────────────────────────────────────────────────
  // Forzar que las escalas empiecen en 0 para coherencia (la mayoría de features son 0-1)
  _xScale = d3.scaleLinear()
    .domain([0, d3.max(data, d => +d[_featureX])]).nice()
    .range([0, innerW]);

  _yScale = d3.scaleLinear()
    .domain([0, d3.max(data, d => +d[_featureY])]).nice()
    .range([innerH, 0]);

  // 1. Capa de fondo (Grid)
  const gGrid = gRoot.append("g").attr("class", "hb-grid")
    .style("pointer-events", "none");
  _drawGrid(gGrid, innerW, innerH);

  // 2. Capa de HEXÁGONOS (con clip)
  const gClipped = gRoot.append("g")
    .attr("class", "hb-clipped-area")
    .attr("clip-path", `url(#${clipId})`);
  _gHex = gClipped.append("g").attr("class", "hb-hexagons");

  // Hexbin layout
  _hexbin = _createHexbin(_hexRadius, innerW, innerH);
  const projected = data.map(d => ({
    x: _xScale(+d[_featureX]),
    y: _yScale(+d[_featureY]),
    raw: d,
  }));
  const bins = _hexbin.bin(projected);
  _colorScale = _buildColorScale(bins);

  _renderHexagons(bins, true);

  // 3. Capa de EJES (encima de los hexágonos)
  _gAxis = gRoot.append("g").attr("class", "hb-axes");
  _drawAxes(innerH, innerW);

  // 4. Capa de CROSSHAIR (al final para estar arriba de todo)
  _gCross = gRoot.append("g").attr("class", "hb-crosshair")
    .style("pointer-events", "none")
    .style("opacity", 0);

  _gCross.append("line").attr("class", "hb-cross-x")
    .attr("y1", 0).attr("y2", innerH)
    .attr("stroke", "rgba(255,255,255,0.15)").attr("stroke-dasharray", "3 4");
  _gCross.append("line").attr("class", "hb-cross-y")
    .attr("x1", 0).attr("x2", innerW)
    .attr("stroke", "rgba(255,255,255,0.15)").attr("stroke-dasharray", "3 4");

  // Mover crosshair con el mouse
  _svg.on("mousemove.crosshair", function(event) {
    const [mx, my] = d3.pointer(event, gRoot.node());
    if (mx < 0 || mx > innerW || my < 0 || my > innerH) {
      _gCross.style("opacity", 0);
      return;
    }
    _gCross.style("opacity", 1);
    _gCross.select(".hb-cross-x").attr("x1", mx).attr("x2", mx);
    _gCross.select(".hb-cross-y").attr("y1", my).attr("y2", my);
  });
  _svg.on("mouseleave.crosshair", () => _gCross.style("opacity", 0));

  // ── Leyenda de color ──────────────────────────────────────────────────────
  _buildLegend(bins, innerW, innerH);

  // ── Zoom ─────────────────────────────────────────────────────────────────
  _zoom = d3.zoom()
    .scaleExtent([0.6, 8])
    .translateExtent([[-innerW * 0.2, -innerH * 0.2], [innerW * 1.2, innerH * 1.2]])
    .on("zoom", ({ transform }) => {
      _gHex.attr("transform", transform);

      // Actualizar ejes
      const newX = transform.rescaleX(_xScale);
      const newY = transform.rescaleY(_yScale);
      _gAxis.select(".hb-axis-x")
        .call(d3.axisBottom(newX).ticks(5).tickSize(0).tickPadding(8));
      _gAxis.select(".hb-axis-y")
        .call(d3.axisLeft(newY).ticks(5).tickSize(0).tickPadding(8));
      _gAxis.selectAll(".axis text")
        .attr("fill", "var(--text-muted)").attr("font-size", "10px");
      _gAxis.selectAll(".domain").attr("stroke", "rgba(255,255,255,0.2)");
    });

  _svg.call(_zoom).on("dblclick.zoom", null);

  // Botón reset zoom
  _buildZoomReset();

  // ── Linked views ─────────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyGenreHighlight(bins, genre);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _restoreAll(bins);
    })
  );

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Hexbin propio (sin dependencia externa) ──────────────────────────────────
function _createHexbin(radius, w, h) {
  const dx = radius * 2 * Math.sin(Math.PI / 3);   // ancho de columna
  const dy = radius * 1.5;                           // alto de fila

  // Genera el path SVG de un hexágono regular centrado en (0,0)
  function hexPath(r) {
    const pts = d3.range(6).map(i => {
      const a = (Math.PI / 180) * (60 * i - 30);
      return `${r * Math.cos(a)},${r * Math.sin(a)}`;
    });
    return `M${pts.join("L")}Z`;
  }

  // Calcula el centro del bin más cercano a (px, py)
  function binCenter(px, py) {
    // Columna y fila con offset para filas pares/impares
    const col  = Math.round(px / dx);
    const row  = Math.round(py / dy);
    // Offset de media celda en columnas impares
    const xOff = (row % 2 === 0) ? 0 : dx / 2;
    const cx   = col * dx + xOff;
    const cy   = row * dy;

    // Comparar con los 7 centros vecinos (inclusivo centro) y devolver el más cercano
    const candidates = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const r   = row + dr;
        const xo  = (r % 2 === 0) ? 0 : dx / 2;
        const c   = col + dc;
        candidates.push({ cx: c * dx + xo, cy: r * dy });
      }
    }
    return candidates.reduce((best, cand) => {
      const dCand = (cand.cx - px) ** 2 + (cand.cy - py) ** 2;
      const dBest = (best.cx  - px) ** 2 + (best.cy  - py) ** 2;
      return dCand < dBest ? cand : best;
    }, { cx, cy });
  }

  function bin(points) {
    const map = new Map();
    points.forEach(pt => {
      const { cx, cy } = binCenter(pt.x, pt.y);
      const key = `${cx.toFixed(2)},${cy.toFixed(2)}`;
      if (!map.has(key)) map.set(key, { cx, cy, points: [] });
      map.get(key).points.push(pt);
    });
    // Filtrar bins que queden fuera del área de los ejes
    return [...map.values()].filter(b => b.cx >= 0 && b.cy >= 0 && b.cx <= w && b.cy <= h);
  }

  return { bin, hexPath: r => hexPath(r ?? radius), radius };
}

// ─── Escala de color dinámica ─────────────────────────────────────────────────
function _buildColorScale(bins) {
  if (_colorMode === "density") {
    const maxCount = d3.max(bins, b => b.points.length);
    return d3.scaleSequential()
      .domain([0, maxCount])
      .interpolator(d3.interpolate("#0d1f14", "#1DB954"));
  }

  const feature = _colorMode;
  const vals = bins.map(b => d3.mean(b.points, p => +p.raw[feature]));
  const [lo, hi] = d3.extent(vals);
  const color = FEATURE_COLORS[feature] || "#1DB954";
  return d3.scaleSequential()
    .domain([lo, hi])
    .interpolator(d3.interpolate("#111111", color));
}

// ─── Valor de color para un bin ───────────────────────────────────────────────
function _colorValue(bin) {
  if (_colorMode === "density") return bin.points.length;
  return d3.mean(bin.points, p => +p.raw[_colorMode]) ?? 0;
}

// ─── Render de hexágonos ──────────────────────────────────────────────────────
function _renderHexagons(bins, isInitial) {
  if (!_gHex) return;

  const hexPath = _hexbin.hexPath(_hexRadius - 1.5);

  const hexes = _gHex.selectAll(".hb-hex")
    .data(bins, b => `${b.cx.toFixed(1)},${b.cy.toFixed(1)}`)
    .join("path")
      .attr("class",     "hb-hex")
      .attr("d",         hexPath)
      .attr("transform", b => `translate(${b.cx},${b.cy})`)
      .attr("fill",      b => _colorScale(_colorValue(b)))
      .attr("stroke",    "rgba(0,0,0,0.35)")
      .attr("stroke-width", 0.6)
      .style("cursor",   "pointer");

  if (isInitial) {
    hexes
      .attr("fill-opacity", 0)
      .attr("transform",   b => `translate(${b.cx},${b.cy}) scale(0.1)`)
      .transition()
      .delay((_, i) => i * 2)
      .duration(TRANSITION)
      .ease(d3.easeBackOut.overshoot(0.4))
      .attr("fill-opacity", b => _hexOpacity(b))
      .attr("transform",   b => `translate(${b.cx},${b.cy})`);
  } else {
    hexes
      .transition().duration(TRANSITION)
      .attr("fill",         b => _colorScale(_colorValue(b)))
      .attr("fill-opacity", b => _hexOpacity(b))
      .attr("transform",   b => `translate(${b.cx},${b.cy})`);
  }

  hexes
    .on("mouseenter", function(event, b) {
      if (_activeGenre) {
        const hasGenre = b.points.some(p => p.raw.track_genre === _activeGenre);
        if (!hasGenre) return;
      }
      d3.select(this)
        .interrupt()
        .transition().duration(80)
        .attr("fill-opacity", 1)
        .attr("stroke", "rgba(255,255,255,0.5)")
        .attr("stroke-width", 1.5);

      _showTooltip(event, b);
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function(_, b) {
      tooltip.hide();
      d3.select(this)
        .interrupt()
        .transition().duration(150)
        .attr("fill-opacity", _hexOpacity(b))
        .attr("stroke", "rgba(0,0,0,0.35)")
        .attr("stroke-width", 0.6);
    })
    .on("click", (_, b) => {
      // Clic en hexágono → filtrar por género más frecuente en ese bin
      const topGenre = _topGenre(b);
      if (topGenre) {
        if (_activeGenre === topGenre) clearAllFilters();
        else selectGenre(topGenre);
      }
    });
}

// ─── Opacidad base de un hexágono ─────────────────────────────────────────────
function _hexOpacity(b) {
  if (!_activeGenre) return 0.88;
  const hasGenre = b.points.some(p => p.raw.track_genre === _activeGenre);
  return hasGenre ? 0.92 : 0.08;
}

// ─── Highlight de género ──────────────────────────────────────────────────────
function _applyGenreHighlight(bins, genre) {
  if (!_gHex) return;
  _pauseObserver();
  _gHex.selectAll(".hb-hex")
    .interrupt()
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function(b) {
      return b.points.some(p => p.raw.track_genre === genre) ? 0.92 : 0.06;
    })
    .on("end", () => _resumeObserver(TRANSITION));
}

function _restoreAll(bins) {
  if (!_gHex) return;
  _pauseObserver();
  _gHex.selectAll(".hb-hex")
    .interrupt()
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.88)
    .on("end", () => _resumeObserver(TRANSITION));
}

// ─── Grid ─────────────────────────────────────────────────────────────────────
function _drawGrid(gGrid, innerW, innerH) {
  gGrid.selectAll(".hb-grid-x")
    .data(_xScale.ticks(5))
    .join("line")
      .attr("class", "hb-grid-x")
      .attr("x1", d => _xScale(d)).attr("x2", d => _xScale(d))
      .attr("y1", 0).attr("y2", innerH)
      .attr("stroke", "rgba(255,255,255,0.04)").attr("stroke-width", 0.8);

  gGrid.selectAll(".hb-grid-y")
    .data(_yScale.ticks(5))
    .join("line")
      .attr("class", "hb-grid-y")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", d => _yScale(d)).attr("y2", d => _yScale(d))
      .attr("stroke", "rgba(255,255,255,0.04)").attr("stroke-width", 0.8);
}

// ─── Ejes ─────────────────────────────────────────────────────────────────────
function _drawAxes(innerH, innerW) {
  // Eje X
  _gAxis.append("g")
    .attr("class", "axis hb-axis-x")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(_xScale).ticks(5).tickSize(6).tickPadding(8))
    .call(g => g.select(".domain").attr("stroke", "rgba(255,255,255,0.2)"))
    .selectAll("text")
      .attr("fill", "var(--text-muted)").attr("font-size", "10px");

  // Eje Y
  _gAxis.append("g")
    .attr("class", "axis hb-axis-y")
    .call(d3.axisLeft(_yScale).ticks(5).tickSize(6).tickPadding(8))
    .call(g => g.select(".domain").attr("stroke", "rgba(255,255,255,0.2)"))
    .selectAll("text")
      .attr("fill", "var(--text-muted)").attr("font-size", "10px");

  // Label X
  _svg.append("text")
    .attr("class", "hb-label-x")
    .attr("x", MARGIN.left + innerW / 2)
    .attr("y", innerH + MARGIN.top + 50) // Más espacio
    .attr("text-anchor", "middle")
    .attr("fill",  FEATURE_COLORS[_featureX] || "var(--text-muted)")
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .text(FEATURE_LABELS[_featureX] || _featureX);

  // Label Y
  _svg.append("text")
    .attr("class", "hb-label-y")
    .attr("transform", `translate(18, ${MARGIN.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill",  FEATURE_COLORS[_featureY] || "var(--text-muted)")
    .attr("font-size", "11px")
    .attr("font-weight", "600")
    .text(FEATURE_LABELS[_featureY] || _featureY);
}

// ─── Tooltip ──────────────────────────────────────────────────────────────────
function _showTooltip(event, b) {
  const count = b.points.length;
  const topG  = _topGenre(b);
  const color = topG ? genreColor(topG) : "#1DB954";

  // Top 3 géneros en el bin
  const genreCounts = d3.rollup(b.points, v => v.length, p => p.raw.track_genre);
  const top3 = [...genreCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);

  const rows = [
    { key: "Canciones", value: count },
    { key: FEATURE_LABELS[_featureX] || _featureX, value: fmt(d3.mean(b.points, p => +p.raw[_featureX]), 3) },
    { key: FEATURE_LABELS[_featureY] || _featureY, value: fmt(d3.mean(b.points, p => +p.raw[_featureY]), 3) },
    { key: "Popularidad media", value: fmt(d3.mean(b.points, p => +p.raw.popularity), 1) },
  ];

  const genreStr = top3.map(([g, n]) => `${g} (${n})`).join(", ");

  tooltip.show(event, tooltip.html({
    title:    `Densidad · ${count} track${count !== 1 ? "s" : ""}`,
    color,
    rows,
    footer:   `Géneros: ${genreStr}`,
  }));
}

// ─── Top género de un bin ─────────────────────────────────────────────────────
function _topGenre(b) {
  if (!b.points.length) return null;
  const counts = d3.rollup(b.points, v => v.length, p => p.raw.track_genre);
  return [...counts.entries()].reduce((a, c) => c[1] > a[1] ? c : a)[0];
}

// ─── Leyenda de color ─────────────────────────────────────────────────────────
function _buildLegend(bins, innerW, innerH) {
  const lgW  = Math.min(180, innerW * 0.5);
  const lgH  = 8;
  const lgX  = innerW - lgW;
  const lgY  = innerH + 42; // Un poco más abajo para no chocar con el eje
  const uid  = Math.random().toString(36).slice(2, 6);

  const defs = _svg.select("defs").size()
    ? _svg.select("defs")
    : _svg.append("defs");

  const gradId = `hb-lg-${uid}`;
  const grad = defs.append("linearGradient")
    .attr("id", gradId).attr("x1","0%").attr("x2","100%");

  const sampleDomain = _colorScale.domain();
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t  = i / steps;
    const v  = sampleDomain[0] + t * (sampleDomain[1] - sampleDomain[0]);
    grad.append("stop")
      .attr("offset", `${t * 100}%`)
      .attr("stop-color", _colorScale(v));
  }

  const gRoot = _svg.select("g");
  const lgG   = gRoot.append("g")
    .attr("class", "hb-legend")
    .attr("transform", `translate(${lgX},${lgY})`)
    .style("pointer-events", "none");

  lgG.append("rect")
    .attr("width", lgW).attr("height", lgH).attr("rx", 3)
    .attr("fill", `url(#${gradId})`);

  // Labels
  const modeLabel = COLOR_MODES[_colorMode] || _colorMode;
  const lo = _colorMode === "density"
    ? "0"
    : fmt(sampleDomain[0], 2);
  const hi = _colorMode === "density"
    ? `${Math.round(sampleDomain[1])} canciones`
    : fmt(sampleDomain[1], 2);

  lgG.append("text").attr("x", 0).attr("y", lgH + 11)
    .attr("fill", "var(--text-hint)").attr("font-size", "9px")
    .attr("text-anchor", "start").text(lo);
  lgG.append("text").attr("x", lgW).attr("y", lgH + 11)
    .attr("fill", "var(--text-hint)").attr("font-size", "9px")
    .attr("text-anchor", "end").text(hi);
  lgG.append("text").attr("x", lgW / 2).attr("y", lgH + 22)
    .attr("fill", "var(--text-muted)").attr("font-size", "9.5px")
    .attr("text-anchor", "middle").text(modeLabel);
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls() {
  const bar = document.createElement("div");
  bar.style.cssText = `
    box-sizing:border-box;display:flex;align-items:center;gap:14px;
    padding:0 14px;height:${CTRL_H}px;
    border-bottom:1px solid var(--border-subtle);
    font-size:11px;color:var(--text-muted);
    overflow-x:auto;overflow-y:hidden;
    scrollbar-width:none; /* Firefox */
  `;
  bar.style.webkitScrollbar = "display:none"; // Chrome/Safari

  // ─ Axis selects ─
  bar.appendChild(_axisSelect("Eje X →", _featureX, "x"));
  bar.appendChild(_axisSelect("Eje Y ↑", _featureY, "y"));

  // Separador
  const sep = document.createElement("div");
  sep.style.cssText = "width:1px;height:18px;background:var(--border-subtle);flex-shrink:0;";
  bar.appendChild(sep);

  // ─ Color mode pills ─
  const cLabel = document.createElement("span");
  cLabel.textContent  = "Color:";
  cLabel.style.cssText = "font-size:10px;white-space:nowrap;";
  bar.appendChild(cLabel);

  const pillWrap = document.createElement("div");
  pillWrap.style.cssText = "display:flex;gap:4px;";

  Object.entries(COLOR_MODES).forEach(([key, label]) => {
    const pill = document.createElement("button");
    pill.dataset.key  = key;
    pill.textContent  = label.split(" ")[0]; // "Densidad", "Energy", etc.
    pill.title        = label;
    const active      = key === _colorMode;
    pill.style.cssText = `
      padding:2px 9px;border-radius:12px;cursor:pointer;font-size:10px;
      border:1px solid ${active ? "var(--spotify-green)" : "var(--border-soft)"};
      background:${active ? "var(--spotify-green-soft)" : "transparent"};
      color:${active ? "var(--spotify-green)" : "var(--text-muted)"};
      transition:var(--transition);white-space:nowrap;
    `;
    pill.addEventListener("click", () => {
      _colorMode = key;
      pillWrap.querySelectorAll("button").forEach(b => {
        const a = b.dataset.key === key;
        b.style.background  = a ? "var(--spotify-green-soft)" : "transparent";
        b.style.color       = a ? "var(--spotify-green)" : "var(--text-muted)";
        b.style.borderColor = a ? "var(--spotify-green)" : "var(--border-soft)";
      });
      _colorMode = key;
      _fullRedraw();
    });
    pillWrap.appendChild(pill);
  });
  bar.appendChild(pillWrap);

  // Hint (ahora con padding para que no se pegue al final)
  const hint = document.createElement("span");
  hint.style.cssText = "font-size:10px;color:var(--text-hint);white-space:nowrap;padding-right:20px;";
  hint.textContent   = "Rueda para zoom · Hover para stats · Clic para filtrar";
  bar.appendChild(hint);

  _container.appendChild(bar);
}

function _axisSelect(labelText, current, axis) {
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
  AXIS_FEATURES.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f; opt.text = FEATURE_LABELS[f] || f;
    if (f === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", e => {
    if (axis === "x") _featureX = e.target.value;
    else              _featureY = e.target.value;
    _updatePanelTitle();
    _fullRedraw();
  });

  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  return wrap;
}

// ─── Botón reset zoom ──────────────────────────────────────────────────────────
function _buildZoomReset() {
  const btn = document.createElement("button");
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
  btn.addEventListener("mouseenter", () => { btn.style.background="var(--bg-hover)"; btn.style.color="#fff"; });
  btn.addEventListener("mouseleave", () => { btn.style.background="var(--bg-elevated)"; btn.style.color="var(--text-secondary)"; });
  btn.addEventListener("click", () => {
    _svg.transition().duration(400).call(_zoom.transform, d3.zoomIdentity);
  });
  _container.style.position = "relative";
  _container.appendChild(btn);
}

// ─── Re-render al cambiar feature / modo ──────────────────────────────────────
function _fullRedraw() {
  const data = store.getData("featuresSample");
  if (!data || !_gHex) return;

  const { w, h }  = _dims();
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom - CTRL_H;

  // Actualizar escalas empezando en 0
  _xScale.domain([0, d3.max(data, d => +d[_featureX])]).nice();
  _yScale.domain([0, d3.max(data, d => +d[_featureY])]).nice();

  const projected = data.map(d => ({
    x: _xScale(+d[_featureX]),
    y: _yScale(+d[_featureY]),
    raw: d,
  }));

  _hexbin = _createHexbin(_hexRadius, innerW, innerH);
  const bins = _hexbin.bin(projected);
  _colorScale = _buildColorScale(bins);

  _renderHexagons(bins, false);

  // Actualizar ejes y labels
  _gAxis.select(".hb-axis-x")
    .transition().duration(TRANSITION)
    .call(d3.axisBottom(_xScale).ticks(5).tickSize(0).tickPadding(8));
  _gAxis.select(".hb-axis-y")
    .transition().duration(TRANSITION)
    .call(d3.axisLeft(_yScale).ticks(5).tickSize(0).tickPadding(8));
  _gAxis.selectAll(".axis text")
    .attr("fill", "var(--text-muted)").attr("font-size", "10px");
  _gAxis.selectAll(".domain").attr("stroke", "rgba(255,255,255,0.2)");

  _svg.select(".hb-label-x")
    .attr("fill", FEATURE_COLORS[_featureX] || "var(--text-muted)")
    .text(FEATURE_LABELS[_featureX] || _featureX);
  _svg.select(".hb-label-y")
    .attr("fill", FEATURE_COLORS[_featureY] || "var(--text-muted)")
    .text(FEATURE_LABELS[_featureY] || _featureY);

  // Leyenda
  _svg.select(".hb-legend").remove();
  _buildLegend(bins, innerW, innerH);

  // Reaplicar highlight si hay filtro activo
  if (_activeGenre) _applyGenreHighlight(bins, _activeGenre);
}

// ─── Rebuild en resize ────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  if (Math.abs(w - _prevW) < 8 && Math.abs(h - _prevH) < 8) return;
  const prevGenre = _activeGenre;
  _build();
  if (prevGenre) { _activeGenre = prevGenre; }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 240), h: Math.max(r.height, 200) };
}

function _updatePanelTitle() {
  const panel = _container.closest(".panel");
  if (!panel) return;
  const h2 = panel.querySelector(".panel__header h2");
  if (!h2) return;
  const xLabel = FEATURE_LABELS[_featureX] || _featureX;
  const yLabel = FEATURE_LABELS[_featureY] || _featureY;
  h2.textContent = `Densidad ${xLabel} × ${yLabel}`;
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

export default { initHexbin };