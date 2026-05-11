/**
 * forceGraph.js — Red de similitud entre géneros v1
 *
 * Visualiza genre_similarity.json como un grafo de fuerzas D3.
 * Nodos = géneros, aristas = similitud coseno > umbral configurable.
 *
 * Features:
 *   - d3.forceSimulation con forceLink, forceManyBody, forceCenter,
 *     forceCollide para evitar solapamiento de nodos
 *   - Nodos coloreados por género (paleta central), tamaño por nº de tracks
 *   - Aristas con grosor y opacidad proporcionales al valor de similitud
 *   - Drag interactivo por nodo (alpha reheat suave al soltar)
 *   - Zoom + pan con d3.zoom
 *   - Hover de nodo → tooltip + highlight de vecinos directos
 *   - Hover de arista → tooltip con par + similitud exacta
 *   - Clic en nodo → selectGenre() (linked views con todos los gráficos)
 *   - Recibe genre:select / filters:clear del bus global
 *   - Slider de umbral de similitud (igual que el chord)
 *   - Etiquetas de nodo con visibilidad adaptativa (solo si el nodo es grande
 *     o está en hover/selección)
 *   - Botón de reset de zoom y posiciones
 *   - Animación de entrada: nodos aparecen desde el centro con stagger
 *   - ResizeObserver con debounce
 *
 * Datos: genre_similarity.json → { genres: string[], links: [{source, target, value}] }
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import { genreColor, initGenreScale, fmt } from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const CTRL_H        = 38;
const TRANSITION    = 300;
const DEBOUNCE_MS   = 380;
const DEFAULT_THRESH = 0.97;

// Física de la simulación
const LINK_DIST_BASE = 80;   // distancia base entre nodos conectados
const CHARGE_STR     = -280; // repulsión entre nodos (negativo = repeler)
const COLLIDE_PAD    = 6;    // padding extra en forceCollide

// Nodos
const NODE_R_MIN  = 6;
const NODE_R_MAX  = 22;
const LABEL_MIN_R = 12;   // radio mínimo para mostrar etiqueta permanente

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container    = null;
let _svg          = null;
let _gLinks       = null;
let _gNodes       = null;
let _simulation   = null;
let _zoom         = null;
let _resizeObs    = null;
let _unsubs       = [];
let _prevW        = 0;
let _prevH        = 0;
let _activeGenre  = null;
let _threshold    = DEFAULT_THRESH;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initForce(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  const data = store.getData("genreSimilarity");
  if (!data) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "genreSimilarity") return;
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
  const raw = store.getData("genreSimilarity");
  if (!raw || !_container) return;

  // Detener simulación previa
  if (_simulation) { _simulation.stop(); _simulation = null; }

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles ─────────────────────────────────────────────────────────────
  _buildControls(raw);

  // ── Preparar grafo filtrado ────────────────────────────────────────────────
  const { nodes, links } = _buildGraph(raw, _threshold);

  initGenreScale(nodes.map(n => n.id));

  // ── Dimensiones ───────────────────────────────────────────────────────────
  const { w, h } = _dims();
  _prevW = w; _prevH = h;

  const svgH = h - CTRL_H;

  _svg = d3.select(_container)
    .append("svg")
    .attr("width",  "100%")
    .attr("height", `calc(100% - ${CTRL_H}px)`)
    .attr("viewBox", `0 0 ${w} ${svgH}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  // Fondo (para capturar eventos de zoom)
  _svg.append("rect")
    .attr("width",  w)
    .attr("height", svgH)
    .attr("fill",   "transparent");

  // Contenedor principal (transformado por zoom)
  const gRoot = _svg.append("g").attr("class", "fg-root");

  _gLinks = gRoot.append("g").attr("class", "fg-links");
  _gNodes = gRoot.append("g").attr("class", "fg-nodes");

  if (!nodes.length) {
    _showEmpty(w, svgH);
    return;
  }

  // ── Escala de radio por popularidad/conectividad ──────────────────────────
  // Usamos el grado (número de conexiones) como proxy de importancia visual
  const degreeMap = new Map();
  nodes.forEach(n => degreeMap.set(n.id, 0));
  links.forEach(l => {
    degreeMap.set(l.source.id ?? l.source, (degreeMap.get(l.source.id ?? l.source) || 0) + 1);
    degreeMap.set(l.target.id ?? l.target, (degreeMap.get(l.target.id ?? l.target) || 0) + 1);
  });
  const maxDegree = d3.max([...degreeMap.values()]) || 1;
  const rScale = d3.scaleSqrt()
    .domain([0, maxDegree])
    .range([NODE_R_MIN, NODE_R_MAX]);

  nodes.forEach(n => { n.r = rScale(degreeMap.get(n.id) || 0); });

  // ── Aristas ───────────────────────────────────────────────────────────────
  const linkElems = _gLinks.selectAll(".fg-link")
    .data(links)
    .join("line")
      .attr("class",        "fg-link")
      .attr("stroke",       l => {
        // Gradiente implícito: promedio de colores de los dos extremos
        const c1 = d3.color(genreColor(l.source.id ?? l.source));
        const c2 = d3.color(genreColor(l.target.id ?? l.target));
        return c1 && c2
          ? d3.interpolateRgb(c1.formatHex(), c2.formatHex())(0.5)
          : "#ffffff";
      })
      .attr("stroke-width",   l => _linkWidth(l))
      .attr("stroke-opacity", l => _linkOpacity(l))
      .style("cursor", "pointer")
      .on("mouseenter", function(event, l) {
        d3.select(this)
          .attr("stroke-opacity", 0.9)
          .attr("stroke-width",   _linkWidth(l) * 2.5);
        tooltip.show(event, tooltip.html({
          title: `${l.source.id ?? l.source} ↔ ${l.target.id ?? l.target}`,
          color: genreColor(l.source.id ?? l.source),
          rows:  [{ key: "Similitud", value: fmt(l.value, 4) }],
          footer: "Similitud coseno en audio features",
        }));
      })
      .on("mousemove",  event => tooltip.move(event))
      .on("mouseleave", function(_, l) {
        tooltip.hide();
        d3.select(this)
          .attr("stroke-opacity", _linkOpacity(l))
          .attr("stroke-width",   _linkWidth(l));
      });

  // ── Nodos ─────────────────────────────────────────────────────────────────
  const nodeElems = _gNodes.selectAll(".fg-node")
    .data(nodes, d => d.id)
    .join("g")
      .attr("class",      "fg-node")
      .attr("data-genre", d => d.id)
      .style("cursor",    "pointer");

  // Círculo base con glow suave
  nodeElems.append("circle")
    .attr("class",        "fg-circle")
    .attr("r",            0)   // empieza en 0 para animación
    .attr("fill",         d => genreColor(d.id))
    .attr("fill-opacity", _activeGenre ? d => d.id === _activeGenre ? 0.95 : 0.25 : 0.82)
    .attr("stroke",       d => genreColor(d.id))
    .attr("stroke-width", 1.5)
    .attr("stroke-opacity", 0.4)
    .style("filter",      d => `drop-shadow(0 0 4px ${genreColor(d.id)}44)`);

  // Animación de entrada: nodos crecen desde el centro
  nodeElems.select(".fg-circle")
    .transition()
    .duration(TRANSITION)
    .delay((_, i) => i * 8)
    .ease(d3.easeBackOut.overshoot(0.8))
    .attr("r", d => d.r);

  // Etiquetas (siempre presentes, visibilidad controlada por opacity)
  nodeElems.append("text")
    .attr("class",          "fg-label")
    .attr("text-anchor",    "middle")
    .attr("dominant-baseline", "central")
    .attr("font-size",      d => Math.min(d.r * 0.55, 10) + "px")
    .attr("font-weight",    "600")
    .attr("fill",           "#fff")
    .attr("fill-opacity",   d => d.r >= LABEL_MIN_R ? 0.88 : 0)
    .attr("pointer-events", "none")
    .attr("user-select",    "none")
    .text(d => {
      const maxChars = Math.floor(d.r * 1.6 / 5.5);
      return d.id.length > maxChars
        ? d.id.slice(0, Math.max(1, maxChars - 1)) + "…"
        : d.id;
    });

  // ── Drag ─────────────────────────────────────────────────────────────────
  const drag = d3.drag()
    .on("start", (event, d) => {
      if (!event.active) _simulation.alphaTarget(0.3).restart();
      d.fx = d.x;
      d.fy = d.y;
      tooltip.hide();
    })
    .on("drag", (event, d) => {
      d.fx = event.x;
      d.fy = event.y;
    })
    .on("end", (event, d) => {
      if (!event.active) _simulation.alphaTarget(0);
      // Dejar el nodo fijo donde lo soltó el usuario (UX intuitivo)
      // Para liberarlo: doble clic
    });

  nodeElems.call(drag);

  // Doble clic → liberar nodo fijo
  nodeElems.on("dblclick", (event, d) => {
    event.stopPropagation();
    d.fx = null;
    d.fy = null;
    _simulation.alphaTarget(0.1).restart();
    setTimeout(() => _simulation.alphaTarget(0), 800);
  });

  // Hover + clic
  nodeElems
    .on("mouseenter", function(event, d) {
      _onNodeEnter(event, d, nodeElems, linkElems, links);
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function(_, d) {
      _onNodeLeave(d, nodeElems, linkElems, links);
      tooltip.hide();
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      if (_activeGenre === d.id) clearAllFilters();
      else selectGenre(d.id);
    });

  // Clic en fondo → limpiar selección
  _svg.on("click", () => { if (_activeGenre) clearAllFilters(); });

  // ── Simulación de fuerzas ─────────────────────────────────────────────────
  _simulation = d3.forceSimulation(nodes)
    .force("link", d3.forceLink(links)
      .id(d => d.id)
      .distance(l => LINK_DIST_BASE * (1 - (l.value - _threshold) / (1 - _threshold) * 0.4))
      .strength(l => 0.3 + (l.value - _threshold) * 2)
    )
    .force("charge",  d3.forceManyBody().strength(CHARGE_STR))
    .force("center",  d3.forceCenter(w / 2, svgH / 2))
    .force("collide", d3.forceCollide(d => d.r + COLLIDE_PAD).strength(0.7))
    .alphaDecay(0.025)
    .velocityDecay(0.4)
    .on("tick", () => {
      linkElems
        .attr("x1", l => l.source.x)
        .attr("y1", l => l.source.y)
        .attr("x2", l => l.target.x)
        .attr("y2", l => l.target.y);

      nodeElems.attr("transform", d => `translate(${d.x},${d.y})`);
    });

  // ── Zoom + pan ────────────────────────────────────────────────────────────
  _zoom = d3.zoom()
    .scaleExtent([0.3, 4])
    .on("zoom", ({ transform }) => gRoot.attr("transform", transform));

  _svg.call(_zoom).on("dblclick.zoom", null);

  // Botón reset
  _buildZoomReset(w, svgH, nodes);

  // ── Linked views ──────────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyHighlight(genre, nodeElems, linkElems, links);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _restoreAll(nodeElems, linkElems, links);
    })
  );

  // Aplicar estado actual si ya había filtro
  if (_activeGenre) _applyHighlight(_activeGenre, nodeElems, linkElems, links);

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Construcción del grafo filtrado ─────────────────────────────────────────
function _buildGraph(raw, threshold) {
  const filteredLinks = raw.links.filter(l => l.value >= threshold);

  // Solo géneros que participan en al menos un link
  const genreSet = new Set();
  filteredLinks.forEach(l => { genreSet.add(l.source); genreSet.add(l.target); });

  const nodes = [...genreSet].map(id => ({ id }));
  const links = filteredLinks.map(l => ({
    source: l.source,
    target: l.target,
    value:  l.value,
  }));

  return { nodes, links };
}

// ─── Hover de nodo ────────────────────────────────────────────────────────────
function _onNodeEnter(event, d, nodeElems, linkElems, links) {
  if (_activeGenre && _activeGenre !== d.id) return;

  const neighbors = _getNeighbors(d.id, links);

  // Resaltar nodo y vecinos
  nodeElems.select(".fg-circle")
    .transition().duration(120)
    .attr("fill-opacity",   n => n.id === d.id ? 1 : neighbors.has(n.id) ? 0.7 : 0.12)
    .attr("stroke-opacity", n => n.id === d.id ? 1 : neighbors.has(n.id) ? 0.6 : 0.1)
    .attr("r",              n => n.id === d.id ? n.r * 1.2 : n.r);

  nodeElems.select(".fg-label")
    .attr("fill-opacity", n =>
      n.id === d.id ? 1 :
      neighbors.has(n.id) ? (n.r >= LABEL_MIN_R ? 0.7 : 0.5) :
      0
    );

  // Aristas del nodo resaltado
  linkElems
    .attr("stroke-opacity", l =>
      (l.source.id === d.id || l.target.id === d.id) ? 0.85 : 0.03
    )
    .attr("stroke-width",   l =>
      (l.source.id === d.id || l.target.id === d.id) ? _linkWidth(l) * 2 : _linkWidth(l)
    );

  // Elevar el nodo visualmente
  d3.select(event.currentTarget).raise();

  const degree = [...links.filter(l =>
    l.source.id === d.id || l.target.id === d.id
  )].length;

  tooltip.show(event, tooltip.html({
    title: d.id,
    color: genreColor(d.id),
    rows: [
      { key: "Conexiones", value: degree },
      { key: "Sim. máx.",  value: fmt(
          d3.max(links.filter(l => l.source.id === d.id || l.target.id === d.id), l => l.value) ?? 0, 4
        )
      },
    ],
    footer: "Arrastra para mover · Clic para filtrar · Doble clic para liberar",
  }));
}

function _onNodeLeave(d, nodeElems, linkElems, links) {
  if (_activeGenre) {
    _applyHighlight(_activeGenre, nodeElems, linkElems, links);
  } else {
    _restoreAll(nodeElems, linkElems, links);
  }
}

// ─── Highlight coordinado ─────────────────────────────────────────────────────
function _applyHighlight(genre, nodeElems, linkElems, links) {
  if (!_gNodes) return;
  const neighbors = _getNeighbors(genre, links);

  nodeElems.select(".fg-circle")
    .transition().duration(TRANSITION)
    .attr("fill-opacity",   d => d.id === genre ? 0.95 : neighbors.has(d.id) ? 0.55 : 0.08)
    .attr("stroke-opacity", d => d.id === genre ? 1    : neighbors.has(d.id) ? 0.4  : 0.05)
    .attr("r",              d => d.id === genre ? d.r * 1.15 : d.r);

  nodeElems.select(".fg-label")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", d =>
      d.id === genre ? 1 :
      neighbors.has(d.id) ? (d.r >= LABEL_MIN_R ? 0.65 : 0.4) :
      0
    );

  linkElems
    .transition().duration(TRANSITION)
    .attr("stroke-opacity", l =>
      (l.source.id === genre || l.target.id === genre) ? 0.8 : 0.03
    )
    .attr("stroke-width", l =>
      (l.source.id === genre || l.target.id === genre) ? _linkWidth(l) * 1.8 : _linkWidth(l)
    );

  // Elevar nodo activo
  _gNodes.selectAll(`.fg-node[data-genre="${CSS.escape(genre)}"]`).raise();
}

function _restoreAll(nodeElems, linkElems, links) {
  if (!nodeElems) return;
  nodeElems.select(".fg-circle")
    .transition().duration(TRANSITION)
    .attr("fill-opacity",   0.82)
    .attr("stroke-opacity", 0.4)
    .attr("r",              d => d.r);

  nodeElems.select(".fg-label")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", d => d.r >= LABEL_MIN_R ? 0.88 : 0);

  linkElems
    .transition().duration(TRANSITION)
    .attr("stroke-opacity", l => _linkOpacity(l))
    .attr("stroke-width",   l => _linkWidth(l));
}

// ─── Helpers de estilo de aristas ─────────────────────────────────────────────
function _linkWidth(l) {
  // Entre 0.5 y 3px según similitud
  return 0.5 + (l.value - 0.9) / 0.1 * 2.5;
}

function _linkOpacity(l) {
  if (!_activeGenre) return 0.35;
  return (l.source.id === _activeGenre || l.target.id === _activeGenre) ? 0.8 : 0.03;
}

// ─── Vecinos directos de un nodo ─────────────────────────────────────────────
function _getNeighbors(id, links) {
  const set = new Set();
  links.forEach(l => {
    if (l.source.id === id) set.add(l.target.id);
    if (l.target.id === id) set.add(l.source.id);
  });
  return set;
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls(raw) {
  const bar = document.createElement("div");
  bar.style.cssText = `
    display: flex; align-items: center; gap: 12px;
    padding: 4px 14px; height: ${CTRL_H}px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px; color: var(--text-muted);
  `;

  const lbl = document.createElement("span");
  lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;";
  lbl.textContent   = "Umbral similitud:";

  const valSpan = document.createElement("span");
  valSpan.style.cssText = "color:var(--spotify-green);font-weight:600;font-size:11px;min-width:36px;";
  valSpan.textContent   = _threshold.toFixed(2);

  const slider = document.createElement("input");
  slider.type  = "range";
  slider.min   = "0.90";
  slider.max   = "0.999";
  slider.step  = "0.001";
  slider.value = String(_threshold);
  slider.style.cssText = "width:110px;accent-color:var(--spotify-green);cursor:pointer;";

  const nodeCount = document.createElement("span");
  nodeCount.style.cssText = "font-size:10px;color:var(--text-hint);";
  const updateCount = () => {
    const { nodes, links } = _buildGraph(raw, _threshold);
    nodeCount.textContent = `${nodes.length} géneros · ${links.length} conexiones`;
  };
  updateCount();

  slider.addEventListener("input", () => {
    _threshold      = +slider.value;
    valSpan.textContent = _threshold.toFixed(3);
    updateCount();
  });
  slider.addEventListener("change", () => {
    _threshold = +slider.value;
    const prev = _activeGenre;
    _build();
    if (prev) { _activeGenre = prev; }
  });

  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);white-space:nowrap;";
  hint.textContent   = "Arrastra nodos · Rueda para zoom · Clic para filtrar";

  bar.appendChild(lbl);
  bar.appendChild(slider);
  bar.appendChild(valSpan);
  bar.appendChild(nodeCount);
  bar.appendChild(hint);
  _container.appendChild(bar);
}

// ─── Botón reset zoom + posiciones ───────────────────────────────────────────
function _buildZoomReset(w, svgH, nodes) {
  const btn = document.createElement("button");
  btn.title     = "Restablecer vista";
  btn.innerHTML = `<svg viewBox="0 0 16 16" fill="none" width="12" height="12">
    <path d="M2 8A6 6 0 0 1 8 2M8 2l-2 2M8 2l2 2M14 8a6 6 0 0 1-6 6M8 14l-2-2M8 14l2-2"
          stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
  </svg>`;
  btn.style.cssText = `
    position:absolute; top:${CTRL_H + 8}px; right:8px; z-index:20;
    width:26px; height:26px; background:var(--bg-elevated);
    border:1px solid var(--border-soft); border-radius:6px;
    color:var(--text-secondary); cursor:pointer;
    display:flex; align-items:center; justify-content:center;
    transition:var(--transition);
  `;
  btn.addEventListener("mouseenter", () => { btn.style.background="var(--bg-hover)"; btn.style.color="#fff"; });
  btn.addEventListener("mouseleave", () => { btn.style.background="var(--bg-elevated)"; btn.style.color="var(--text-secondary)"; });
  btn.addEventListener("click", () => {
    // Liberar todos los nodos fijos
    nodes.forEach(n => { n.fx = null; n.fy = null; });
    if (_simulation) _simulation.alphaTarget(0.2).restart();
    setTimeout(() => { if (_simulation) _simulation.alphaTarget(0); }, 1200);
    // Reset zoom
    _svg.transition().duration(500).call(_zoom.transform, d3.zoomIdentity);
  });
  _container.style.position = "relative";
  _container.appendChild(btn);
}

// ─── Placeholder sin conexiones ───────────────────────────────────────────────
function _showEmpty(w, svgH) {
  _svg.append("text")
    .attr("x",           w / 2)
    .attr("y",           svgH / 2)
    .attr("text-anchor", "middle")
    .attr("font-size",   "13px")
    .attr("fill",        "var(--text-hint)")
    .text("Baja el umbral para ver conexiones");
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (Math.abs(w - _prevW) < 8 && Math.abs(h - _prevH) < 8) return;
  const prev = _activeGenre;
  _build();
  if (prev) _activeGenre = prev;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 240), h: Math.max(r.height, 240) };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initForce };