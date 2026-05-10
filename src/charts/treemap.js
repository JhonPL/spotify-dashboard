/**
 * treemap.js — Treemap jerárquico de géneros por popularidad v3
 *
 * Fix crítico: reemplaza opacity en <g> por fill-opacity en <rect>
 * para evitar parpadeo con el shimmer CSS del panel__body::before
 */

import * as d3     from "d3";
import store        from "../core/store.js";
import { on }       from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import { initGenreScale, fmt } from "../utils/scales.js";
import tooltip      from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN      = { top: 4, right: 4, bottom: 4, left: 4 };
// Umbrales mínimos para mostrar texto — muy bajos para cubrir la mayor cantidad
// de celdas posible. El truncado se encarga de ajustar a lo que quepa.
const CHAR_W_H    = 6.0;   // px por carácter en horizontal (fuente 9px)
const CHAR_W_V    = 6.2;   // px por carácter en vertical   (fuente 9px)
const MIN_ANY_H   = 10;    // altura mínima absoluta para cualquier etiqueta
const MIN_ANY_W   = 8;     // ancho mínimo absoluto para cualquier etiqueta
const TRANSITION  = 250;

// ─── Estado del módulo ────────────────────────────────────────────────────────
let _container      = null;
let _svg            = null;
let _selected       = null;
let _resizeObs      = null;
let _unsubListeners = [];
let _prevW          = 0;
let _prevH          = 0;
let _obsTimer       = null;  // Timer para reanudar el observer tras la transición

// ─── Escala de color ──────────────────────────────────────────────────────────
function buildColorScale(data) {
  const [lo, hi] = d3.extent(data, (d) => d.popularity);
  return d3.scaleLinear()
    .domain([lo, lo + (hi - lo) * 0.45, hi])
    .range(["#1a3a2a", "#0f6b35", "#1DB954"])
    .clamp(true);
}

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initTreemap(container) {
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

  _unsubListeners.forEach((fn) => fn());
  _unsubListeners = [];

  initGenreScale(data.map((d) => d.track_genre));

  const { w, h } = _dims();
  _prevW = w;
  _prevH = h;

  _container.innerHTML = "";
  _container.classList.remove("loading");
  _container.classList.add("rendered");
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top  - MARGIN.bottom;

  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top", "0")
    .style("left", "0")
    .style("width", "100%")
    .style("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  const g = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  const colorScale = buildColorScale(data);

  // ── Layout treemap ────────────────────────────────────────────────────────
  const root = d3.hierarchy({ children: data })
    .sum((d) => d.count ?? 0)
    .sort((a, b) => b.value - a.value);

  d3.treemap()
    .size([innerW, innerH])
    .paddingInner(2)
    .paddingOuter(2)
    .round(true)(root);

  // ── Celdas ────────────────────────────────────────────────────────────────
  const cell = g.selectAll("g.tm-cell")
    .data(root.leaves(), (d) => d.data.track_genre)
    .join("g")
      .attr("class",      "tm-cell")
      .attr("data-genre", (d) => d.data.track_genre)
      .attr("transform",  (d) => `translate(${d.x0},${d.y0})`)
      .style("cursor", "pointer");

  // Rectángulo base — el dimming se hace sobre fill-opacity, NO sobre
  // opacity del <g>, para evitar conflicto con el shimmer CSS ::before
  cell.append("rect")
    .attr("class",        "tm-bg")
    .attr("width",        (d) => Math.max(0, d.x1 - d.x0))
    .attr("height",       (d) => Math.max(0, d.y1 - d.y0))
    .attr("rx",           4)
    .attr("fill",         (d) => colorScale(d.data.popularity))
    .attr("fill-opacity", 1)
    .attr("stroke",       "rgba(0,0,0,0.3)")
    .attr("stroke-width", 0.5);

  // Overlay hover
  cell.append("rect")
    .attr("class",        "tm-hover")
    .attr("width",        (d) => Math.max(0, d.x1 - d.x0))
    .attr("height",       (d) => Math.max(0, d.y1 - d.y0))
    .attr("rx",           4)
    .attr("fill",         "rgba(29,185,84,0.22)")
    .attr("fill-opacity", 0)
    .style("pointer-events", "none");

  // Rectángulo de dimming independiente (negro semitransparente encima)
  // Esto permite atenuar SIN tocar opacity del <g>
  cell.append("rect")
    .attr("class",        "tm-dim")
    .attr("width",        (d) => Math.max(0, d.x1 - d.x0))
    .attr("height",       (d) => Math.max(0, d.y1 - d.y0))
    .attr("rx",           4)
    .attr("fill",         "#000000")
    .attr("fill-opacity", 0)           // empieza invisible
    .style("pointer-events", "none");

  // ── Etiquetas: muestra lo que quepa en cada celda ─────────────────────────
  // Prioridad: horizontal si el ancho lo permite, vertical si la altura lo permite.
  // Siempre se muestra aunque solo quepan 1-2 caracteres.
  cell.each(function (d) {
    const cw = d.x1 - d.x0;
    const ch = d.y1 - d.y0;
    const sel = d3.select(this);

    // Celda demasiado pequeña en ambas dimensiones → sin etiqueta
    if (cw < MIN_ANY_W || ch < MIN_ANY_H) return;

    // Caracteres que caben en horizontal (restando padding de 6px a cada lado)
    const charsH = Math.floor((cw - 8) / CHAR_W_H);
    // Caracteres que caben en vertical (restando padding 5px arriba y abajo)
    const charsV = Math.floor((ch - 10) / CHAR_W_V);

    // ── Preferir horizontal si caben ≥ 2 chars y hay altura mínima ────────
    if (charsH >= 2 && ch >= MIN_ANY_H) {
      const fontSize = cw > 90 ? "11px" : "9px";
      const hasSub   = ch > 38 && cw > 70 && charsH >= 5;
      const nameY    = hasSub ? 15 : Math.floor(ch / 2) + 4;

      sel.append("text")
        .attr("class",        "tm-label")
        .attr("x",            5)
        .attr("y",            nameY)
        .attr("font-size",    fontSize)
        .attr("font-weight",  "600")
        .attr("fill",         "#ffffff")
        .attr("fill-opacity", 0.9)
        .style("pointer-events", "none")
        .text(_truncate(d.data.track_genre, charsH));

      if (hasSub) {
        sel.append("text")
          .attr("class",       "tm-sublabel")
          .attr("x",           5)
          .attr("y",           29)
          .attr("font-size",   "9px")
          .attr("fill",        "rgba(255,255,255,0.48)")
          .style("pointer-events", "none")
          .text(`Pop ${fmt(d.data.popularity, 0)}`);
      }
      return;
    }

    // ── Vertical si caben ≥ 2 chars en altura y hay ancho mínimo ──────────
    if (charsV >= 2 && cw >= MIN_ANY_W) {
      const fontSize = cw >= 18 ? "9px" : "8px";
      const cx = Math.floor(cw / 2);
      const cy = Math.floor(ch / 2);

      sel.append("text")
        .attr("class",        "tm-label tm-label--vert")
        .attr("transform",    `translate(${cx},${cy}) rotate(-90)`)
        .attr("text-anchor",  "middle")
        .attr("dominant-baseline", "central")
        .attr("font-size",    fontSize)
        .attr("font-weight",  "600")
        .attr("fill",         "#ffffff")
        .attr("fill-opacity", 0.85)
        .style("pointer-events", "none")
        .text(_truncate(d.data.track_genre, charsV));
      return;
    }

    // ── Fallback: mostrar 1 carácter horizontal si cabe algo ──────────────
    if (charsH >= 1 && ch >= MIN_ANY_H) {
      sel.append("text")
        .attr("class",        "tm-label")
        .attr("x",            Math.floor(cw / 2))
        .attr("y",            Math.floor(ch / 2) + 4)
        .attr("font-size",    "8px")
        .attr("font-weight",  "600")
        .attr("fill",         "#ffffff")
        .attr("fill-opacity", 0.75)
        .attr("text-anchor",  "middle")
        .style("pointer-events", "none")
        .text(d.data.track_genre[0]);
    }
  });

  // ── Hover ─────────────────────────────────────────────────────────────────
  cell
    .on("mouseenter", function (event, d) {
      // Solo mostrar hover si la celda no está dimmed
      const dimOpacity = +d3.select(this).select(".tm-dim").attr("fill-opacity");
      if (dimOpacity > 0.5) return;

      d3.select(this).select(".tm-hover")
        .transition().duration(100).attr("fill-opacity", 1);

      tooltip.show(event, tooltip.html({
        title: d.data.track_genre,
        color: colorScale(d.data.popularity),
        rows: [
          { key: "Tracks",       value: (d.data.count ?? 0).toLocaleString("es") },
          { key: "Popularidad",  value: fmt(d.data.popularity, 1) },
          { key: "Energy",       value: fmt(d.data.energy, 2) },
          { key: "Danceability", value: fmt(d.data.danceability, 2) },
          { key: "Valence",      value: fmt(d.data.valence, 2) },
          { key: "Tempo",        value: `${fmt(d.data.tempo, 0)} BPM` },
        ],
      }));
    })
    .on("mousemove",  (event) => tooltip.move(event))
    .on("mouseleave", function () {
      d3.select(this).select(".tm-hover")
        .transition().duration(150).attr("fill-opacity", 0);
      tooltip.hide();
    });

  cell.on("click", (_, d) => _toggleSelection(d.data.track_genre));

  // ── Listeners globales ────────────────────────────────────────────────────
  _unsubListeners.push(
    on("filters:clear", () => { _selected = null; _restoreAll(); })
  );
  _unsubListeners.push(
    on("genre:select", ({ genre }) => {
      if (genre === _selected) return;
      _selected = genre;
      genre ? _applyFocus(genre) : _restoreAll();
    })
  );

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  // Debounce > TRANSITION para no reconstruir durante animaciones D3
  _resizeObs = new ResizeObserver(_debounce(_rebuild, 400));
  _resizeObs.observe(_container);
}

// ─── Toggle selección ─────────────────────────────────────────────────────────
function _toggleSelection(genre) {
  if (_selected === genre) {
    _selected = null;
    clearAllFilters();
    _restoreAll();
  } else {
    _selected = genre;
    selectGenre(genre);
    _applyFocus(genre);
  }
}

// ─── Focus: oscurecer celdas no seleccionadas con tm-dim ──────────────────────
// Usamos fill-opacity en un rect overlay en lugar de opacity en el <g>
// para no interferir con el shimmer CSS del panel__body::before
function _applyFocus(genre, instant = false) {
  if (!_svg) return;
  const dur = instant ? 0 : TRANSITION;

  // Pausar observer durante la transición para evitar rebuilds espurios
  // (el pill de filtro que aparece en el topbar cambia el tamaño del panel)
  _pauseObserver(dur + 50);

  // Interrumpir transiciones en curso antes de iniciar nuevas
  _svg.selectAll(".tm-cell .tm-dim").interrupt();
  _svg.selectAll(".tm-cell .tm-bg").interrupt();

  // Oscurecer las NO seleccionadas
  _svg.selectAll(".tm-cell .tm-dim")
    .transition().duration(dur)
    .attr("fill-opacity", (d) => d.data.track_genre === genre ? 0 : 0.72);

  // Borde verde en la seleccionada
  _svg.selectAll(".tm-cell .tm-bg")
    .transition().duration(dur)
    .attr("stroke",       (d) => d.data.track_genre === genre ? "#1DB954" : "rgba(0,0,0,0.3)")
    .attr("stroke-width", (d) => d.data.track_genre === genre ? 2 : 0.5);
}

// ─── Restaurar todas las celdas ───────────────────────────────────────────────
function _restoreAll() {
  if (!_svg) return;

  // Pausar observer durante la transición
  _pauseObserver(TRANSITION + 50);

  // Interrumpir transiciones en curso antes de iniciar nuevas
  _svg.selectAll(".tm-cell .tm-dim").interrupt();
  _svg.selectAll(".tm-cell .tm-bg").interrupt();

  _svg.selectAll(".tm-cell .tm-dim")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0);

  _svg.selectAll(".tm-cell .tm-bg")
    .transition().duration(TRANSITION)
    .attr("stroke",       "rgba(0,0,0,0.3)")
    .attr("stroke-width", 0.5);
}

// ─── Rebuild en resize ────────────────────────────────────────────────────────
function _rebuild() {
  // Ignorar notificaciones spurias del ResizeObserver que no cambian dimensiones reales
  const { w, h } = _dims();
  if (w === 0 || h === 0) return; // Ignore if hidden
  if (Math.abs(w - _prevW) < 4 && Math.abs(h - _prevH) < 4) return;

  const prev = _selected;
  _build();
  // Aplicar foco sin transición para que no sea cancelado por D3
  if (prev) { _selected = prev; _applyFocus(prev, true); }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 200), h: Math.max(r.height, 160) };
}

function _truncate(str, max) {
  if (!str || max < 1) return "";
  if (str.length <= max) return str;
  // Solo añadir "…" si hay espacio para al menos 1 carácter real + el símbolo
  if (max >= 3) return str.slice(0, max - 1) + "…";
  // max 1 ó 2: mostrar caracteres crudos sin símbolo
  return str.slice(0, max);
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Pausar el ResizeObserver por `ms` milisegundos para evitar rebuilds espurios
// durante las transiciones D3 (el pill del topbar cambia el tamaño del panel)
function _pauseObserver(ms) {
  if (!_resizeObs || !_container) return;
  _resizeObs.unobserve(_container);
  clearTimeout(_obsTimer);
  _obsTimer = setTimeout(() => {
    if (_resizeObs && _container) {
      // Actualizar dimensiones de referencia antes de reanudar
      const { w, h } = _dims();
      _prevW = w;
      _prevH = h;
      _resizeObs.observe(_container);
    }
  }, ms);
}

export default { initTreemap };