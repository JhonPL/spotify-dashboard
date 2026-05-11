/**
 * packing.js — Circular Packing por género v1
 *
 * Visualiza los top artistas agrupados en círculos padre por género.
 * Cada círculo hijo = un artista. El tamaño del hijo codifica popularidad.
 * El círculo padre agrupa todos los artistas del mismo género.
 *
 * Jerarquía:
 *   root
 *   └── género (circle padre, coloreado)
 *       └── artista (circle hijo, mismo color más oscuro)
 *
 * Features:
 *   - d3.pack() con padding entre niveles
 *   - Dos modos: "Géneros" (agrupado) y "Artistas" (flat, sin jerarquía)
 *   - Zoom semántico: clic en género → hace zoom al grupo (drill-down)
 *   - Clic en género padre → selectGenre() + zoom
 *   - Clic en artista hijo → tooltip con stats + selectGenre del género
 *   - Doble clic o clic en fondo → zoom out al nivel raíz
 *   - Etiquetas: nombre del género en círculos grandes, artista en los medianos
 *   - Hover → resalta el círculo + muestra tooltip
 *   - Linked views: genre:select → resalta el género correspondiente
 *   - Animación de entrada suave con d3.zoom interpolado
 *   - ResizeObserver con debounce
 *
 * Datos: artists_top.json → { artist, genres, track_count, popularity, ... }
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import {
  initGenreScale, genreColor,
  fmt,
} from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const TRANSITION   = 600;
const DEBOUNCE_MS  = 380;
const LABEL_GENRE_MIN_R  = 28;   // radio mínimo para etiqueta de género
const LABEL_ARTIST_MIN_R = 10;   // radio mínimo para etiqueta de artista

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container    = null;
let _svg          = null;
let _gPack        = null;
let _currentZoom  = null;   // nodo actualmente en zoom
let _resizeObs    = null;
let _unsubs       = [];
let _prevW        = 0;
let _prevH        = 0;
let _activeGenre  = null;
let _root         = null;   // jerarquía d3
let _cx           = 0;
let _cy           = 0;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initPacking(container) {
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
  _cx = w / 2; _cy = h / 2;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  // Inicializar escala de géneros
  const genres = [...new Set(data.map(d => d.genres))];
  initGenreScale(genres);

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Hint ──────────────────────────────────────────────────────────────────
  _buildHint();

  // ── SVG ───────────────────────────────────────────────────────────────────
  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top", "0").style("left", "0")
    .style("width", "100%").style("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .attr("preserveAspectRatio", "xMidYMid meet")
    .style("cursor", "pointer");

  // Fondo clickable para zoom out
  _svg.append("rect")
    .attr("width", w).attr("height", h)
    .attr("fill", "transparent")
    .on("click", () => {
      if (_currentZoom) {
        _currentZoom = null;
        if (_activeGenre) clearAllFilters();
        _zoomTo({ x: _cx, y: _cy, r: Math.min(w, h) / 2 });
      }
    });

  _gPack = _svg.append("g").attr("class", "cp-pack");

  // ── Jerarquía ─────────────────────────────────────────────────────────────
  _root = _buildHierarchy(data);

  // ── Layout pack ───────────────────────────────────────────────────────────
  const diameter = Math.min(w, h) * 0.96;
  d3.pack()
    .size([diameter, diameter])
    .padding(d => d.depth === 0 ? 6 : 3)
    (_root);

  // Offset para centrar el pack en el SVG
  const offsetX = (w - diameter) / 2;
  const offsetY = (h - diameter) / 2;

  _root.each(d => {
    d.x += offsetX;
    d.y += offsetY;
  });

  // ── Renderizar ────────────────────────────────────────────────────────────
  _render(true);

  // ── Linked views ─────────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyGenreHighlight(genre);
      // Hacer zoom al género seleccionado externamente
      const genreNode = _root.children?.find(d => d.data.name === genre);
      if (genreNode && _currentZoom?.data?.name !== genre) {
        _currentZoom = genreNode;
        _zoomTo({ x: genreNode.x, y: genreNode.y, r: genreNode.r * 1.05 });
      }
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _currentZoom = null;
      _restoreAll();
      _zoomTo({ x: _cx, y: _cy, r: Math.min(w, h) / 2 });
    })
  );

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Construir jerarquía ──────────────────────────────────────────────────────
function _buildHierarchy(data) {
  // Agrupar artistas por género
  const byGenre = d3.group(data, d => d.genres);

  const children = [...byGenre.entries()].map(([genre, artists]) => ({
    name:     genre,
    children: artists.map(a => ({
      name:        a.artist,
      genre:       a.genres,
      value:       Math.max(1, +a.popularity || 1),
      track_count: a.track_count,
      popularity:  a.popularity,
      energy:      a.energy,
      danceability: a.danceability,
      valence:     a.valence,
      acousticness: a.acousticness,
    })),
  }));

  const hierarchy = d3.hierarchy({ name: "root", children })
    .sum(d => d.value ?? 0)
    .sort((a, b) => b.value - a.value);

  return hierarchy;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function _render(isInitial) {
  const nodes = _root.descendants();

  // Círculos
  const circles = _gPack.selectAll(".cp-circle")
    .data(nodes, d => d.data.name + (d.depth === 2 ? d.parent?.data.name : ""))
    .join(
      enter => enter.append("circle")
        .attr("class",  d => `cp-circle cp-depth-${d.depth}`)
        .attr("data-genre", d => d.depth === 1 ? d.data.name : d.data.genre)
        .attr("cx",  d => d.x)
        .attr("cy",  d => d.y)
        .attr("r",   isInitial ? 0 : d => d.r)
        .attr("fill", d => _circleFill(d))
        .attr("fill-opacity", d => _circleOpacity(d))
        .attr("stroke", d => _circleStroke(d))
        .attr("stroke-width", d => d.depth === 0 ? 0 : d.depth === 1 ? 1.5 : 0.5)
        .attr("stroke-opacity", d => d.depth === 1 ? 0.4 : 0.2)
        .style("cursor", d => d.depth === 0 ? "default" : "pointer"),
      update => update,
      exit => exit.transition().duration(TRANSITION / 2).attr("r", 0).remove()
    );

  if (isInitial) {
    circles
      .filter(d => d.depth > 0)
      .transition()
      .delay((_, i) => i * 2)
      .duration(TRANSITION)
      .ease(d3.easeBackOut.overshoot(0.3))
      .attr("r", d => d.r);
  } else {
    circles.transition().duration(TRANSITION)
      .attr("fill", d => _circleFill(d))
      .attr("fill-opacity", d => _circleOpacity(d))
      .attr("r", d => d.r);
  }

  // Interactividad
  circles.filter(d => d.depth === 1)
    .on("mouseenter", function(event, d) {
      if (_activeGenre && _activeGenre !== d.data.name) return;
      d3.select(this)
        .interrupt()
        .transition().duration(100)
        .attr("fill-opacity", 0.28)
        .attr("stroke-opacity", 0.9)
        .attr("stroke-width", 2.5);
      tooltip.show(event, tooltip.html({
        title: d.data.name,
        color: genreColor(d.data.name),
        rows: [
          { key: "Artistas",    value: d.children?.length ?? 0 },
          { key: "Pop. media",  value: fmt(d3.mean(d.children ?? [], c => c.data.popularity), 1) },
          { key: "Energy media", value: fmt(d3.mean(d.children ?? [], c => c.data.energy), 3) },
        ],
        footer: "Clic para hacer zoom y filtrar",
      }));
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function(_, d) {
      tooltip.hide();
      d3.select(this).interrupt()
        .transition().duration(150)
        .attr("fill-opacity", _circleOpacity(d))
        .attr("stroke-opacity", 0.4)
        .attr("stroke-width", 1.5);
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      if (_currentZoom?.data?.name === d.data.name) {
        // Toggle: doble clic en el mismo → zoom out
        _currentZoom = null;
        clearAllFilters();
        _zoomTo({ x: _cx, y: _cy, r: Math.min(_dims().w, _dims().h) / 2 });
      } else {
        _currentZoom = d;
        selectGenre(d.data.name);
        _zoomTo({ x: d.x, y: d.y, r: d.r * 1.05 });
      }
    });

  circles.filter(d => d.depth === 2)
    .on("mouseenter", function(event, d) {
      if (_activeGenre && _activeGenre !== d.data.genre) return;
      d3.select(this)
        .interrupt()
        .transition().duration(80)
        .attr("r", d.r * 1.15)
        .attr("fill-opacity", 0.95)
        .attr("stroke-opacity", 1)
        .attr("stroke-width", 1.2);
      tooltip.show(event, tooltip.html({
        title:    d.data.name,
        subtitle: `Género: ${d.data.genre}`,
        color:    genreColor(d.data.genre),
        rows: [
          { key: "Popularidad",  value: fmt(d.data.popularity, 1) },
          { key: "Tracks",       value: d.data.track_count },
          { key: "Energy",       value: fmt(d.data.energy, 3) },
          { key: "Danceability", value: fmt(d.data.danceability, 3) },
          { key: "Valence",      value: fmt(d.data.valence, 3) },
        ],
        footer: "Clic para filtrar por género",
      }));
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function(_, d) {
      tooltip.hide();
      d3.select(this).interrupt()
        .transition().duration(120)
        .attr("r", d.r)
        .attr("fill-opacity", _circleOpacity(d))
        .attr("stroke-opacity", 0.2)
        .attr("stroke-width", 0.5);
    })
    .on("click", (event, d) => {
      event.stopPropagation();
      const genre = d.data.genre;
      if (_activeGenre === genre) clearAllFilters();
      else selectGenre(genre);
    });

  // ── Etiquetas ─────────────────────────────────────────────────────────────
  _gPack.selectAll(".cp-label").remove();

  // Etiquetas de género (depth 1)
  // Añadimos un "halo" (stroke) para máxima legibilidad
  const genreLabels = _gPack.selectAll(".cp-label-genre")
    .data(nodes.filter(d => d.depth === 1 && d.r >= LABEL_GENRE_MIN_R), d => d.data.name)
    .join("g")
      .attr("class", "cp-label cp-label-genre")
      .style("pointer-events", "none");

  genreLabels.append("text")
    .attr("x",               d => d.x)
    .attr("y",               d => d.y - d.r + Math.min(d.r * 0.28, 18))
    .attr("text-anchor",     "middle")
    .attr("dominant-baseline", "central")
    .attr("font-size",       d => Math.min(d.r * 0.22, 14) + "px")
    .attr("font-weight",     "800")
    .attr("stroke",          "var(--bg-panel)")
    .attr("stroke-width",    3)
    .attr("stroke-linejoin", "round")
    .attr("fill-opacity",    d => _activeGenre ? (d.data.name === _activeGenre ? 0.8 : 0.1) : 0.8)
    .text(d => _truncate(d.data.name, Math.floor(d.r * 0.22)));

  genreLabels.append("text")
    .attr("x",               d => d.x)
    .attr("y",               d => d.y - d.r + Math.min(d.r * 0.28, 18))
    .attr("text-anchor",     "middle")
    .attr("dominant-baseline", "central")
    .attr("font-size",       d => Math.min(d.r * 0.22, 14) + "px")
    .attr("font-weight",     "800")
    .attr("fill",            d => genreColor(d.data.name))
    .attr("fill-opacity",    d => _activeGenre ? 0 : 1) // Ocultar si hay selección
    .text(d => _truncate(d.data.name, Math.floor(d.r * 0.22)));

  // Conteo de artistas bajo el nombre de género
  _gPack.selectAll(".cp-label-count")
    .data(nodes.filter(d => d.depth === 1 && d.r >= LABEL_GENRE_MIN_R + 10), d => d.data.name)
    .join("text")
      .attr("class",           "cp-label cp-label-count")
      .attr("x",               d => d.x)
      .attr("y",               d => d.y - d.r + Math.min(d.r * 0.28, 18) + 12)
      .attr("text-anchor",     "middle")
      .attr("dominant-baseline", "central")
      .attr("font-size",       "9px")
      .attr("font-weight",     "600")
      .attr("fill",            "#fff")
      .attr("fill-opacity",    d => _activeGenre ? 0 : 0.5) // Ocultar si hay selección
      .style("pointer-events", "none")
      .text(d => `${d.children?.length ?? 0} artistas`);

  // Etiquetas de artista (depth 2)
  const artistLabels = _gPack.selectAll(".cp-label-artist")
    .data(nodes.filter(d => d.depth === 2 && d.r >= LABEL_ARTIST_MIN_R), d => d.data.name)
    .join("g")
      .attr("class", "cp-label cp-label-artist")
      .style("pointer-events", "none");

  artistLabels.append("text")
    .attr("x",               d => d.x)
    .attr("y",               d => d.y)
    .attr("text-anchor",     "middle")
    .attr("dominant-baseline", "central")
    .attr("font-size",       d => Math.min(d.r * 0.44, 9.5) + "px")
    .attr("font-weight",     "600")
    .attr("stroke",          "rgba(0,0,0,0.6)")
    .attr("stroke-width",    2)
    .attr("stroke-linejoin", "round")
    .attr("fill-opacity",    d => _activeGenre ? (d.data.genre === _activeGenre ? 0.6 : 0.02) : 0.4)
    .text(d => _truncate(d.data.name, Math.floor(d.r * 0.25)));

  artistLabels.append("text")
    .attr("x",               d => d.x)
    .attr("y",               d => d.y)
    .attr("text-anchor",     "middle")
    .attr("dominant-baseline", "central")
    .attr("font-size",       d => Math.min(d.r * 0.44, 9.5) + "px")
    .attr("font-weight",     "600")
    .attr("fill",            "#fff")
    .attr("fill-opacity",    d => _activeGenre ? (d.data.genre === _activeGenre ? 1 : 0.05) : 0.9)
    .text(d => _truncate(d.data.name, Math.floor(d.r * 0.25)));
}

// ─── Estilos de círculos ──────────────────────────────────────────────────────
function _circleFill(d) {
  if (d.depth === 0) return "transparent";
  if (d.depth === 1) {
    const c = genreColor(d.data.name);
    return d3.color(c) ? d3.color(c).copy({ opacity: 0.12 }) : "rgba(255,255,255,0.06)";
  }
  // depth 2: artista
  return genreColor(d.data.genre);
}

function _circleStroke(d) {
  if (d.depth === 0) return "none";
  if (d.depth === 1) return genreColor(d.data.name);
  return genreColor(d.data.genre);
}

function _circleOpacity(d) {
  if (d.depth === 0) return 0;
  if (!_activeGenre) return d.depth === 1 ? 1 : 0.72;

  const genre = d.depth === 1 ? d.data.name : d.data.genre;
  if (genre === _activeGenre) return d.depth === 1 ? 1 : 0.85;
  return d.depth === 1 ? 0.06 : 0.04;
}

// ─── Zoom semántico ───────────────────────────────────────────────────────────
function _zoomTo({ x, y, r }, duration = TRANSITION) {
  const { w, h } = _dims();
  const scale = Math.min(w, h) / (r * 2);
  const tx    = w / 2 - x * scale;
  const ty    = h / 2 - y * scale;

  _svg.transition()
    .duration(duration)
    .ease(d3.easeCubicInOut)
    .call(
      d3.zoom().transform,
      d3.zoomIdentity.translate(tx, ty).scale(scale)
    );

  _gPack.transition()
    .duration(duration)
    .ease(d3.easeCubicInOut)
    .attr("transform", `translate(${tx},${ty}) scale(${scale})`);
}

// ─── Highlight coordinado ─────────────────────────────────────────────────────
function _applyGenreHighlight(genre) {
  if (!_gPack) return;

  _gPack.selectAll(".cp-circle")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function(d) { return _circleOpacity(d); });

  _gPack.selectAll(".cp-label-genre, .cp-label-count")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0); // Ocultamos etiquetas generales al filtrar para ver bien los artistas

  _gPack.selectAll(".cp-label-artist")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function(d) {
      return d.data.genre === genre ? 0.9 : 0.03;
    });
}

function _restoreAll() {
  if (!_gPack) return;
  _gPack.selectAll(".cp-circle")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", d => _circleOpacity(d));

  _gPack.selectAll(".cp-label")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function(d) {
      const el = d3.select(this);
      if (el.classed("cp-label-genre") || el.classed("cp-label-count")) return 0.9;
      return 0.75;
    });
}

// ─── Hint ─────────────────────────────────────────────────────────────────────
function _buildHint() {
  const panel = _container.closest(".panel");
  const header = panel ? panel.querySelector(".panel__header") : null;
  
  const hint = document.createElement("span");
  hint.style.cssText = `
    font-size:10px;color:var(--text-hint);font-weight:400;
    margin-left:auto;padding-right:12px;opacity:0.8;
  `;
  hint.textContent = "Clic en género para zoom · Fondo para volver · Artista para filtrar";
  
  if (header) {
    // Si hay header, lo metemos al final (se alineará a la derecha por el flex)
    header.appendChild(hint);
  } else {
    // Fallback si no hay header
    hint.style.position = "absolute";
    hint.style.top = "10px";
    hint.style.right = "14px";
    hint.style.zIndex = "5";
    _container.appendChild(hint);
  }
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  if (Math.abs(w - _prevW) < 8 && Math.abs(h - _prevH) < 8) return;
  const prevGenre = _activeGenre;
  const prevZoom  = _currentZoom?.data?.name ?? null;
  _build();
  if (prevGenre) {
    _activeGenre = prevGenre;
    _applyGenreHighlight(prevGenre);
  }
  if (prevZoom) {
    const node = _root?.children?.find(d => d.data.name === prevZoom);
    if (node) {
      _currentZoom = node;
      _zoomTo({ x: node.x, y: node.y, r: node.r * 1.05 }, 0);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 200), h: Math.max(r.height, 200) };
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

export default { initPacking };