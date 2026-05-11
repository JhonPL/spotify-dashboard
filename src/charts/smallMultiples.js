/**
 * smallMultiples.js — Small Multiples de audio features por género v1
 *
 * Muestra una cuadrícula de mini bar charts: una columna por audio feature,
 * una fila por género. Cada celda es una barra que representa el valor medio
 * del género en esa feature (datos de genresSummary).
 *
 * Paradigma "small multiples" de Tufte: misma escala, mismo layout,
 * datos distintos → permite comparación instantánea entre géneros y features.
 *
 * Features:
 *   - Grid responsivo: columnas = features, filas = géneros (top N)
 *   - Escala compartida por columna (misma feature, rangos comparables)
 *   - Colorizado por feature (FEATURE_COLORS) o por género (toggle)
 *   - Barras horizontales con valor numérico inline si hay espacio
 *   - Ordenar filas: por popularidad / por nombre / por feature seleccionada
 *   - Highlight coordinado: genre:select → resalta fila completa
 *   - Hover fila → tooltip con perfil completo del género
 *   - Hover celda → tooltip individual con valor exacto + ranking
 *   - Clic en fila → selectGenre() (linked views)
 *   - Clic en cabecera de columna → reordenar por esa feature
 *   - Animación de entrada: barras crecen desde el eje izquierdo
 *   - ResizeObserver con debounce
 *
 * Datos: genresSummary (fase 1) — disponible inmediatamente.
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
const FEATURES = [
  "popularity", "energy", "danceability",
  "valence", "acousticness", "speechiness",
  "liveness", "instrumentalness",
];
const FEATURE_DOMAINS = {
  popularity: [0, 100],
  // el resto son 0-1 por definición del dataset
};

const ROW_H        = 32;     // Un poco más de altura para legibilidad
const ROW_PAD      = 4;      // Más separación
const COL_LABEL_W  = 130;    // Más espacio para nombres largos
const CTRL_H       = 36;
const HEADER_H     = 48;
const BAR_RADIUS   = 3;
const TRANSITION   = 350;
const DEBOUNCE_MS  = 380;
const MAX_GENRES   = 20;

// Modos de ordenación
const SORT_MODES = {
  popularity:  { label: "Popularidad", fn: (a, b) => b.popularity - a.popularity },
  name:        { label: "A → Z",       fn: (a, b) => a.track_genre.localeCompare(b.track_genre) },
  energy:      { label: "Energía",     fn: (a, b) => b.energy - a.energy },
  danceability:{ label: "Dance",       fn: (a, b) => b.danceability - a.danceability },
};

// Modos de color
const COLOR_MODES = {
  feature: "Por feature",
  genre:   "Por género",
};

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container    = null;
let _svg          = null;
let _gRows        = null;
let _gHeader      = null;
let _resizeObs    = null;
let _unsubs       = [];
let _prevW        = 0;
let _prevH        = 0;
let _activeGenre  = null;
let _sortKey      = "popularity";
let _colorMode    = "feature";
let _sortFeature  = null;   // feature por la que se ordenó clicando cabecera

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initSmallMultiples(container) {
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
      _init();
    });
    return;
  }
  _init();
}

function _init() {
  _build();

  // Limpiar listener previo si existe para evitar acumulaciones
  if (window._smResizeHandler) {
    window.removeEventListener("resize", window._smResizeHandler);
  }

  window._smResizeHandler = _debounce(() => {
    const { w, h } = _dims();
    if (Math.abs(w - _prevW) < 15 && Math.abs(h - _prevH) < 15) return;
    _rebuild();
  }, DEBOUNCE_MS);

  window.addEventListener("resize", window._smResizeHandler);
}

// ─── Build ────────────────────────────────────────────────────────────────────
function _build() {
  const raw = store.getData("genresSummary");
  if (!raw || !_container) return;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  initGenreScale(raw.map(d => d.track_genre));

  // Estructura base (solo una vez)
  let ctrlBar = _container.querySelector(".sm-controls");
  let scrollWrap = _container.querySelector("#sm-scroll-wrap");

  if (!scrollWrap) {
    _container.innerHTML = "";
    
    ctrlBar = document.createElement("div");
    ctrlBar.className = "sm-controls";
    _container.appendChild(ctrlBar);

    scrollWrap = document.createElement("div");
    scrollWrap.id = "sm-scroll-wrap";
    scrollWrap.style.cssText = "width:100%;height:calc(100% - 36px);overflow-y:scroll;overflow-x:hidden;position:relative;";
    _container.appendChild(scrollWrap);
  }

  // Actualizar controles (pills)
  _updateControls(ctrlBar);

  _update(raw, scrollWrap);
}

// ─── Update (la parte que realmente dibuja) ──────────────────────────────────
function _update(raw, scrollWrap) {
  // ── Ordenar y limitar géneros ──────────────────────────────────────────────
  const sortFn = _sortFeature
    ? (a, b) => b[_sortFeature] - a[_sortFeature]
    : SORT_MODES[_sortKey]?.fn ?? SORT_MODES.popularity.fn;

  const data = [...raw].sort(sortFn).slice(0, MAX_GENRES);

  // ── Dimensiones ───────────────────────────────────────────────────────────
  // Usamos el ancho real del scrollWrap para evitar que el SVG cause scroll horizontal
  const w = scrollWrap.clientWidth || _container.clientWidth || 320;
  const h = _container.clientHeight || 200;
  _prevW = _container.getBoundingClientRect().width; 
  _prevH = _container.getBoundingClientRect().height;

  // Ancho disponible para las barras (descontando etiqueta de género)
  const barsAreaW  = w - COL_LABEL_W;
  const nFeatures  = FEATURES.length;
  const colW       = Math.floor(barsAreaW / nFeatures);
  const barMaxW    = colW - 8;
  const totalH     = HEADER_H + data.length * (ROW_H + ROW_PAD) + 20;

  // ── SVG ───────────────────────────────────────────────────────────────────
  let svg = d3.select(scrollWrap).select("svg");
  if (svg.empty()) {
    svg = d3.select(scrollWrap).append("svg");
  }
  
  _svg = svg
    .attr("width",  w)
    .attr("height", Math.max(totalH, h - 36));
  
  _svg.selectAll("*").remove(); // Borramos contenido interno pero mantenemos el elemento SVG

  // ── Escalas por columna (compartidas en todas las filas de la feature) ────
  // Escala separada por feature para que cada columna sea comparable internamente
  const xScales = {};
  FEATURES.forEach(f => {
    const domain = FEATURE_DOMAINS[f] ?? [0, d3.max(data, d => +d[f] ?? 0)];
    xScales[f] = d3.scaleLinear()
      .domain([0, domain[1]])
      .range([0, barMaxW])
      .clamp(true);
  });

  // ── Cabecera de features ──────────────────────────────────────────────────
  _gHeader = _svg.append("g")
    .attr("class", "sm-header")
    .attr("transform", `translate(${COL_LABEL_W}, 0)`);

  FEATURES.forEach((f, fi) => {
    const gCol = _gHeader.append("g")
      .attr("transform",  `translate(${fi * colW}, 0)`)
      .style("cursor",    "pointer")
      .on("click", () => {
        _sortFeature = (_sortFeature === f) ? null : f;
        _sortKey     = _sortFeature ? null : "popularity";
        _build();
      });

    // Fondo de cabecera
    gCol.append("rect")
      .attr("width",  colW - 2)
      .attr("height", HEADER_H - 4)
      .attr("y",      2)
      .attr("rx",     4)
      .attr("fill",   _sortFeature === f ? "rgba(29,185,84,0.12)" : "rgba(255,255,255,0.03)")
      .attr("stroke", _sortFeature === f ? "var(--spotify-green)" : "var(--border-subtle)")
      .attr("stroke-width", 0.5);

    // Pastilla de color de la feature
    gCol.append("circle")
      .attr("cx",   colW / 2)
      .attr("cy",   14)
      .attr("r",    4)
      .attr("fill", FEATURE_COLORS[f] || "var(--spotify-green)");

    // Label de feature — rotado si es largo
    const label = (FEATURE_LABELS[f] || f).replace("ibility", "y").replace("ness", ".");
    gCol.append("text")
      .attr("x",           colW / 2)
      .attr("y",           HEADER_H - 10)
      .attr("text-anchor", "middle")
      .attr("font-size",   "9px")
      .attr("font-weight", _sortFeature === f ? "700" : "500")
      .attr("fill",        _sortFeature === f ? "var(--spotify-green)" : "var(--text-secondary)")
      .text(label.length > 7 ? label.slice(0, 6) + "." : label);

    // Flecha de orden activo
    if (_sortFeature === f) {
      gCol.append("text")
        .attr("x",           colW / 2)
        .attr("y",           HEADER_H - 1)
        .attr("text-anchor", "middle")
        .attr("font-size",   "8px")
        .attr("fill",        "var(--spotify-green)")
        .text("▼");
    }
  });

  // ── Filas de géneros ──────────────────────────────────────────────────────
  _gRows = _svg.append("g")
    .attr("class", "sm-rows")
    .attr("transform", `translate(0, ${HEADER_H})`);

  const rows = _gRows.selectAll(".sm-row")
    .data(data, d => d.track_genre)
    .join("g")
      .attr("class",      "sm-row")
      .attr("data-genre", d => d.track_genre)
      .attr("transform",  (_, i) => `translate(0, ${i * (ROW_H + ROW_PAD)})`)
      .style("cursor",    "pointer");

  // Fondo de fila (hover + selección)
  rows.append("rect")
    .attr("class",        "sm-row-bg")
    .attr("width",        w)
    .attr("height",       ROW_H)
    .attr("rx",           4)
    .attr("fill",         d => _activeGenre === d.track_genre
      ? "rgba(29,185,84,0.08)"
      : "rgba(255,255,255,0.02)"
    )
    .attr("stroke",       d => _activeGenre === d.track_genre
      ? "rgba(29,185,84,0.3)"
      : "transparent"
    );

  // Etiqueta de género (columna izquierda)
  rows.append("text")
    .attr("x",             24)
    .attr("y",             ROW_H / 2 + 1)
    .attr("text-anchor",   "start")
    .attr("dominant-baseline", "central")
    .attr("font-size",     "10px")
    .attr("font-weight",   d => _activeGenre === d.track_genre ? "700" : "500")
    .attr("fill",          d => _activeGenre === d.track_genre
      ? "var(--spotify-green)"
      : "var(--text-primary)"
    )
    .text(d => {
      const name = d.track_genre;
      return name.length > 18 ? name.slice(0, 16) + "…" : name;
    });

  // Punto de color de género (al inicio de la fila)
  rows.append("circle")
    .attr("cx",   10)
    .attr("cy",   ROW_H / 2)
    .attr("r",    3.5)
    .attr("fill", d => genreColor(d.track_genre));

  // ── Mini barras por feature ────────────────────────────────────────────────
  FEATURES.forEach((f, fi) => {
    const colX = COL_LABEL_W + fi * colW;
    const barColor = (d) => _colorMode === "genre"
      ? genreColor(d.track_genre)
      : (FEATURE_COLORS[f] || "var(--spotify-green)");

    // Fondo de celda (track de la barra)
    rows.append("rect")
      .attr("class",      "sm-track")
      .attr("x",          colX + 4)
      .attr("y",          ROW_H / 2 - 5)
      .attr("width",      barMaxW)
      .attr("height",     10)
      .attr("rx",         BAR_RADIUS)
      .attr("fill",       "rgba(255,255,255,0.04)");

    // Barra de valor
    const bar = rows.append("rect")
      .attr("class",        "sm-bar")
      .attr("data-feature", f)
      .attr("x",            colX + 4)
      .attr("y",            ROW_H / 2 - 5)
      .attr("width",        0)      // empieza en 0 para animación
      .attr("height",       10)
      .attr("rx",           BAR_RADIUS)
      .attr("fill",         barColor)
      .attr("fill-opacity", d => _activeGenre && _activeGenre !== d.track_genre ? 0.2 : 0.75);

    // Animación de entrada
    bar.transition()
      .duration(TRANSITION)
      .delay((_, i) => i * 12)
      .ease(d3.easeCubicOut)
      .attr("width", d => xScales[f](+d[f] ?? 0));

    // Valor numérico inline (solo si la barra es suficientemente ancha)
    rows.append("text")
      .attr("class",      "sm-bar-label")
      .attr("data-feature", f)
      .attr("x",          colX + 4 + 3)
      .attr("y",          ROW_H / 2 + 1)
      .attr("dominant-baseline", "central")
      .attr("font-size",  "7px")
      .attr("fill",       "#000")
      .attr("fill-opacity", d => {
        const bw = xScales[f](+d[f] ?? 0);
        return bw > 22 ? 0.55 : 0;  // solo visible si la barra es ancha
      })
      .text(d => {
        const v = +d[f] ?? 0;
        return f === "popularity" ? Math.round(v) : v.toFixed(2);
      });

    // Zona interactiva por celda
    rows.append("rect")
      .attr("x",          colX)
      .attr("y",          0)
      .attr("width",      colW)
      .attr("height",     ROW_H)
      .attr("fill",       "transparent")
      .on("mouseenter", function(event, d) {
        // Destacar barra de la celda
        d3.select(this.parentNode).selectAll(`.sm-bar[data-feature="${f}"]`)
          .attr("fill-opacity", 1);

        // Calcular ranking del género en esta feature
        const sorted   = [...data].sort((a, b) => +b[f] - +a[f]);
        const rank     = sorted.findIndex(g => g.track_genre === d.track_genre) + 1;
        const color    = _colorMode === "genre"
          ? genreColor(d.track_genre)
          : (FEATURE_COLORS[f] || "var(--spotify-green)");

        tooltip.show(event, tooltip.html({
          title:    d.track_genre,
          color:    genreColor(d.track_genre),
          rows: [
            { key: FEATURE_LABELS[f] || f,
              value: f === "popularity"
                ? Math.round(+d[f]).toString()
                : fmt(+d[f], 3),
              color,
            },
            { key: "Ranking",  value: `#${rank} de ${data.length}` },
            { key: "Tracks",   value: (d.count ?? 0).toLocaleString("es") },
          ],
          footer: "Clic para filtrar todos los gráficos",
        }));
      })
      .on("mousemove",  event => tooltip.move(event))
      .on("mouseleave", function(_, d) {
        d3.select(this.parentNode).selectAll(`.sm-bar[data-feature="${f}"]`)
          .attr("fill-opacity", _activeGenre && _activeGenre !== d.track_genre ? 0.2 : 0.75);
        tooltip.hide();
      });
  });

  // ── Interactividad de fila completa ───────────────────────────────────────
  rows
    .on("mouseenter", function(event, d) {
      if (_activeGenre) return;
      // Resaltar fila
      d3.select(this).select(".sm-row-bg")
        .attr("fill", "rgba(255,255,255,0.05)")
        .attr("stroke", "rgba(255,255,255,0.08)");
      // Mostrar tooltip de perfil completo
      tooltip.show(event, tooltip.html({
        title:    d.track_genre,
        color:    genreColor(d.track_genre),
        rows: [
          { key: "Popularidad",  value: Math.round(d.popularity) },
          { key: "Energy",       value: fmt(d.energy, 2) },
          { key: "Danceability", value: fmt(d.danceability, 2) },
          { key: "Valence",      value: fmt(d.valence, 2) },
          { key: "Acousticness", value: fmt(d.acousticness, 2) },
          { key: "Tracks",       value: (d.count ?? 0).toLocaleString("es") },
        ],
        footer: "Clic para filtrar todos los gráficos",
      }));
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function() {
      if (_activeGenre) return;
      d3.select(this).select(".sm-row-bg")
        .attr("fill", "rgba(255,255,255,0.02)")
        .attr("stroke", "transparent");
      tooltip.hide();
    })
    .on("click", (_, d) => {
      if (_activeGenre === d.track_genre) clearAllFilters();
      else selectGenre(d.track_genre);
    });

  // ── Líneas separadoras entre columnas ─────────────────────────────────────
  const gDividers = _svg.append("g")
    .attr("class", "sm-dividers")
    .style("pointer-events", "none");

  FEATURES.forEach((_, fi) => {
    if (fi === 0) return;
    gDividers.append("line")
      .attr("x1", COL_LABEL_W + fi * colW)
      .attr("x2", COL_LABEL_W + fi * colW)
      .attr("y1", HEADER_H)
      .attr("y2", HEADER_H + data.length * (ROW_H + ROW_PAD))
      .attr("stroke", "rgba(255,255,255,0.04)")
      .attr("stroke-width", 0.5);
  });

  // Línea separadora entre etiqueta y barras
  gDividers.append("line")
    .attr("x1", COL_LABEL_W - 2)
    .attr("x2", COL_LABEL_W - 2)
    .attr("y1", 0)
    .attr("y2", HEADER_H + data.length * (ROW_H + ROW_PAD))
    .attr("stroke", "rgba(255,255,255,0.06)")
    .attr("stroke-width", 1);

  // ── Linked views ──────────────────────────────────────────────────────────
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

}

// ─── Highlight coordinado ─────────────────────────────────────────────────────
function _applyHighlight(genre) {
  if (!_gRows) return;

  // Fondo de fila
  _gRows.selectAll(".sm-row-bg")
    .transition().duration(TRANSITION)
    .attr("fill",   function() {
      const g = d3.select(this.parentNode).attr("data-genre");
      return g === genre ? "rgba(29,185,84,0.08)" : "rgba(255,255,255,0.02)";
    })
    .attr("stroke", function() {
      const g = d3.select(this.parentNode).attr("data-genre");
      return g === genre ? "rgba(29,185,84,0.3)" : "transparent";
    });

  // Etiqueta de género
  _gRows.selectAll("text")
    .filter(function() { return !d3.select(this).classed("sm-bar-label"); })
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      const g = d3.select(this.parentNode).attr("data-genre");
      return g === genre ? 1 : 0.35;
    });

  // Barras
  _gRows.selectAll(".sm-bar")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", function() {
      const g = d3.select(this.parentNode).attr("data-genre");
      return g === genre ? 0.92 : 0.15;
    });

  // Llevar la fila activa al frente
  _gRows.selectAll(`.sm-row[data-genre="${CSS.escape(genre)}"]`).raise();
}

function _restoreAll() {
  if (!_gRows) return;
  _gRows.selectAll(".sm-row-bg")
    .transition().duration(TRANSITION)
    .attr("fill",   "rgba(255,255,255,0.02)")
    .attr("stroke", "transparent");

  _gRows.selectAll("text")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 1);

  _gRows.selectAll(".sm-bar")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.75);
}

// ─── Controles ────────────────────────────────────────────────────────────────
// ─── Controles ────────────────────────────────────────────────────────────────
function _updateControls(container) {
  if (!container) return;
  container.innerHTML = ""; // Limpiamos solo el interior de la barra de controles
  
  container.style.cssText = `
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 12px;
    height: ${CTRL_H}px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
  `;

  // Ordenar por
  const sortLabel = document.createElement("span");
  sortLabel.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;";
  sortLabel.textContent   = "Ordenar:";
  container.appendChild(sortLabel);

  const pillWrap = document.createElement("div");
  pillWrap.style.cssText = "display:flex;gap:4px;";

  Object.entries(SORT_MODES).forEach(([key, cfg]) => {
    const pill = document.createElement("button");
    pill.textContent  = cfg.label;
    const isActive    = key === _sortKey && !_sortFeature;
    pill.style.cssText = `
      padding: 2px 9px; border-radius: 12px; cursor: pointer; font-size: 10px;
      border: 1px solid ${isActive ? "var(--spotify-green)" : "var(--border-soft)"};
      background: ${isActive ? "var(--spotify-green-soft)" : "transparent"};
      color: ${isActive ? "var(--spotify-green)" : "var(--text-muted)"};
      transition: var(--transition); white-space: nowrap;
    `;
    pill.addEventListener("click", () => {
      _sortKey     = key;
      _sortFeature = null;
      _build();
    });
    pillWrap.appendChild(pill);
  });
  container.appendChild(pillWrap);

  // Separador
  const sep = document.createElement("div");
  sep.style.cssText = "width:1px;height:18px;background:var(--border-subtle);flex-shrink:0;";
  container.appendChild(sep);

  // Color mode toggle
  const colorLabel = document.createElement("span");
  colorLabel.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;";
  colorLabel.textContent   = "Color:";
  container.appendChild(colorLabel);

  const colorPills = document.createElement("div");
  colorPills.style.cssText = "display:flex;gap:4px;";

  Object.entries(COLOR_MODES).forEach(([key, label]) => {
    const pill = document.createElement("button");
    pill.textContent  = label;
    const isActive    = key === _colorMode;
    pill.style.cssText = `
      padding: 2px 9px; border-radius: 12px; cursor: pointer; font-size: 10px;
      border: 1px solid ${isActive ? "var(--spotify-green)" : "var(--border-soft)"};
      background: ${isActive ? "var(--spotify-green-soft)" : "transparent"};
      color: ${isActive ? "var(--spotify-green)" : "var(--text-muted)"};
      transition: var(--transition);
    `;
    pill.addEventListener("click", () => {
      _colorMode = key;
      _build();
    });
    colorPills.appendChild(pill);
  });
  container.appendChild(colorPills);

  // Hint
  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);white-space:nowrap;";
  hint.textContent   = "Clic en cabecera para ordenar · Clic en fila para filtrar";
  container.appendChild(hint);
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function _rebuild() {
  const scrollWrap = _container.querySelector("#sm-scroll-wrap");
  const oldScroll = scrollWrap ? scrollWrap.scrollTop : 0;
  
  _build();
  
  const newScrollWrap = _container.querySelector("#sm-scroll-wrap");
  if (newScrollWrap) newScrollWrap.scrollTop = oldScroll;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function _dims() {
  const r = _container.getBoundingClientRect();
  return { w: Math.max(r.width, 320), h: Math.max(r.height, 200) };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initSmallMultiples };