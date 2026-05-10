/**
 * violin.js — Violin Plot de distribución de popularidad por género v1
 *
 * Muestra la distribución de popularidad (0-100) de los top-20 géneros
 * usando estimación de densidad kernel (KDE) calculada en cliente.
 * Cada "violín" es un path SVG simétrico con forma de densidad de probabilidad.
 *
 * Features:
 *   - KDE con kernel Epanechnikov (más nítido que Gaussian para distribuciones
 *     bimodales frecuentes en datos de popularidad musical)
 *   - Ancho del violín proporcional a la densidad (escala global compartida)
 *   - Caja de cuartiles interna (Q1, mediana, Q3) superpuesta sobre el violín
 *   - Bigotes (whiskers) hasta 1.5×IQR
 *   - Punto de mediana destacado con glow verde Spotify
 *   - Orden configurable: por mediana ↑↓ / por nombre A-Z / por varianza
 *   - Highlight coordinado: genre:select → un violín se expande y destaca
 *   - Hover → tooltip con estadísticas completas (min, P25, P50, P75, max, media)
 *   - Clic → selectGenre()
 *   - Scroll horizontal si hay más violines que espacio disponible
 *   - Animación de entrada: los violines crecen desde la línea central
 *   - ResizeObserver con debounce
 *
 * Datos: popularity_distribution.json → { [genre]: number[] }
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import { genreColor, initGenreScale, fmt } from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN        = { top: 20, right: 16, bottom: 56, left: 44 };
const VIOLIN_PAD    = 0.3;    // padding entre violines (fracción del bandwidth)
const KDE_THRESHOLDS = 64;    // puntos de evaluación para la curva KDE
const TRANSITION    = 480;
const ENTER_STAGGER = 25;     // ms entre violines en la animación de entrada
const DEBOUNCE_MS   = 380;
const MIN_VIOLIN_W  = 28;     // ancho mínimo por violín en px
const MAX_VIOLIN_W  = 72;     // ancho máximo por violín en px
const BOX_WIDTH_F   = 0.18;   // fracción del ancho del violín para la caja IQR

// Órdenes disponibles
const SORT_MODES = {
  median:   { label: "Mediana ↓", fn: (a, b) => b.p50 - a.p50 },
  variance: { label: "Varianza ↓", fn: (a, b) => b.variance - a.variance },
  name:     { label: "A → Z",     fn: (a, b) => a.genre.localeCompare(b.genre) },
};

// ─── Estado del módulo ────────────────────────────────────────────────────────
let _container   = null;
let _svg         = null;
let _gViolins    = null;
let _scrollWrap  = null;
let _resizeObs   = null;
let _unsubs      = [];
let _prevW       = 0;
let _prevH       = 0;
let _activeGenre = null;
let _sortMode    = "median";

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initViolin(container) {
  if (!container) return;
  _container = container;
  _container.classList.remove("loading");

  const data = store.getData("popularityDist");
  if (!data) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "popularityDist") return;
      unsub();
      _container.classList.remove("loading");
      _build(true);
    });
    return;
  }
  _build(true);
}

// ─── Build ────────────────────────────────────────────────────────────────────
function _build(isInitial = false) {
  const raw = store.getData("popularityDist");
  if (!raw || !_container) return;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  const genres = Object.keys(raw);
  initGenreScale(genres);

  // Solo vaciar si es el primer build o si los controles no existen
  if (!_container.querySelector(".violin-controls")) {
    _container.innerHTML = "";
    _buildControls(raw);
    _scrollWrap = document.createElement("div");
    _scrollWrap.className = "violin-scroll";
    _scrollWrap.style.cssText = "width:100%; height:calc(100% - 36px); overflow-x:auto; overflow-y:hidden;";
    _container.appendChild(_scrollWrap);
  } else {
    _scrollWrap = _container.querySelector(".violin-scroll");
  }
  _container.classList.remove("loading");

  // ── Preparar estadísticas ─────────────────────────────────────────────────
  const stats = _computeStats(raw, genres);

  // ── Dimensiones ───────────────────────────────────────────────────────────
  const { w, h } = _dims();
  if (w === 0) return; // Guard para evitar cálculos si está oculto

  const availW   = w;
  const availH   = Math.max(h - 36, 150); // 36 = controles
  _prevW = availW;
  _prevH = availH;

  // Calcular ancho del violín y ancho total del SVG
  const nViolins   = genres.length;
  const violinW    = Math.min(MAX_VIOLIN_W, Math.max(MIN_VIOLIN_W, (availW - MARGIN.left - MARGIN.right) / nViolins));
  const totalW     = Math.max(availW, MARGIN.left + MARGIN.right + nViolins * violinW);
  const innerW     = totalW - MARGIN.left - MARGIN.right;
  const innerH     = availH - MARGIN.top  - MARGIN.bottom;

  // ── SVG ───────────────────────────────────────────────────────────────────
  _svg = d3.select(_scrollWrap)
    .selectAll("svg")
    .data([null])
    .join("svg")
      .attr("width",  totalW)
      .attr("height", availH);

  const gRoot = _svg
    .selectAll("g.violin-root")
    .data([null])
    .join("g")
      .attr("class", "violin-root")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // ── Escalas ───────────────────────────────────────────────────────────────
  // Eje Y: popularidad 0–100
  const yScale = d3.scaleLinear()
    .domain([0, 100])
    .range([innerH, 0]);

  // Eje X: banda por género (orden actual)
  const sortedStats = [...stats].sort(SORT_MODES[_sortMode].fn);
  const sortedGenres = sortedStats.map(s => s.genre);

  const xScale = d3.scaleBand()
    .domain(sortedGenres)
    .range([0, innerW])
    .padding(VIOLIN_PAD);

  const bandwidth = xScale.bandwidth();

  // ── KDE global: escala de anchura compartida ──────────────────────────────
  // La densidad máxima global normaliza el ancho de todos los violines
  const allKdes = stats.map(s => _kde(_epanechnikov(7), _linspace(0, 100, KDE_THRESHOLDS), s.values));
  const maxDensity = d3.max(allKdes.flat(), d => d[1]);

  const widthScale = d3.scaleLinear()
    .domain([0, maxDensity])
    .range([0, bandwidth / 2 * 0.92]);

  // ── Grid lines horizontales ───────────────────────────────────────────────
  gRoot.selectAll("g.violin-grid")
    .data([null])
    .join("g")
    .attr("class", "violin-grid")
    .selectAll("line")
    .data(yScale.ticks(5))
    .join("line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", d => yScale(d)).attr("y2", d => yScale(d))
      .attr("stroke", "rgba(255,255,255,0.05)")
      .attr("stroke-width", 0.5)
      .attr("stroke-dasharray", "3 4");

  // ── Eje Y ─────────────────────────────────────────────────────────────────
  const axisY = d3.axisLeft(yScale)
    .ticks(5)
    .tickSize(0)
    .tickPadding(8);

  gRoot.selectAll("g.violin-axis-y")
    .data([null])
    .join("g")
      .attr("class", "axis axis-y violin-axis-y")
      .call(axisY)
      .call(g => g.select(".domain").remove())
      .call(g => g.selectAll("text")
        .attr("fill", "var(--text-muted)")
        .attr("font-size", "10px"));

  // Label eje Y
  _svg.append("text")
    .attr("transform", `translate(13,${MARGIN.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--text-muted)")
    .attr("font-size", "10px")
    .text("Popularidad");

  // ── Eje X: nombres de género ───────────────────────────────────────────────
  const axisX = d3.axisBottom(xScale)
    .tickSize(0)
    .tickPadding(8);

  const gAxisX = gRoot.selectAll("g.violin-axis-x")
    .data([null])
    .join("g")
      .attr("class", "axis axis-x violin-axis-x")
      .attr("transform", `translate(0,${innerH})`)
      .call(axisX);

  gAxisX.select(".domain").remove();
  gAxisX.selectAll("text")
    .attr("fill", d => genreColor(d))
    .attr("font-size", "9px")
    .attr("transform", "rotate(-38)")
    .attr("text-anchor", "end")
    .attr("dx", "-0.4em")
    .attr("dy", "0.5em");

  // ── Grupo principal de violines ────────────────────────────────────────────
  _gViolins = gRoot.selectAll("g.violin-group")
    .data([null])
    .join("g")
    .attr("class", "violin-group");

  // ── Renderizar cada violín ────────────────────────────────────────────────
  const violinBodies = _gViolins.selectAll(".violin-body")
    .data(sortedStats, d => d.genre)
    .join("g")
      .attr("class",      "violin-body")
      .attr("data-genre", s => s.genre)
      .style("cursor",    "pointer")
      .style("opacity",   s => _activeGenre ? (s.genre === _activeGenre ? 1 : 0.12) : 1);

  violinBodies.each(function(s, i) {
    const gV     = d3.select(this);
    const kde    = allKdes[stats.indexOf(s)];
    const color  = genreColor(s.genre);
    const cx     = xScale(s.genre) + bandwidth / 2;

    // ── Path del violín (área de densidad simétrica) ─────────────────────
    const areaGen = d3.area()
      .x0(d => cx - widthScale(d[1]))
      .x1(d => cx + widthScale(d[1]))
      .y( d => yScale(d[0]))
      .curve(d3.curveCatmullRom.alpha(0.5));

    // Usamos join para el path interno
    gV.selectAll(".violin-path")
      .data([kde])
      .join("path")
        .attr("class", "violin-path")
        .attr("fill", color)
        .attr("fill-opacity", _isActive(s.genre) ? 0.38 : 0.22)
        .attr("stroke", color)
        .attr("stroke-width", _isActive(s.genre) ? 2 : 1.2)
        .attr("stroke-opacity", 0.6)
        .attr("d", d => {
          if (isInitial) return areaGen(d.map(([x]) => [x, 0]));
          return areaGen(d);
        })
        .each(function(d) {
          if (isInitial) {
            d3.select(this).transition()
              .duration(TRANSITION)
              .delay(i * ENTER_STAGGER)
              .ease(d3.easeCubicOut)
              .attr("d", areaGen(d));
          }
        });

    // Limpiar y recrear el resto (caja IQR, mediana, etc.) por simplicidad
    // pero dentro de cada grupo reciclado
    gV.selectAll(".violin-detail").remove();
    const gDetail = gV.append("g").attr("class", "violin-detail");

    // ── Caja IQR ──────────────────────────────────────────────────────────
    const boxW    = bandwidth * BOX_WIDTH_F;
    const boxX    = cx - boxW / 2;
    const boxTop  = yScale(s.p75);
    const boxBot  = yScale(s.p25);
    const boxH    = Math.max(1, boxBot - boxTop);

    gDetail.append("rect")
      .attr("class", "violin-iqr")
      .attr("x", boxX).attr("y", boxTop).attr("width", boxW).attr("height", boxH)
      .attr("fill", color).attr("fill-opacity", 0.35)
      .attr("stroke", color).attr("stroke-width", 1.5).attr("stroke-opacity", 0.9)
      .attr("rx", 2);

    // Bigotes y Mediana (simétrico a lo anterior pero simplificado)
    const iqr = s.p75 - s.p25;
    const wHi = Math.min(s.max, s.p75 + 1.5 * iqr);
    const wLo = Math.max(s.min, s.p25 - 1.5 * iqr);

    gDetail.append("line").attr("x1", cx).attr("x2", cx).attr("y1", yScale(s.p75)).attr("y2", yScale(wHi))
      .attr("stroke", color).attr("stroke-opacity", 0.5).attr("stroke-dasharray", "2 2");
    gDetail.append("line").attr("x1", cx).attr("x2", cx).attr("y1", yScale(s.p25)).attr("y2", yScale(wLo))
      .attr("stroke", color).attr("stroke-opacity", 0.5).attr("stroke-dasharray", "2 2");

    gDetail.append("line")
      .attr("x1", boxX - 1).attr("x2", boxX + boxW + 1).attr("y1", yScale(s.p50)).attr("y2", yScale(s.p50))
      .attr("stroke", "#ffffff").attr("stroke-opacity", 0.85).attr("stroke-width", 1.5);

    const medDot = gDetail.append("circle")
      .attr("cx", cx).attr("cy", yScale(s.p50)).attr("r", 3.5)
      .attr("fill", "var(--spotify-green)").attr("stroke", "var(--bg-base)").attr("stroke-width", 1.5)
      .style("filter", "drop-shadow(0 0 4px rgba(29,185,84,0.8))");

    // Interactividad
    gV
      .on("mouseenter", function(event) {
        if (_activeGenre && _activeGenre !== s.genre) return;
        d3.select(this).select(".violin-path").attr("fill-opacity", 0.38).attr("stroke-opacity", 0.9);
        medDot.attr("r", 5);
        tooltip.show(event, tooltip.html({
          title: s.genre, color,
          rows: [
            { key: "Mediana", value: fmt(s.p50, 1) },
            { key: "n tracks", value: s.values.length.toLocaleString("es") }
          ]
        }));
      })
      .on("mousemove", event => tooltip.move(event))
      .on("mouseleave", function() {
        d3.select(this).select(".violin-path")
          .attr("fill-opacity", _isActive(s.genre) ? 0.38 : 0.22)
          .attr("stroke-opacity", _isActive(s.genre) ? 0.9 : 0.6);
        medDot.attr("r", 3.5);
        tooltip.hide();
      })
      .on("click", () => {
        if (_activeGenre === s.genre) clearAllFilters();
        else selectGenre(s.genre);
      });
  });

  // ── Linked views ─────────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyHighlight(genre);
      // Scroll suave hacia el violín activo
      if (genre && _gViolins && _scrollWrap) {
        const gNode = _gViolins.select(`[data-genre="${CSS.escape(genre)}"]`).node();
        if (gNode) {
          const bbox = gNode.getBBox();
          const scrollX = MARGIN.left + bbox.x - _scrollWrap.clientWidth / 2 + bbox.width / 2;
          _scrollWrap.scrollTo({ left: Math.max(0, scrollX), behavior: "smooth" });
        }
      }
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

// ─── Highlight coordinado ─────────────────────────────────────────────────────
function _applyHighlight(genre, useTransition = true) {
  if (!_gViolins) return;
  const t = useTransition ? _gViolins.selectAll(".violin-body").transition().duration(TRANSITION) : _gViolins.selectAll(".violin-body");
  
  t.style("opacity", function() {
      return d3.select(this).attr("data-genre") === genre ? 1 : 0.12;
    });

  const activeV = _gViolins.selectAll(`.violin-body[data-genre="${CSS.escape(genre)}"]`);
  activeV.raise();

  if (useTransition) {
    activeV.select(".violin-path")
      .transition().duration(TRANSITION)
      .attr("fill-opacity", 0.42)
      .attr("stroke-width", 2);
  } else {
    activeV.select(".violin-path")
      .attr("fill-opacity", 0.42)
      .attr("stroke-width", 2);
  }
}

function _restoreAll() {
  if (!_gViolins) return;
  _gViolins.selectAll(".violin-body")
    .transition().duration(TRANSITION)
    .style("opacity", 1);
  _gViolins.selectAll(".violin-path")
    .transition().duration(TRANSITION)
    .attr("fill-opacity", 0.22)
    .attr("stroke-width", 1.2);
}

function _isActive(genre) {
  return _activeGenre === genre;
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls(raw) {
  const bar = document.createElement("div");
  bar.className  = "violin-controls";
  bar.style.cssText = `
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 14px;
    height: 36px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
    flex-shrink: 0;
  `;

  const lbl = document.createElement("span");
  lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;";
  lbl.textContent   = "Ordenar:";

  const pillWrap = document.createElement("div");
  pillWrap.style.cssText = "display:flex;gap:4px;";

  Object.entries(SORT_MODES).forEach(([key, cfg]) => {
    const pill = document.createElement("button");
    pill.textContent  = cfg.label;
    pill.dataset.key  = key;
    const isActive    = key === _sortMode;
    pill.style.cssText = `
      padding: 2px 10px;
      border-radius: 12px;
      border: 1px solid ${isActive ? "var(--spotify-green)" : "var(--border-soft)"};
      background: ${isActive ? "var(--spotify-green-soft)" : "transparent"};
      color: ${isActive ? "var(--spotify-green)" : "var(--text-muted)"};
      font-size: 10px;
      cursor: pointer;
      transition: var(--transition);
    `;
    pill.addEventListener("click", () => {
      _sortMode = key;
      pillWrap.querySelectorAll("button").forEach(b => {
        const a = b.dataset.key === key;
        b.style.background  = a ? "var(--spotify-green-soft)" : "transparent";
        b.style.color       = a ? "var(--spotify-green)"      : "var(--text-muted)";
        b.style.borderColor = a ? "var(--spotify-green)"      : "var(--border-soft)";
      });
      _build();
    });
    pillWrap.appendChild(pill);
  });

  const hint = document.createElement("span");
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);";
  hint.textContent   = "Scroll horizontal · Hover para stats · Clic para filtrar";

  bar.appendChild(lbl);
  bar.appendChild(pillWrap);
  bar.appendChild(hint);
  _container.appendChild(bar);
}

// ─── KDE y estadísticas ───────────────────────────────────────────────────────

/** Kernel Epanechnikov — mejor resolución de modas que Gaussian */
function _epanechnikov(bandwidth) {
  return x => Math.abs(x /= bandwidth) <= 1 ? 0.75 * (1 - x * x) / bandwidth : 0;
}

/** Evalúa la KDE en un array de puntos */
function _kde(kernel, thresholds, data) {
  return thresholds.map(x => [x, d3.mean(data, d => kernel(x - d))]);
}

/** n puntos equiespaciados en [lo, hi] */
function _linspace(lo, hi, n) {
  return Array.from({ length: n }, (_, i) => lo + (i / (n - 1)) * (hi - lo));
}

/** Calcula estadísticas completas para un array de valores */
function _stats(values) {
  const sorted = [...values].sort(d3.ascending);
  const n      = sorted.length;
  return {
    values,
    min:      d3.min(sorted),
    max:      d3.max(sorted),
    mean:     d3.mean(sorted),
    p25:      d3.quantile(sorted, 0.25),
    p50:      d3.quantile(sorted, 0.50),
    p75:      d3.quantile(sorted, 0.75),
    variance: d3.variance(sorted),
  };
}

/** Computa estadísticas para todos los géneros */
function _computeStats(raw, genres) {
  return genres.map(g => ({ genre: g, ..._stats(raw[g] || []) }));
}

// ─── Rebuild ──────────────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  // Aumentamos el umbral a 12px para ignorar pequeños cambios de layout (como la aparición de filtros)
  if (Math.abs(w - _prevW) < 12 && Math.abs(h - _prevH) < 12) return;
  const prev = _activeGenre;
  _build(false);
  if (prev) { _activeGenre = prev; _applyHighlight(prev, false); }
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

export default { initViolin };