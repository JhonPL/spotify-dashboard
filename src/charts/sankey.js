/**
 * sankey.js — Sankey Diagram v1
 *
 * Visualiza el flujo: GÉNERO → TIER DE ENERGÍA → TIER DE POPULARIDAD
 *
 * Tres capas de nodos:
 *   1. Géneros (top 10 por track_count desde genres_summary)
 *   2. Nivel de energía: Alta / Media / Baja  (calculado sobre featuresSample)
 *   3. Tier de popularidad: Alta / Media / Baja
 *
 * El grosor de cada flujo es proporcional al número de canciones
 * que pasan por ese camino.
 *
 * Features:
 *   - d3-sankey implementado manualmente (sin librería externa)
 *   - Nodos arrastrables verticalmente
 *   - Hover de flujo → tooltip con conteo y porcentaje
 *   - Hover de nodo → resalta todos los flujos de ese nodo
 *   - Clic en nodo de género → selectGenre() (linked views)
 *   - Recibe genre:select / filters:clear del bus
 *   - Gradientes lineales en cada flujo (color source → color target)
 *   - Animación de entrada: flujos crecen desde ancho 0
 *   - ResizeObserver con debounce
 *
 * Datos:
 *   - genres_summary.json  → top géneros
 *   - features_sample.json → calcular flujos reales por canción
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import { genreColor, initGenreScale, fmt } from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN      = { top: 24, right: 140, bottom: 24, left: 140 };
const TRANSITION  = 500;
const DEBOUNCE_MS = 380;
const NODE_W      = 18;    // ancho del rectángulo de nodo
const NODE_PAD    = 14;    // padding vertical entre nodos
const TOP_N       = 10;    // top géneros a mostrar

// Bins de energía y popularidad
const ENERGY_BINS = [
  { label: "Energía alta",   lo: 0.65, hi: 1.0,  color: "#f43f5e" },
  { label: "Energía media",  lo: 0.35, hi: 0.65, color: "#ffa502" },
  { label: "Energía baja",   lo: 0.0,  hi: 0.35, color: "#38bdf8" },
];
const POP_BINS = [
  { label: "Popular alta",   lo: 60,  hi: 100, color: "#1DB954" },
  { label: "Popular media",  lo: 30,  hi: 60,  color: "#2ed573" },
  { label: "Popular baja",   lo: 0,   hi: 30,  color: "#6a6a6a" },
];

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container   = null;
let _svg         = null;
let _gLinks      = null;
let _gNodes      = null;
let _defs        = null;
let _resizeObs   = null;
let _unsubs      = [];
let _prevW       = 0;
let _prevH       = 0;
let _activeGenre = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initSankey(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  // Necesitamos ambos datasets
  const summary = store.getData("genresSummary");
  const sample  = store.getData("featuresSample");

  if (!summary || !sample) {
    _container.classList.add("loading");
    let loaded = 0;
    const needed = ["genresSummary", "featuresSample"];
    const unsub = on("data:ready", ({ key }) => {
      if (!needed.includes(key)) return;
      loaded++;
      if (loaded >= needed.filter(k => !store.getData(k) === false).length ||
          (store.getData("genresSummary") && store.getData("featuresSample"))) {
        unsub();
        _container.classList.remove("loading");
        _build();
      }
    });
    return;
  }
  _build();
}

// ─── Build ────────────────────────────────────────────────────────────────────
function _build() {
  const summary = store.getData("genresSummary");
  const sample  = store.getData("featuresSample");
  if (!summary || !sample || !_container) return;

  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  _prevW = w; _prevH = h;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  // Top géneros por track_count
  const topGenres = [...summary]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N)
    .map(d => d.track_genre);

  initGenreScale(topGenres);

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Construir grafo Sankey ──────────────────────────────────────────────
  const { nodes, links } = _buildGraph(topGenres, sample);

  // ── SVG ──────────────────────────────────────────────────────────────────
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom;

  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top", "0").style("left", "0")
    .style("width", "100%").style("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  _defs   = _svg.append("defs");
  _gLinks = _svg.append("g").attr("class", "sk-links")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);
  _gNodes = _svg.append("g").attr("class", "sk-nodes")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // ── Layout ────────────────────────────────────────────────────────────────
  _layoutSankey(nodes, links, innerW, innerH);

  // ── Gradientes ────────────────────────────────────────────────────────────
  _buildGradients(links);

  // ── Dibujar links ─────────────────────────────────────────────────────────
  _drawLinks(links, nodes, innerH);

  // ── Dibujar nodos ─────────────────────────────────────────────────────────
  _drawNodes(nodes, links, innerH);

  // ── Título de columnas ────────────────────────────────────────────────────
  _drawColumnLabels(innerW, innerH);

  // ── Listeners ────────────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyHighlight(genre, nodes);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _restoreAll();
    })
  );

  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Construir grafo: nodos + links ──────────────────────────────────────────
function _buildGraph(topGenres, sample) {
  // Solo canciones de los top géneros
  const filtered = sample.filter(d => topGenres.includes(d.track_genre));

  // Nodos: géneros (col 0) + bins energía (col 1) + bins popularidad (col 2)
  const nodes = [
    ...topGenres.map((g, i) => ({
      id: `genre-${i}`, label: g, col: 0,
      color: genreColor(g), genre: g,
    })),
    ...ENERGY_BINS.map((b, i) => ({
      id: `energy-${i}`, label: b.label, col: 1,
      color: b.color, lo: b.lo, hi: b.hi,
    })),
    ...POP_BINS.map((b, i) => ({
      id: `pop-${i}`, label: b.label, col: 2,
      color: b.color, lo: b.lo, hi: b.hi,
    })),
  ];

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Contadores de flujo: Map de "source-id|target-id" → count
  const flowMap = new Map();

  filtered.forEach(d => {
    const genre   = d.track_genre;
    const gIdx    = topGenres.indexOf(genre);
    if (gIdx < 0) return;

    const energy  = +d.energy;
    const pop     = +d.popularity;

    const eIdx    = ENERGY_BINS.findIndex(b => energy >= b.lo && energy < b.hi);
    const pIdx    = POP_BINS.findIndex(b => pop >= b.lo && pop < b.hi);
    if (eIdx < 0 || pIdx < 0) return;

    // Flujo género → energía
    const k1 = `genre-${gIdx}|energy-${eIdx}`;
    flowMap.set(k1, (flowMap.get(k1) ?? 0) + 1);

    // Flujo energía → popularidad
    const k2 = `energy-${eIdx}|pop-${pIdx}`;
    flowMap.set(k2, (flowMap.get(k2) ?? 0) + 1);
  });

  // Construir links
  const links = [];
  flowMap.forEach((value, key) => {
    if (value === 0) return;
    const [srcId, tgtId] = key.split("|");
    const source = nodeById.get(srcId);
    const target = nodeById.get(tgtId);
    if (source && target) {
      links.push({ source, target, value,
        id: `${srcId}-${tgtId}`,
      });
    }
  });

  // Calcular valor total de cada nodo
  nodes.forEach(n => {
    n.value = links
      .filter(l => l.source === n || l.target === n)
      .reduce((s, l) => s + l.value, 0) / (n.col === 1 ? 2 : 1);
      // col 1 (energía) aparece en ambos lados → dividir para no doblar
  });

  return { nodes, links };
}

// ─── Layout Sankey manual ────────────────────────────────────────────────────
function _layoutSankey(nodes, links, W, H) {
  const cols = [0, 1, 2];
  const colX = { 0: 0, 1: W / 2 - NODE_W / 2, 2: W - NODE_W };

  // Asignar x a nodos
  nodes.forEach(n => { n.x0 = colX[n.col]; n.x1 = n.x0 + NODE_W; });

  // Calcular alturas proporcionales al valor
  cols.forEach(col => {
    const colNodes = nodes.filter(n => n.col === col);
    const totalVal = d3.sum(colNodes, n => n.value) || 1;
    const totalH   = H - NODE_PAD * (colNodes.length - 1);

    let y = 0;
    colNodes.forEach(n => {
      n.height = Math.max(8, (n.value / totalVal) * totalH);
      n.y0 = y;
      n.y1 = y + n.height;
      y += n.height + NODE_PAD;
    });

    // Centrar verticalmente
    const used   = y - NODE_PAD;
    const offset = (H - used) / 2;
    colNodes.forEach(n => { n.y0 += offset; n.y1 += offset; });
  });

  // Calcular posición vertical de cada flujo dentro del nodo source/target
  // Para cada nodo, repartir el ancho de sus links
  nodes.forEach(n => {
    n._srcOffset = n.y0;  // cursor de posición source
    n._tgtOffset = n.y0;  // cursor de posición target
  });

  links.forEach(l => {
    const totalSrc = links
      .filter(x => x.source === l.source)
      .reduce((s, x) => s + x.value, 0) || 1;
    const totalTgt = links
      .filter(x => x.target === l.target)
      .reduce((s, x) => s + x.value, 0) || 1;

    l.sy0 = l.source._srcOffset;
    l.sy1 = l.sy0 + (l.value / totalSrc) * l.source.height;
    l.source._srcOffset = l.sy1;

    l.ty0 = l.target._tgtOffset;
    l.ty1 = l.ty0 + (l.value / totalTgt) * l.target.height;
    l.target._tgtOffset = l.ty1;
  });
}

// ─── Gradientes ───────────────────────────────────────────────────────────────
function _buildGradients(links) {
  _defs.selectAll("*").remove();
  links.forEach(l => {
    const id   = `sk-grad-${l.id.replace(/[^a-z0-9]/gi, "_")}`;
    l.gradId   = id;
    const grad = _defs.append("linearGradient")
      .attr("id", id)
      .attr("gradientUnits", "userSpaceOnUse")
      .attr("x1", l.source.x1)
      .attr("x2", l.target.x0);
    grad.append("stop")
      .attr("offset", "0%")
      .attr("stop-color", l.source.color)
      .attr("stop-opacity", 0.55);
    grad.append("stop")
      .attr("offset", "100%")
      .attr("stop-color", l.target.color)
      .attr("stop-opacity", 0.55);
  });
}

// ─── Dibujar links ────────────────────────────────────────────────────────────
function _drawLinks(links, nodes, innerH) {
  _gLinks.selectAll("*").remove();

  links.forEach(l => {
    const x0 = l.source.x1;
    const x1 = l.target.x0;
    const xm = (x0 + x1) / 2;

    // Path bezier del flujo
    const path = `
      M ${x0} ${l.sy0}
      C ${xm} ${l.sy0}, ${xm} ${l.ty0}, ${x1} ${l.ty0}
      L ${x1} ${l.ty1}
      C ${xm} ${l.ty1}, ${xm} ${l.sy1}, ${x0} ${l.sy1}
      Z
    `;

    const el = _gLinks.append("path")
      .attr("class",        "sk-link")
      .attr("data-id",      l.id)
      .attr("data-source",  l.source.id)
      .attr("data-target",  l.target.id)
      .attr("data-genre",   l.source.genre || "")
      .attr("d",            path)
      .attr("fill",         `url(#${l.gradId})`)
      .attr("fill-opacity", 0)
      .attr("stroke",       "none")
      .style("cursor",      "pointer");

    // Animación de entrada
    el.transition().duration(TRANSITION)
      .delay(() => Math.random() * 300)
      .attr("fill-opacity", 0.55);

    el
      .on("mouseenter", function(event) {
        if (!_activeGenre) {
          _gLinks.selectAll(".sk-link")
            .attr("fill-opacity", x =>
              (x === l || d3.select(x).attr("data-id") === l.id) ? 0.85 : 0.08
            );
          // Usar `this` para el elemento actual
          d3.select(this).attr("fill-opacity", 0.85);
        }
        const pct = (l.value / d3.sum(links.filter(x => x.source === l.source), x => x.value) * 100).toFixed(1);
        tooltip.show(event, tooltip.html({
          title:  `${l.source.label} → ${l.target.label}`,
          color:  l.source.color,
          rows: [
            { key: "Canciones", value: l.value.toLocaleString("es") },
            { key: "% del origen", value: `${pct}%` },
          ],
          footer: l.source.genre ? "Clic para filtrar" : "",
        }));
      })
      .on("mousemove",  event => tooltip.move(event))
      .on("mouseleave", function() {
        tooltip.hide();
        if (!_activeGenre) _restoreAll();
      })
      .on("click", () => {
        if (l.source.genre) {
          if (_activeGenre === l.source.genre) clearAllFilters();
          else selectGenre(l.source.genre);
        }
      });
  });
}

// ─── Dibujar nodos ────────────────────────────────────────────────────────────
function _drawNodes(nodes, links, innerH) {
  _gNodes.selectAll("*").remove();

  nodes.forEach(n => {
    const g = _gNodes.append("g")
      .attr("class",      "sk-node")
      .attr("data-id",    n.id)
      .attr("data-genre", n.genre || "")
      .style("cursor",    n.genre ? "pointer" : "default");

    // Rectángulo del nodo
    g.append("rect")
      .attr("x",            n.x0)
      .attr("y",            n.y0)
      .attr("width",        NODE_W)
      .attr("height",       n.height)
      .attr("rx",           4)
      .attr("fill",         n.color)
      .attr("fill-opacity", 0.85)
      .attr("stroke",       "rgba(0,0,0,0.3)")
      .attr("stroke-width", 0.5);

    // Etiqueta
    const isRight = n.col === 2;
    const isLeft  = n.col === 0;
    const lx = isRight ? n.x1 + 8 : isLeft ? n.x0 - 8 : (n.x0 + n.x1) / 2;
    const anchor = isRight ? "start" : isLeft ? "end" : "middle";
    const ly = n.y0 + n.height / 2;

    const label = n.label.length > 16 ? n.label.slice(0, 14) + "…" : n.label;

    g.append("text")
      .attr("x",             lx)
      .attr("y",             ly + 4)
      .attr("text-anchor",   anchor)
      .attr("font-size",     "10px")
      .attr("font-weight",   n.col === 0 ? "600" : "500")
      .attr("fill",          n.color)
      .attr("fill-opacity",  0.9)
      .style("pointer-events", "none")
      .text(label);

    // Valor (track count) bajo la etiqueta si hay espacio
    if (n.height > 22 && n.col === 0) {
      g.append("text")
        .attr("x",           lx)
        .attr("y",           ly + 16)
        .attr("text-anchor", anchor)
        .attr("font-size",   "8.5px")
        .attr("fill",        "rgba(255,255,255,0.4)")
        .style("pointer-events", "none")
        .text(`${Math.round(n.value).toLocaleString("es")} canciones`);
    }

    // Interactividad del nodo
    g
      .on("mouseenter", function(event) {
        d3.select(this).select("rect").attr("fill-opacity", 1);
        if (!_activeGenre) _highlightNode(n.id, links);
        tooltip.show(event, tooltip.html({
          title:  n.label,
          color:  n.color,
          rows: [
            { key: "Canciones", value: Math.round(n.value).toLocaleString("es") },
            { key: "Flujos",    value: links.filter(l => l.source === n || l.target === n).length },
          ],
          footer: n.genre ? "Clic para filtrar todos los gráficos" : "",
        }));
      })
      .on("mousemove",  event => tooltip.move(event))
      .on("mouseleave", function() {
        d3.select(this).select("rect").attr("fill-opacity", 0.85);
        tooltip.hide();
        if (!_activeGenre) _restoreAll();
      })
      .on("click", () => {
        if (!n.genre) return;
        if (_activeGenre === n.genre) clearAllFilters();
        else selectGenre(n.genre);
      });
  });
}

// ─── Títulos de columna ───────────────────────────────────────────────────────
function _drawColumnLabels(innerW, innerH) {
  const cols = [
    { label: "Género",      x: 0,            anchor: "start" },
    { label: "Energía",     x: innerW / 2,   anchor: "middle" },
    { label: "Popularidad", x: innerW,        anchor: "end"   },
  ];

  cols.forEach(({ label, x, anchor }) => {
    _svg.append("text")
      .attr("x",           MARGIN.left + x)
      .attr("y",           14)
      .attr("text-anchor", anchor)
      .attr("font-size",   "11px")
      .attr("font-weight", "700")
      .attr("fill",        "var(--text-muted)")
      .attr("letter-spacing", "1px")
      .attr("text-transform", "uppercase")
      .text(label.toUpperCase());
  });
}

// ─── Highlight coordinado ─────────────────────────────────────────────────────
function _highlightNode(nodeId, links) {
  _gLinks.selectAll(".sk-link")
    .attr("fill-opacity", function() {
      const src = d3.select(this).attr("data-source");
      const tgt = d3.select(this).attr("data-target");
      return (src === nodeId || tgt === nodeId) ? 0.8 : 0.06;
    });
}

function _applyHighlight(genre, nodes) {
  const node = nodes.find(n => n.genre === genre);
  if (!node) return;

  _gLinks.selectAll(".sk-link")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      return d3.select(this).attr("data-genre") === genre ? 0.8 : 0.05;
    });

  _gNodes.selectAll(".sk-node rect")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      const nid  = d3.select(this.parentNode).attr("data-id");
      const ng   = d3.select(this.parentNode).attr("data-genre");
      if (ng === genre) return 1;
      // Nodos de energía/popularidad conectados al género activo
      const connected = _gLinks.selectAll(".sk-link")
        .filter(function() {
          return d3.select(this).attr("data-genre") === genre &&
            (d3.select(this).attr("data-target") === nid || d3.select(this).attr("data-source") === nid);
        }).size() > 0;
      return connected ? 0.7 : 0.15;
    });
}

function _restoreAll() {
  if (!_gLinks || !_gNodes) return;
  _gLinks.selectAll(".sk-link")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.55);
  _gNodes.selectAll(".sk-node rect")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.85);
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  if (Math.abs(w - _prevW) < 8 && Math.abs(h - _prevH) < 8) return;
  const prev = _activeGenre;
  _build();
  if (prev) _activeGenre = prev;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 300), h: Math.max(r.height, 200) };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initSankey };