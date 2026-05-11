/**
 * histogram.js — Histogramas interactivos de distribuciones de audio v1
 *
 * Muestra la distribución de frecuencia de un audio feature seleccionable
 * para el dataset completo (featuresSample) con opción de comparar dos géneros
 * superpuestos en el mismo histograma.
 *
 * Features:
 *   - Feature selector (danceability, energy, valence, acousticness,
 *     speechiness, liveness, instrumentalness, tempo, popularity)
 *   - Modo "Global" (todos los tracks) + overlay de género activo
 *   - Cuando genre:select llega del bus → superpone la distribución de ese
 *     género encima de la distribución global en color contrastante
 *   - KDE suave (kernel Epanechnikov) superpuesta sobre las barras
 *   - Stats summary debajo del gráfico: media, mediana, P25, P75, σ
 *   - Animación de entrada: barras crecen desde el eje X
 *   - Hover en barra → tooltip con rango, nº de tracks, % del total
 *   - Clic en barra → no hace nada (el histograma es de exploración)
 *   - Botones de resolución: 20 / 40 / 80 bins
 *   - ResizeObserver con debounce
 *
 * Datos: featuresSample.json (fase 1 — ya disponible al montar Features view)
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import {
  genreColor, initGenreScale,
  FEATURE_LABELS, FEATURE_COLORS, fmt,
} from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const MARGIN      = { top: 15, right: 30, bottom: 45, left: 65 };
const CTRL_H      = 34;
const STATS_H     = 42;
const TRANSITION  = 350;
const DEBOUNCE_MS = 380;

const FEATURES = [
  "danceability", "energy", "valence", "acousticness",
  "speechiness", "liveness", "instrumentalness", "popularity",
];

const BIN_OPTIONS = [20, 40, 80];

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container   = null;
let _svg         = null;
let _gBars       = null;
let _gOverlay    = null;
let _gKde        = null;
let _gKdeOverlay = null;
let _gAxis       = null;
let _resizeObs   = null;
let _obsTimer    = null;
let _unsubs      = [];
let _prevW       = 0;
let _prevH       = 0;

let _feature     = "energy";
let _nBins       = 40;
let _activeGenre = null;
let _xScale      = null;
let _yScale      = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initHistogram(container) {
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
  _prevW = w; _prevH = h;

  _unsubs.forEach(fn => fn());
  _unsubs = [];

  const genres = [...new Set(data.map(d => d.track_genre))];
  initGenreScale(genres);

  _container.innerHTML = "";
  _container.classList.remove("loading");

  // ── Controles ─────────────────────────────────────────────────────────────
  _buildControls(data);

  // ── Stats bar ─────────────────────────────────────────────────────────────
  const statsBar = document.createElement("div");
  statsBar.id = "hist-stats";
  statsBar.style.cssText = `
    display:flex;align-items:center;justify-content:center;gap:64px;padding:0 24px;
    height:${STATS_H}px;border-top:1px solid var(--border-subtle);
    font-size:13px;color:var(--text-muted);flex-shrink:0;
    position:absolute;bottom:0;left:0;right:0;background:var(--bg-panel);
    z-index:5;
  `;
  _container.appendChild(statsBar);

  // ── SVG ───────────────────────────────────────────────────────────────────
  const chartH = h - CTRL_H - STATS_H;
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = chartH - MARGIN.top - MARGIN.bottom;

  _svg = d3.select(_container)
    .append("svg")
    .style("position", "absolute")
    .style("top",  `${CTRL_H}px`)
    .style("left", "0")
    .attr("width",  w)
    .attr("height", chartH)
    .attr("viewBox", `0 0 ${w} ${chartH}`)
    .attr("preserveAspectRatio", "xMidYMid meet");

  const gRoot = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // Grupos de capas (orden de renderizado)
  _gBars       = gRoot.append("g").attr("class", "hist-bars");
  _gOverlay    = gRoot.append("g").attr("class", "hist-overlay");
  _gKde        = gRoot.append("g").attr("class", "hist-kde").style("pointer-events","none");
  _gKdeOverlay = gRoot.append("g").attr("class", "hist-kde-overlay").style("pointer-events","none");
  _gAxis       = gRoot.append("g").attr("class", "hist-axes");

  // ── Render inicial ────────────────────────────────────────────────────────
  _render(data, innerW, innerH, true);

  // ── Linked views ──────────────────────────────────────────────────────────
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _render(data, innerW, innerH, false);
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      _activeGenre = null;
      _render(data, innerW, innerH, false);
    })
  );

  // ── ResizeObserver ────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

// ─── Render principal ─────────────────────────────────────────────────────────
function _render(data, innerW, innerH, isInitial) {
  const isPopularity = _feature === "popularity";

  // Datos globales
  const allVals = data.map(d => +d[_feature]).filter(v => isFinite(v));

  // Datos del género activo
  const genreVals = _activeGenre
    ? data.filter(d => d.track_genre === _activeGenre).map(d => +d[_feature]).filter(v => isFinite(v))
    : [];

  // Dominio
  const domain = isPopularity ? [0, 100] : [0, 1];
  _xScale = d3.scaleLinear().domain(domain).range([0, innerW]).nice();
  const thresholds = _xScale.ticks(_nBins);

  // Bins globales
  const binGen = d3.bin().domain(_xScale.domain()).thresholds(thresholds);
  const bins    = binGen(allVals);

  // Bins del género
  const genreBins = genreVals.length ? binGen(genreVals) : [];

  // Escala Y agresiva para llenar el espacio
  const maxY = d3.max(bins, b => b.length);
  _yScale = d3.scaleLinear().domain([0, maxY * 1.02]).range([innerH, 0]);

  const accentColor = FEATURE_COLORS[_feature] || "#1DB954";
  const genreCol    = _activeGenre ? genreColor(_activeGenre) : null;

  // ── Barras globales ───────────────────────────────────────────────────────
  const bars = _gBars.selectAll(".hist-bar")
    .data(bins, (_, i) => i)
    .join(
      enter => enter.append("rect")
        .attr("class",       "hist-bar")
        .attr("x",           b => _xScale(b.x0) + 1)
        .attr("width",       b => Math.max(0, _xScale(b.x1) - _xScale(b.x0) - 2))
        .attr("y",           isInitial ? innerH : b => _yScale(b.length))
        .attr("height",      isInitial ? 0 : b => innerH - _yScale(b.length))
        .attr("fill",        accentColor)
        .attr("fill-opacity", _activeGenre ? 0.18 : 0.55)
        .attr("rx",          2)
        .attr("stroke",      accentColor)
        .attr("stroke-width", 0.5)
        .attr("stroke-opacity", 0.4),
      update => update,
      exit   => exit.remove()
    );

  if (isInitial) {
    bars.transition().duration(TRANSITION)
      .delay((_, i) => i * 4)
      .ease(d3.easeCubicOut)
      .attr("y",      b => _yScale(b.length))
      .attr("height", b => innerH - _yScale(b.length))
      .attr("fill",        accentColor)
      .attr("fill-opacity", _activeGenre ? 0.18 : 0.55);
  } else {
    bars.transition().duration(TRANSITION)
      .attr("x",      b => _xScale(b.x0) + 1)
      .attr("width",  b => Math.max(0, _xScale(b.x1) - _xScale(b.x0) - 2))
      .attr("y",      b => _yScale(b.length))
      .attr("height", b => innerH - _yScale(b.length))
      .attr("fill",        accentColor)
      .attr("fill-opacity", _activeGenre ? 0.18 : 0.55)
      .attr("rx",          2)
      .attr("stroke",      accentColor);
  }

  // Interactividad en barras
  bars
    .on("mouseenter", function(event, b) {
      d3.select(this).interrupt()
        .transition().duration(80)
        .attr("fill-opacity", _activeGenre ? 0.35 : 0.85)
        .attr("stroke-opacity", 1);
      const pct = ((b.length / allVals.length) * 100).toFixed(1);
      tooltip.show(event, tooltip.html({
        title: `${fmt(b.x0, 3)} – ${fmt(b.x1, 3)}`,
        color: accentColor,
        rows: [
          { key: "Tracks",     value: b.length.toLocaleString("es") },
          { key: "% del total", value: `${pct}%` },
          { key: FEATURE_LABELS[_feature] || _feature, value: fmt((b.x0 + b.x1) / 2, 3) },
        ],
        footer: _activeGenre ? `Filtro: ${_activeGenre}` : "Distribución global",
      }));
    })
    .on("mousemove",  event => tooltip.move(event))
    .on("mouseleave", function(_, b) {
      tooltip.hide();
      d3.select(this).interrupt()
        .transition().duration(150)
        .attr("fill-opacity", _activeGenre ? 0.18 : 0.55)
        .attr("stroke-opacity", 0.4);
    });

  // ── Overlay de género ─────────────────────────────────────────────────────
  if (genreBins.length) {
    const maxGenreY = d3.max(genreBins, b => b.length);
    // Escalar el overlay para que su pico sea visible (usa su propia escala relativa)
    const yGenre = d3.scaleLinear()
      .domain([0, maxGenreY * 1.08])
      .range([innerH, 0]);

    const overlayBars = _gOverlay.selectAll(".hist-overlay-bar")
      .data(genreBins, (_, i) => i)
      .join(
        enter => enter.append("rect")
          .attr("class",        "hist-overlay-bar")
          .attr("x",            b => _xScale(b.x0) + 1)
          .attr("width",        b => Math.max(0, _xScale(b.x1) - _xScale(b.x0) - 2))
          .attr("y",            isInitial ? innerH : b => yGenre(b.length))
          .attr("height",       isInitial ? 0 : b => innerH - yGenre(b.length))
          .attr("fill",         genreCol)
          .attr("fill-opacity", 0.6)
          .attr("rx",           2)
          .attr("stroke",       genreCol)
          .attr("stroke-width", 0.8),
        update => update,
        exit   => exit.remove()
      );

    overlayBars.transition().duration(TRANSITION)
      .attr("x",      b => _xScale(b.x0) + 1)
      .attr("width",  b => Math.max(0, _xScale(b.x1) - _xScale(b.x0) - 2))
      .attr("y",      b => yGenre(b.length))
      .attr("height", b => innerH - yGenre(b.length))
      .attr("fill",         genreCol)
      .attr("fill-opacity", 0.6)
      .attr("stroke",       genreCol);
  } else {
    _gOverlay.selectAll(".hist-overlay-bar")
      .transition().duration(TRANSITION)
      .attr("height", 0).attr("y", innerH)
      .remove();
  }

  // ── KDE global ────────────────────────────────────────────────────────────
  const kdePoints = _computeKde(allVals, domain, accentColor);
  const kdeLine   = d3.line()
    .x(d => _xScale(d[0]))
    .y(d => _yScale(d[1] * allVals.length * (domain[1] - domain[0]) / _nBins))
    .curve(d3.curveCatmullRom.alpha(0.5));

  _gKde.selectAll(".hist-kde-line")
    .data([kdePoints])
    .join("path")
      .attr("class",        "hist-kde-line")
      .attr("d",            kdeLine)
      .attr("fill",         "none")
      .attr("stroke",       accentColor)
      .attr("stroke-width", _activeGenre ? 1 : 2)
      .attr("stroke-opacity", _activeGenre ? 0.35 : 0.9)
      .attr("stroke-dasharray", _activeGenre ? "4 4" : "none");

  // KDE del género
  if (genreVals.length) {
    const kdeGenre = _computeKde(genreVals, domain, genreCol);
    const kdeGenreLine = d3.line()
      .x(d => _xScale(d[0]))
      .y(d => _yScale(d[1] * genreVals.length * (domain[1] - domain[0]) / _nBins))
      .curve(d3.curveCatmullRom.alpha(0.5));

    _gKdeOverlay.selectAll(".hist-kde-genre")
      .data([kdeGenre])
      .join("path")
        .attr("class",        "hist-kde-genre")
        .attr("d",            kdeGenreLine)
        .attr("fill",         "none")
        .attr("stroke",       genreCol)
        .attr("stroke-width", 2.2)
        .attr("stroke-opacity", 0.9);
  } else {
    _gKdeOverlay.selectAll(".hist-kde-genre").remove();
  }

  // ── Ejes ──────────────────────────────────────────────────────────────────
  _gAxis.selectAll("*").remove();

  _gAxis.append("g")
    .attr("class", "axis hb-axis-x")
    .attr("transform", `translate(0,${innerH})`)
    .call(d3.axisBottom(_xScale).ticks(6).tickSize(0).tickPadding(8))
    .call(g => g.select(".domain").attr("stroke", "rgba(255,255,255,0.08)"))
    .selectAll("text")
      .attr("fill", "var(--text-muted)").attr("font-size", "10px");

  _gAxis.append("g")
    .attr("class", "axis hb-axis-y")
    .call(d3.axisLeft(_yScale).ticks(5).tickSize(0).tickPadding(8))
    .call(g => g.select(".domain").remove())
    .selectAll("text")
      .attr("fill", "var(--text-muted)").attr("font-size", "10px");

  // Líneas de grid
  _gAxis.append("g").attr("class", "hist-grid")
    .style("pointer-events", "none")
    .selectAll("line")
    .data(_yScale.ticks(5))
    .join("line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", d => _yScale(d)).attr("y2", d => _yScale(d))
      .attr("stroke", "rgba(255,255,255,0.04)").attr("stroke-width", 0.8);

  // Label X
  _svg.selectAll(".hist-xlabel").remove();
  _svg.append("text").attr("class", "hist-xlabel")
    .attr("x", MARGIN.left + innerW / 2)
    .attr("y", MARGIN.top + innerH + 34)
    .attr("text-anchor", "middle")
    .attr("fill", accentColor)
    .attr("font-size", "11px").attr("font-weight", "600")
    .text(FEATURE_LABELS[_feature] || _feature);

  // Label Y
  _svg.selectAll(".hist-ylabel").remove();
  _svg.append("text").attr("class", "hist-ylabel")
    .attr("transform", `translate(18, ${MARGIN.top + innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill", "var(--text-muted)").attr("font-size", "10px")
    .text("Frecuencia (nº tracks)");

  // Línea de media global
  const mean = d3.mean(allVals);
  _gAxis.append("line")
    .attr("x1", _xScale(mean)).attr("x2", _xScale(mean))
    .attr("y1", 0).attr("y2", innerH)
    .attr("stroke", accentColor).attr("stroke-opacity", 0.5)
    .attr("stroke-dasharray", "5 4").attr("stroke-width", 1.5);

  _gAxis.append("text")
    .attr("x", _xScale(mean) + 5).attr("y", -10) // Mover arriba del gráfico
    .attr("font-size", "10px").attr("font-weight", "600")
    .attr("fill", accentColor).attr("fill-opacity", 0.9)
    .text(`Media Global: ${fmt(mean, 3)}`);

  // Label de ayuda en el espacio superior
  _gAxis.append("text")
    .attr("x", innerW).attr("y", -10)
    .attr("text-anchor", "end")
    .attr("font-size", "10px")
    .attr("fill", "var(--text-hint)")

  // ── Stats summary ─────────────────────────────────────────────────────────
  _updateStats(allVals, genreVals, accentColor, genreCol);
}

// ─── KDE ─────────────────────────────────────────────────────────────────────
function _computeKde(values, domain, color) {
  const bandwidth = (domain[1] - domain[0]) / (_nBins * 0.8);
  const kernel    = v => Math.abs(v /= bandwidth) <= 1 ? 0.75 * (1 - v * v) / bandwidth : 0;
  const ticks     = d3.range(domain[0], domain[1] + bandwidth, bandwidth / 4);
  return ticks.map(x => [x, d3.mean(values, v => kernel(x - v))]);
}

// ─── Stats bar ────────────────────────────────────────────────────────────────
function _updateStats(allVals, genreVals, accentColor, genreCol) {
  const statsBar = document.getElementById("hist-stats");
  if (!statsBar) return;
  statsBar.innerHTML = "";

  const datasets = [
    { label: "Global", vals: allVals, color: accentColor },
    ...(genreVals.length ? [{ label: _activeGenre, vals: genreVals, color: genreCol }] : []),
  ];

  datasets.forEach(({ label, vals, color }) => {
    const sorted = [...vals].sort(d3.ascending);
    const stats  = {
      n:      vals.length,
      mean:   d3.mean(vals),
      median: d3.quantile(sorted, 0.5),
      p25:    d3.quantile(sorted, 0.25),
      p75:    d3.quantile(sorted, 0.75),
      sd:     d3.deviation(vals),
    };

    const block = document.createElement("div");
    block.style.cssText = "display:flex;align-items:center;gap:32px;";

    const tag = document.createElement("span");
    tag.style.cssText = `
      font-size:11px;font-weight:800;color:${color};
      border:1px solid ${color};border-radius:12px;
      padding:2px 12px;white-space:nowrap;text-transform:uppercase;
    `;
    tag.textContent = label;
    block.appendChild(tag);

    const items = [
      { key: "n",      val: stats.n.toLocaleString("es") },
      { key: "μ",      val: fmt(stats.mean, 3) },
      { key: "P50 (Mediana)", val: fmt(stats.median, 3) },
      { key: "Rango Intercuartil (P25–P75)", val: `${fmt(stats.p25, 2)} – ${fmt(stats.p75, 2)}` },
      { key: "σ (Desviación)", val: fmt(stats.sd, 3) },
    ];

    items.forEach(({ key, val }) => {
      const item = document.createElement("span");
      item.style.cssText = "white-space:nowrap;display:flex;flex-direction:column;line-height:1.2;";
      item.innerHTML = `
        <span style="color:var(--text-hint);font-size:10px;text-transform:uppercase;letter-spacing:0.5px;">${key}</span>
        <span style="color:var(--text-primary);font-weight:600;font-size:14px;">${val}</span>
      `;
      block.appendChild(item);
    });

    // Separador
    if (datasets.indexOf(datasets.find(d => d.label === label)) < datasets.length - 1) {
      const sep = document.createElement("div");
      sep.style.cssText = "width:1px;height:20px;background:var(--border-subtle);flex-shrink:0;";
      block.appendChild(sep);
    }

    statsBar.appendChild(block);
  });
}

// ─── Controles ────────────────────────────────────────────────────────────────
function _buildControls(data) {
  const bar = document.createElement("div");
  bar.style.cssText = `
    box-sizing:border-box;display:flex;align-items:center;gap:10px;
    padding:4px 12px;height:${CTRL_H}px;
    border-bottom:1px solid var(--border-subtle);
    font-size:11px;color:var(--text-muted);
  `;

  // Feature select
  const wrap = document.createElement("div");
  wrap.style.cssText = "display:flex;align-items:center;gap:5px;";

  const lbl = document.createElement("span");
  lbl.textContent   = "Feature:";
  lbl.style.cssText = "font-size:10px;text-transform:uppercase;letter-spacing:0.5px;white-space:nowrap;";

  const sel = document.createElement("select");
  sel.style.cssText = `
    background:var(--bg-elevated);border:1px solid var(--border-soft);
    border-radius:6px;color:var(--text-primary);font-size:11px;
    padding:2px 8px;cursor:pointer;outline:none;
  `;
  FEATURES.forEach(f => {
    const opt = document.createElement("option");
    opt.value = f; opt.text = FEATURE_LABELS[f] || f;
    if (f === _feature) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener("change", e => {
    _feature = e.target.value;
    _updatePanelTitle();
    const { w, h } = _dims();
    const innerW = w - MARGIN.left - MARGIN.right;
    const innerH = h - CTRL_H - STATS_H - MARGIN.top - MARGIN.bottom;
    _render(data, innerW, innerH, false);
  });

  wrap.appendChild(lbl);
  wrap.appendChild(sel);
  bar.appendChild(wrap);

  // Separador
  const sep = document.createElement("div");
  sep.style.cssText = "width:1px;height:18px;background:var(--border-subtle);flex-shrink:0;";
  bar.appendChild(sep);

  // Bins pills
  const binsLabel = document.createElement("span");
  binsLabel.textContent   = "Bins:";
  binsLabel.style.cssText = "font-size:10px;white-space:nowrap;";
  bar.appendChild(binsLabel);

  const pillWrap = document.createElement("div");
  pillWrap.style.cssText = "display:flex;gap:4px;";
  BIN_OPTIONS.forEach(n => {
    const pill = document.createElement("button");
    pill.textContent  = n;
    pill.dataset.bins = n;
    const active      = n === _nBins;
    pill.style.cssText = `
      padding:2px 9px;border-radius:12px;cursor:pointer;font-size:10px;
      border:1px solid ${active ? "var(--spotify-green)" : "var(--border-soft)"};
      background:${active ? "var(--spotify-green-soft)" : "transparent"};
      color:${active ? "var(--spotify-green)" : "var(--text-muted)"};
      transition:var(--transition);
    `;
    pill.addEventListener("click", () => {
      _nBins = n;
      pillWrap.querySelectorAll("button").forEach(b => {
        const a = +b.dataset.bins === n;
        b.style.background  = a ? "var(--spotify-green-soft)" : "transparent";
        b.style.color       = a ? "var(--spotify-green)"      : "var(--text-muted)";
        b.style.borderColor = a ? "var(--spotify-green)"      : "var(--border-soft)";
      });
      const { w, h } = _dims();
      const innerW = w - MARGIN.left - MARGIN.right;
      const innerH = h - CTRL_H - STATS_H - MARGIN.top - MARGIN.bottom;
      _render(data, innerW, innerH, false);
    });
    pillWrap.appendChild(pill);
  });
  bar.appendChild(pillWrap);

  // Hint + info de género activo
  const hint = document.createElement("span");
  hint.id            = "hist-genre-hint";
  hint.style.cssText = "margin-left:auto;font-size:10px;color:var(--text-hint);white-space:nowrap;";
  hint.textContent   = "Selecciona un género en otro gráfico para superponerlo";
  bar.appendChild(hint);

  _container.appendChild(bar);

  // Actualizar hint cuando cambia el género
  _unsubs.push(
    on("genre:select", ({ genre }) => {
      const color = genreColor(genre);
      hint.innerHTML = `<span style="color:${color};font-weight:600;">${genre}</span> <span style="color:var(--text-hint);">superpuesto</span>`;
    })
  );
  _unsubs.push(
    on("filters:clear", () => {
      hint.textContent = "Selecciona un género en otro gráfico para superponerlo";
    })
  );
}

// ─── Rebuild en resize ────────────────────────────────────────────────────────
function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || h === 0) return;
  if (Math.abs(w - _prevW) < 8 && Math.abs(h - _prevH) < 8) return;
  const prevGenre = _activeGenre;
  _build();
  if (prevGenre) _activeGenre = prevGenre;
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
  if (h2) h2.textContent = `Distribución · ${FEATURE_LABELS[_feature] || _feature}`;
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

export default { initHistogram };