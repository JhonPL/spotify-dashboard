/**
 * chord.js — Chord Diagram de conexiones musicales entre géneros v1
 *
 * Visualiza la similitud coseno entre géneros (genre_similarity.json).
 * Cada arco exterior representa un género; cada cuerda interior conecta
 * dos géneros con similitud de audio > 0.97.
 * El grosor de la cuerda es proporcional al valor de similitud.
 *
 * Features:
 *   - d3.chord() + d3.arc() + d3.ribbon()
 *   - Arcos exteriores coloreados por género (paleta central)
 *   - Cuerdas con gradiente lineal de color A→B
 *   - Hover de arco  → highlight de todas las cuerdas del género
 *   - Hover de cuerda → tooltip con par de géneros + similitud
 *   - Clic en arco → selectGenre() (linked con treemap, scatter, radar)
 *   - Recibe genre:select / filters:clear del bus global
 *   - Animación de entrada: cuerdas crecen desde radio 0
 *   - Filtro de umbral de similitud (slider interactivo)
 *   - Etiquetas de arco con rotación automática para legibilidad
 *   - ResizeObserver con debounce
 *
 * Datos: genre_similarity.json → { genres: string[], links: [{source, target, value}] }
 * Nota: si genre_similarity aún no cargó, espera data:ready (fase 2).
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import { genreColor, initGenreScale, fmt } from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const TRANSITION      = 500;
const DEBOUNCE_MS     = 380;
const ARC_PAD_ANGLE   = 0.02;    // separación entre arcos exteriores
const ARC_INNER_PAD   = 85;      // espacio para etiquetas (aumentado para evitar cortes)
const ARC_WIDTH       = 12;      // grosor del arco exterior
const LABEL_PAD       = 10;      // espacio entre arco y etiqueta
const DEFAULT_THRESH  = 0.97;    // umbral de similitud por defecto

// ─── Estado del módulo ────────────────────────────────────────────────────────
let _container    = null;
let _svg          = null;
let _gChords      = null;   // grupo de cuerdas interiores
let _gArcs        = null;   // grupo de arcos exteriores
let _gLabels      = null;   // etiquetas de género
let _defs         = null;   // gradientes lineales
let _radius       = 0;
let _center       = { x: 0, y: 0 };
let _resizeObs    = null;
let _unsubs       = [];
let _prevW        = 0;
let _prevH        = 0;
let _activeGenre  = null;
let _threshold    = DEFAULT_THRESH;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initChord(container) {
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

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  // Inicializar escala de géneros con todos los que aparecen en los links
  const linkedGenres = _getLinkedGenres(raw, _threshold);
  initGenreScale(linkedGenres);

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles ─────────────────────────────────────────────────────────────
  _buildControls(raw);

  // ── Dimensiones ───────────────────────────────────────────────────────────
  const { w, h } = _dims();
  _prevW = w;
  _prevH = h;

  const CTRL_H    = 38;
  const size      = Math.min(w, h - CTRL_H);
  _radius         = size / 2 - ARC_INNER_PAD;
  // Centrado visual respecto al panel completo (h/2) pero en coordenadas del SVG (que empieza en CTRL_H)
  _center         = { x: w / 2, y: (h / 2) - CTRL_H };

  _svg = d3.select(_container)
    .append("svg")
    .attr("width",  "100%")
    .attr("height", `calc(100% - ${CTRL_H}px)`)
    .attr("viewBox", `0 0 ${w} ${h - CTRL_H}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  _defs    = _svg.append("defs");
  _gChords = _svg.append("g").attr("class", "chord-ribbons");
  _gArcs   = _svg.append("g").attr("class", "chord-arcs");
  _gLabels = _svg.append("g").attr("class", "chord-labels");

  _render(raw, true);

  // ── Listeners globales ────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyHighlight(genre);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _restoreAll();
    })
  );

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Render principal ─────────────────────────────────────────────────────────
function _render(raw, isInitial) {
  // Filtrar links por umbral
  const filteredLinks = raw.links.filter(l => l.value >= _threshold);

  if (!filteredLinks.length) {
    _showEmpty();
    return;
  }

  // Géneros que participan en al menos un link
  const genres = _getLinkedGenres(raw, _threshold);
  const n      = genres.length;
  const idxMap = new Map(genres.map((g, i) => [g, i]));

  // ── Matriz para d3.chord() ────────────────────────────────────────────────
  // Matriz n×n donde matrix[i][j] = similitud entre género i y j
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));
  filteredLinks.forEach(({ source, target, value }) => {
    const si = idxMap.get(source);
    const ti = idxMap.get(target);
    if (si == null || ti == null) return;
    const v = (value - _threshold) / (1 - _threshold); // normalizar al umbral
    matrix[si][ti] = v;
    matrix[ti][si] = v;
  });

  // ── d3.chord ─────────────────────────────────────────────────────────────
  const chordLayout = d3.chord()
    .padAngle(ARC_PAD_ANGLE)
    .sortSubgroups(d3.descending);

  const chords = chordLayout(matrix);

  // ── Escalas de arco ───────────────────────────────────────────────────────
  const innerR  = _radius - ARC_WIDTH;
  const outerR  = _radius;

  const arcGen = d3.arc()
    .innerRadius(innerR)
    .outerRadius(outerR);

  const ribbonGen = d3.ribbon().radius(innerR - 1);

  // ── Gradientes por par de géneros ─────────────────────────────────────────
  _defs.selectAll("*").remove();
  filteredLinks.forEach(({ source, target }) => {
    const gradId = `chord-grad-${_safeId(source)}-${_safeId(target)}`;
    if (_defs.select(`#${gradId}`).size()) return;

    const grad = _defs.append("linearGradient")
      .attr("id",          gradId)
      .attr("gradientUnits", "userSpaceOnUse");

    grad.append("stop")
      .attr("offset", "0%")
      .attr("stop-color", genreColor(source))
      .attr("stop-opacity", 0.6);
    grad.append("stop")
      .attr("offset", "100%")
      .attr("stop-color", genreColor(target))
      .attr("stop-opacity", 0.6);
  });

  // ── Cuerdas (ribbons) ─────────────────────────────────────────────────────
  _gChords.selectAll("*").remove();

  const ribbons = _gChords.selectAll(".chord-ribbon")
    .data(chords)
    .join("path")
      .attr("class",        "chord-ribbon")
      .attr("data-source",  d => genres[d.source.index])
      .attr("data-target",  d => genres[d.target.index])
      .attr("fill",         d => {
        const src = genres[d.source.index];
        const tgt = genres[d.target.index];
        return `url(#chord-grad-${_safeId(src)}-${_safeId(tgt)})`;
      })
      .attr("stroke",       "rgba(0,0,0,0.2)")
      .attr("stroke-width", 0.5)
      .attr("transform",    `translate(${_center.x},${_center.y})`)
      .style("cursor",      "pointer");

  if (isInitial) {
    ribbons
      .attr("d", ribbonGen({ source: { startAngle: 0, endAngle: 0 }, target: { startAngle: 0, endAngle: 0 } }))
      .attr("fill-opacity", 0)
      .transition().duration(TRANSITION).delay((_, i) => i * 8)
      .ease(d3.easeCubicOut)
      .attr("d",            d => ribbonGen(d))
      .attr("fill-opacity", _ribbonOpacity.bind(null, genres));
  } else {
    ribbons
      .attr("d",            d => ribbonGen(d))
      .attr("fill-opacity", d => _ribbonOpacity(genres, d));
  }

  ribbons
    .on("mouseenter", function(event, d) {
      const src = genres[d.source.index];
      const tgt = genres[d.target.index];
      const sim = filteredLinks.find(
        l => (l.source === src && l.target === tgt) ||
             (l.source === tgt && l.target === src)
      );
      if (!_activeGenre) {
        _gChords.selectAll(".chord-ribbon")
          .attr("fill-opacity", r =>
            (genres[r.source.index] === src || genres[r.target.index] === src ||
             genres[r.source.index] === tgt || genres[r.target.index] === tgt)
              ? 0.75 : 0.04
          );
      }
      tooltip.show(event, tooltip.html({
        title:    `${src} ↔ ${tgt}`,
        color:    genreColor(src),
        rows: [
          { key: "Similitud",   value: fmt(sim?.value ?? 0, 4) },
          { key: "Umbral",      value: fmt(_threshold, 2)       },
        ],
        footer: "Similitud coseno en audio features",
      }));
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function() {
      tooltip.hide();
      if (!_activeGenre) _restoreAll();
      else _applyHighlight(_activeGenre);
    });

  // ── Arcos exteriores ──────────────────────────────────────────────────────
  _gArcs.selectAll("*").remove();

  const arcGroups = _gArcs.selectAll(".chord-arc-g")
    .data(chords.groups)
    .join("g")
      .attr("class",      "chord-arc-g")
      .attr("data-genre", d => genres[d.index])
      .attr("transform",  `translate(${_center.x},${_center.y})`)
      .style("cursor",    "pointer");

  arcGroups.append("path")
    .attr("class",       "chord-arc")
    .attr("d",           arcGen)
    .attr("fill",        d => genreColor(genres[d.index]))
    .attr("fill-opacity", d => _arcOpacity(genres, d))
    .attr("stroke",      "rgba(0,0,0,0.3)")
    .attr("stroke-width", 0.5);

  arcGroups
    .on("mouseenter", function(event, d) {
      const genre = genres[d.index];
      if (!_activeGenre) _dimAllExcept(genres, genre);
      d3.select(this).select(".chord-arc").attr("fill-opacity", 1);
      tooltip.show(event, tooltip.html({
        title: genre,
        color: genreColor(genre),
        rows: [
          {
            key:   "Conexiones",
            value: filteredLinks.filter(l => l.source === genre || l.target === genre).length,
          },
          {
            key:   "Sim. máx.",
            value: fmt(
              d3.max(
                filteredLinks.filter(l => l.source === genre || l.target === genre),
                l => l.value
              ) ?? 0, 4
            ),
          },
        ],
        footer: "Clic para filtrar todos los gráficos",
      }));
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function() {
      tooltip.hide();
      if (!_activeGenre) _restoreAll();
      else _applyHighlight(_activeGenre);
    })
    .on("click", (_, d) => {
      const genre = genres[d.index];
      if (_activeGenre === genre) clearAllFilters();
      else selectGenre(genre);
    });

  // ── Etiquetas ─────────────────────────────────────────────────────────────
  _gLabels.selectAll("*").remove();

  _gLabels.selectAll(".chord-label")
    .data(chords.groups)
    .join("text")
      .attr("class",      "chord-label")
      .attr("data-genre", d => genres[d.index])
      .attr("transform",  d => {
        const angle  = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
        const labelR = outerR + LABEL_PAD;
        const x      = _center.x + labelR * Math.cos(angle);
        const y      = _center.y + labelR * Math.sin(angle);
        const deg    = (angle * 180 / Math.PI) + 90;
        // Voltear etiquetas en la mitad inferior para legibilidad
        const flip   = angle > 0 ? 180 : 0;
        return `translate(${x},${y}) rotate(${deg + flip})`;
      })
      .attr("text-anchor", d => {
        const angle = (d.startAngle + d.endAngle) / 2 - Math.PI / 2;
        return angle > 0 ? "end" : "start";
      })
      .attr("dominant-baseline", "central")
      .attr("font-size",   "8.5px")
      .attr("font-weight", "500")
      .attr("fill",        d => genreColor(genres[d.index]))
      .attr("fill-opacity", d => _labelOpacity(genres, d))
      .style("pointer-events", "none")
      .text(d => {
        const g     = genres[d.index];
        const arcSpan = d.endAngle - d.startAngle;
        const maxLen  = Math.max(2, Math.floor(arcSpan * _radius / 5.5));
        return g.length > maxLen ? g.slice(0, maxLen - 1) + "…" : g;
      });

  // Aplicar highlight si ya hay filtro activo
  if (_activeGenre) _applyHighlight(_activeGenre);
}

// ─── Highlight coordinado ─────────────────────────────────────────────────────
function _applyHighlight(genre) {
  if (!_svg) return;

  _gChords.selectAll(".chord-ribbon")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      const src = d3.select(this).attr("data-source");
      const tgt = d3.select(this).attr("data-target");
      return (src === genre || tgt === genre) ? 0.75 : 0.04;
    });

  _gArcs.selectAll(".chord-arc")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      const g = d3.select(this.parentNode).attr("data-genre");
      return g === genre ? 1.0 : 0.2;
    });

  _gLabels.selectAll(".chord-label")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      const g = d3.select(this).attr("data-genre");
      return g === genre ? 1.0 : 0.2;
    });
}

function _dimAllExcept(genres, genre) {
  _gChords.selectAll(".chord-ribbon")
    .attr("fill-opacity", function() {
      const src = d3.select(this).attr("data-source");
      const tgt = d3.select(this).attr("data-target");
      return (src === genre || tgt === genre) ? 0.75 : 0.04;
    });
  _gArcs.selectAll(".chord-arc")
    .attr("fill-opacity", function() {
      return d3.select(this.parentNode).attr("data-genre") === genre ? 1.0 : 0.2;
    });
}

function _restoreAll() {
  if (!_svg) return;
  _gChords.selectAll(".chord-ribbon")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.45);
  _gArcs.selectAll(".chord-arc")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.82);
  _gLabels.selectAll(".chord-label")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.75);
}

// ─── Helpers de opacidad ──────────────────────────────────────────────────────
function _ribbonOpacity(genres, d) {
  if (!_activeGenre) return 0.45;
  const src = genres[d.source.index];
  const tgt = genres[d.target.index];
  return (src === _activeGenre || tgt === _activeGenre) ? 0.75 : 0.04;
}

function _arcOpacity(genres, d) {
  if (!_activeGenre) return 0.82;
  return genres[d.index] === _activeGenre ? 1.0 : 0.2;
}

function _labelOpacity(genres, d) {
  if (!_activeGenre) return 0.75;
  return genres[d.index] === _activeGenre ? 1.0 : 0.2;
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls(raw) {
  const bar = document.createElement("div");
  bar.className  = "chord-controls";
  bar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 4px 14px;
    height: 38px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
  `;

  // Label umbral
  const lbl = document.createElement("span");
  lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;";
  lbl.textContent   = "Umbral similitud:";

  // Valor en tiempo real
  const valSpan = document.createElement("span");
  valSpan.style.cssText = "color:var(--spotify-green);font-weight:600;font-size:11px;min-width:36px;";
  valSpan.textContent   = _threshold.toFixed(2);

  // Slider
  const slider = document.createElement("input");
  slider.type  = "range";
  slider.min   = "0.90";
  slider.max   = "0.999";
  slider.step  = "0.001";
  slider.value = String(_threshold);
  slider.style.cssText = `
    width: 110px;
    accent-color: var(--spotify-green);
    cursor: pointer;
  `;

  // Contador de conexiones
  const connCount = document.createElement("span");
  connCount.style.cssText = "font-size:10px;color:var(--text-hint);";
  connCount.id = "chord-conn-count";
  connCount.textContent = `${raw.links.filter(l => l.value >= _threshold).length} conexiones`;

  slider.addEventListener("input", () => {
    _threshold      = +slider.value;
    valSpan.textContent = _threshold.toFixed(3);
    connCount.textContent = `${raw.links.filter(l => l.value >= _threshold).length} conexiones`;
  });

  slider.addEventListener("change", () => {
    _threshold = +slider.value;
    _render(raw, false);
    if (_activeGenre) _applyHighlight(_activeGenre);
  });

  // Hint
  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);";
  hint.textContent   = "Hover para explorar · Clic en arco para filtrar";

  bar.appendChild(lbl);
  bar.appendChild(slider);
  bar.appendChild(valSpan);
  bar.appendChild(connCount);
  bar.appendChild(hint);
  _container.appendChild(bar);
}

// ─── Placeholder si no hay conexiones con el umbral dado ─────────────────────
function _showEmpty() {
  _gChords.selectAll("*").remove();
  _gArcs.selectAll("*").remove();
  _gLabels.selectAll("*").remove();

  _svg.selectAll(".chord-empty").remove();
  _svg.append("text")
    .attr("class",       "chord-empty")
    .attr("x",           _center.x)
    .attr("y",           _center.y)
    .attr("text-anchor", "middle")
    .attr("font-size",   "12px")
    .attr("fill",        "var(--text-hint)")
    .text("Baja el umbral para ver conexiones");
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _getLinkedGenres(raw, threshold) {
  const set = new Set();
  raw.links.filter(l => l.value >= threshold).forEach(l => {
    set.add(l.source);
    set.add(l.target);
  });
  return [...set];
}

/** Convierte un nombre de género en un id CSS seguro */
function _safeId(str) {
  return str.replace(/[^a-zA-Z0-9]/g, "_");
}

function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return; // Prevenir redibujado si está oculto
  if (Math.abs(w - _prevW) < 6 && Math.abs(h - _prevH) < 6) return;
  const prev = _activeGenre;
  _build();
  if (prev) { _activeGenre = prev; _applyHighlight(prev); }
}

function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 200), h: Math.max(r.height, 200) };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initChord };