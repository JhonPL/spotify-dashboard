/**
 * heatmap.js v5
 *
 * Modo normal:     Top 20 géneros, sin scroll, todo visible y legible
 * Modo fullscreen: Todos los géneros con scroll, CELL_H mayor, etiquetas claras
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import tooltip from "../utils/tooltip.js";
import { FEATURE_LABELS } from "../utils/scales.js";

// ─── Constantes ───────────────────────────────────────────────────────────────
const MARGIN      = { left: 85, right: 20, top: 0, bottom: 44 };
const HEADER_H    = 44;
const SCROLL_W    = 6;
const TRANSITION  = 200;

// Modos
const MODE = {
  normal: { maxGenres: 20, cellH: null, scroll: false }, // cellH calculado dinámicamente
  full:   { maxGenres: Infinity, cellH: 26, scroll: true },
};

const COLOR = d3.scaleSequential()
  .domain([0, 1])
  .interpolator(d3.interpolate("#0d1a12", "#1DB954"));

const FEAT_LABEL = {
  danceability:     "Dance",
  energy:           "Energy",
  valence:          "Valence",
  acousticness:     "Acoustic",
  speechiness:      "Speech",
  instrumentalness: "Instrum.",
  liveness:         "Liveness",
  tempo_norm:       "Tempo",
};

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container = null;
let _panel     = null;
let _svg       = null;
let _bodyG     = null;
let _yFixedG   = null;
let _data      = null;      // datos completos normalizados
let _selected  = null;
let _unsubs    = [];
let _resizeObs = null;
let _prevW     = 0;
let _prevH     = 0;
let _isFS      = false;

// Scroll state
let _scrollY   = 0;
let _maxScroll = 0;
let _viewH     = 0;
let _totalH    = 0;
let _applyScrollFn = null;

// ─── Init ─────────────────────────────────────────────────────────────────────
export function initHeatmap(container) {
  if (!container) return;
  _container = container;
  _panel     = container.closest(".panel");

  const raw = store.getData("genreFeatureMatrix");
  if (!raw) {
    _container.classList.add("loading");
    const unsub = on("data:ready", ({ key }) => {
      if (key !== "genreFeatureMatrix") return;
      unsub();
      _container.classList.remove("loading");
      _prepare(store.getData("genreFeatureMatrix"));
      _build();
    });
    return;
  }
  _prepare(raw);
  _build();
}

// ─── Preparar: normalizar columnas ───────────────────────────────────────────
function _prepare(raw) {
  const { genres, features, values } = raw;
  const normalized = values.map(row => [...row]);
  features.forEach((_, j) => {
    const col = values.map(row => row[j]);
    const lo  = d3.min(col);
    const hi  = d3.max(col);
    const rng = hi - lo || 1;
    normalized.forEach((row, i) => { row[j] = (values[i][j] - lo) / rng; });
  });
  _data = { genres, features, values, normalized };
}

// ─── Build ────────────────────────────────────────────────────────────────────
function _build() {
  if (!_data || !_container) return;

  const prevScroll = _scrollY;

  const W = _container.clientWidth;
  const H = _container.clientHeight;
  if (W === 0 || H === 0) return; // Prevent building when hidden
  _prevW = W; _prevH = H;

  _unsubs.forEach(fn => fn());
  _unsubs = [];
  _container.innerHTML = "";
  _container.classList.remove("loading");
  _scrollY = prevScroll;
  _applyScrollFn = null;

  const mode       = _isFS ? MODE.full : MODE.normal;
  const { genres: allGenres, features, values: allValues, normalized: allNorm } = _data;

  // ── Seleccionar géneros según modo ────────────────────────────────────────
  let genres, values, normalized;
  if (_isFS) {
    genres     = allGenres;
    values     = allValues;
    normalized = allNorm;
  } else {
    // Top 10: usar meta.top20_genres si existe, si no los primeros 10
    const meta   = store.getData("meta");
    const top10  = (meta?.top20_genres ?? allGenres).slice(0, 10);
    const valid  = top10.filter(g => allGenres.includes(g));
    genres     = valid;
    values     = valid.map(g => allValues[allGenres.indexOf(g)]);
    normalized = valid.map(g => allNorm[allGenres.indexOf(g)]);
  }

  const innerW = W - MARGIN.left - MARGIN.right - (_isFS ? SCROLL_W + 4 : 2);

  // ── Altura de celda ───────────────────────────────────────────────────────
  let cellH, cellPad;
  if (_isFS) {
    cellH   = MODE.full.cellH;
    cellPad = 3;
  } else {
    // Calcular dinámicamente para llenar el panel
    const availH = H - HEADER_H - MARGIN.top - MARGIN.bottom;
    cellPad      = genres.length > 15 ? 2 : 3;
    cellH        = Math.max(14, Math.floor((availH - cellPad * genres.length) / genres.length));
  }

  _viewH    = _isFS ? H - HEADER_H - MARGIN.bottom : H - HEADER_H - MARGIN.top - MARGIN.bottom;
  _totalH   = genres.length * (cellH + cellPad);
  _maxScroll = Math.max(0, _totalH - _viewH);

  // ── SVG ──────────────────────────────────────────────────────────────────
  _svg = d3.select(_container)
    .append("svg")
    .attr("width",  W)
    .attr("height", H)
    .style("display", "block");

  // ── ClipPath área de celdas ───────────────────────────────────────────────
  const uid    = Math.random().toString(36).slice(2, 6);
  const clipId = `hm-clip-${uid}`;
  const yClipId = `hm-yclip-${uid}`;

  const defsEl = _svg.append("defs");
  defsEl.append("clipPath").attr("id", clipId)
    .append("rect")
      .attr("x", MARGIN.left).attr("y", HEADER_H)
      .attr("width", innerW + 2).attr("height", _viewH);

  defsEl.append("clipPath").attr("id", yClipId)
    .append("rect")
      .attr("x", 0).attr("y", HEADER_H)
      .attr("width", MARGIN.left).attr("height", _viewH);

  // ── Escalas ───────────────────────────────────────────────────────────────
  const xScale = d3.scaleBand()
    .domain(features)
    .range([0, innerW])
    .padding(0.06);

  const yPos = (i) => HEADER_H + MARGIN.top + i * (cellH + cellPad);

  // ── HEADER fijo: eje X ────────────────────────────────────────────────────
  const headerG = _svg.append("g")
    .attr("transform", `translate(${MARGIN.left}, 0)`);

  headerG.append("rect")
    .attr("x", -MARGIN.left).attr("y", 0)
    .attr("width", W).attr("height", HEADER_H)
    .attr("fill", "var(--bg-panel)");

  headerG.append("g")
    .attr("transform", `translate(0, ${HEADER_H})`)
    .call(d3.axisTop(xScale).tickSize(0).tickFormat(f => FEAT_LABEL[f] ?? f))
    .call(ax => ax.select(".domain").remove())
    .selectAll("text")
      .attr("fill",        "var(--text-secondary)")
      .attr("font-size",   "10.5px")
      .attr("font-weight", "500")
      .attr("text-anchor", "start")
      .attr("transform",   "rotate(-38)")
      .attr("dx", "0.2em").attr("dy", "0.2em");

  // Separador header
  _svg.append("line")
    .attr("x1", 0).attr("x2", W)
    .attr("y1", HEADER_H).attr("y2", HEADER_H)
    .attr("stroke", "rgba(255,255,255,0.07)").attr("stroke-width", 1);

  // ── BODY con clipPath ─────────────────────────────────────────────────────
  const clipG = _svg.append("g").attr("clip-path", `url(#${clipId})`);
  _bodyG = clipG.append("g")
    .attr("transform", `translate(${MARGIN.left}, 0)`);

  // Datos planos
  const cells = [];
  genres.forEach((genre, i) => {
    features.forEach((feat, j) => {
      cells.push({ genre, feat, raw: values[i][j], norm: normalized[i][j], i, j });
    });
  });

  // Celdas
  _bodyG.selectAll("rect.hm-cell")
    .data(cells, d => `${d.genre}|${d.feat}`)
    .join("rect")
      .attr("class",        "hm-cell")
      .attr("data-genre",   d => d.genre)
      .attr("x",            d => xScale(d.feat))
      .attr("y",            d => yPos(d.i))
      .attr("width",        xScale.bandwidth())
      .attr("height",       cellH)
      .attr("rx",           3)
      .attr("fill",         d => COLOR(d.norm))
      .attr("fill-opacity", 1)
      .style("cursor",      "pointer")
      .on("mouseenter", (event, d) => {
        _bodyG.selectAll("rect.hm-cell")
          .filter(c => c.genre === d.genre)
          .attr("stroke", "rgba(255,255,255,0.4)").attr("stroke-width", 1.2);
        tooltip.show(event, tooltip.html({
          title: d.genre,
          color: COLOR(d.norm),
          rows: [
            { key: FEATURE_LABELS[d.feat] ?? d.feat, value: d.raw.toFixed(3), color: COLOR(d.norm) },
            { key: "Relativo al máximo", value: `${(d.norm * 100).toFixed(0)}%` },
          ],
          footer: "Clic para filtrar todos los gráficos",
        }));
      })
      .on("mousemove",  e => tooltip.move(e))
      .on("mouseleave", (_, d) => {
        _bodyG.selectAll("rect.hm-cell")
          .filter(c => c.genre === d.genre)
          .attr("stroke", "none");
        tooltip.hide();
      })
      .on("click", (_, d) => _toggleGenre(d.genre));

  // ── Eje Y etiquetas — fijas (fuera del clip de celdas) ───────────────────
  // Fondo que tapa las celdas al hacer scroll
  _svg.append("rect")
    .attr("x", 0).attr("y", HEADER_H)
    .attr("width", MARGIN.left - 2).attr("height", _viewH)
    .attr("fill", "var(--bg-panel)");

  const yClipG = _svg.append("g").attr("clip-path", `url(#${yClipId})`);
  _yFixedG = yClipG.append("g");

  // Etiquetas de género
  const fontSize = _isFS ? "11px" : (cellH >= 18 ? "10.5px" : cellH >= 14 ? "9.5px" : "8.5px");

  _yFixedG.selectAll("text.hm-ylabel")
    .data(genres)
    .join("text")
      .attr("class",             "hm-ylabel")
      .attr("data-genre",        d => d)
      .attr("x",                 MARGIN.left - 8)
      .attr("y",                 (_, i) => yPos(i) + cellH / 2)
      .attr("text-anchor",       "end")
      .attr("dominant-baseline", "central")
      .attr("fill",              "var(--text-secondary)")
      .attr("font-size",         fontSize)
      .style("cursor",           "pointer")
      .text(d => {
        // En modo normal truncar si no cabe
        if (!_isFS && d.length > 16) return d.slice(0, 15) + "…";
        return d;
      })
      .on("click", (_, genre) => _toggleGenre(genre));

  // ── Contador ──────────────────────────────────────────────────────────────
  _svg.append("text")
    .attr("x", MARGIN.left - 8).attr("y", 16)
    .attr("fill", "var(--text-hint)").attr("font-size", "9px").attr("text-anchor", "end")
    .text(_isFS ? `${genres.length} géneros  ↕ scroll` : `Top ${genres.length}`);

  // ── SCROLL (solo en fullscreen) ───────────────────────────────────────────
  if (_isFS && _maxScroll > 0) {
    _buildScrollbar(W, cellH, cellPad);
  }

  // ── WHEEL en modo fullscreen ──────────────────────────────────────────────
  if (_isFS) {
    _svg.on("wheel.hm", (event) => {
      event.preventDefault();
      if (!_applyScrollFn) return;
      let dy = event.deltaY;
      if (event.deltaMode === 1) dy *= 20; // Líneas
      if (event.deltaMode === 2) dy *= 800; // Páginas
      _applyScrollFn(_scrollY + dy);
    }, { passive: false });
  }

  // ── LEYENDA ───────────────────────────────────────────────────────────────
  _buildLegend(W, H, innerW);

  // ── BOTÓN FULLSCREEN ──────────────────────────────────────────────────────
  _buildFsButton();

  // ── LISTENERS ────────────────────────────────────────────────────────────
  if (_scrollY > 0 && _applyScrollFn) {
    _applyScrollFn(_scrollY);
  }

  _unsubs.push(
    on("genre:select", ({ genre }) => {
      if (genre === _selected) return;
      _selected = genre;
      _applyFocus(genre, genres, yPos);
    })
  );
  _unsubs.push(
    on("filters:clear", () => { _selected = null; _restoreAll(); })
  );

  if (_selected) _applyFocus(_selected, genres, yPos, true);

  // ── RESIZE ────────────────────────────────────────────────────────────────
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(() => {
    if (!_container || _container.clientWidth === 0) return; // Prevent building when hidden
    const nW = _container.clientWidth;
    const nH = _container.clientHeight;
    if (Math.abs(nW - _prevW) < 4 && Math.abs(nH - _prevH) < 4) return;
    const prev = _selected;
    _build();
    if (prev) _selected = prev;
  }, 350));
  _resizeObs.observe(_container);
}

// ─── Scrollbar custom (solo fullscreen) ──────────────────────────────────────
function _buildScrollbar(W, cellH, cellPad) {
  const sbX    = W - SCROLL_W - 2;
  const sbY    = HEADER_H;
  const sbH    = _viewH;
  const thumbH = Math.max(24, (sbH / _totalH) * sbH);

  _svg.append("rect")
    .attr("x", sbX).attr("y", sbY)
    .attr("width", SCROLL_W).attr("height", sbH).attr("rx", SCROLL_W / 2)
    .attr("fill", "rgba(255,255,255,0.05)");

  const thumb = _svg.append("rect")
    .attr("x", sbX).attr("y", sbY)
    .attr("width", SCROLL_W).attr("height", thumbH).attr("rx", SCROLL_W / 2)
    .attr("fill", "rgba(255,255,255,0.2)")
    .style("cursor", "pointer");

  _applyScrollFn = (newY) => {
    _scrollY = Math.max(0, Math.min(_maxScroll, newY));
    const thumbY    = sbY + (_maxScroll > 0 ? (_scrollY / _maxScroll) * (sbH - thumbH) : 0);
    const translateY = -_scrollY;

    _bodyG.attr("transform", `translate(${MARGIN.left}, ${translateY})`);
    _yFixedG.attr("transform", `translate(0, ${translateY})`);
    thumb.attr("y", thumbY);
  };

  let _drag0 = null;
  thumb.call(
    d3.drag()
      .on("start", e => { 
        const clientY = e.sourceEvent.touches ? e.sourceEvent.touches[0].clientY : e.sourceEvent.clientY;
        _drag0 = { y: clientY, s: _scrollY }; 
      })
      .on("drag",  e => {
        if (!_drag0) return;
        const clientY = e.sourceEvent.touches ? e.sourceEvent.touches[0].clientY : e.sourceEvent.clientY;
        const ratio = (clientY - _drag0.y) / (sbH - thumbH);
        _applyScrollFn(_drag0.s + ratio * _maxScroll);
      })
      .on("end", () => { _drag0 = null; })
  );

  // Clic en el track
  _svg.append("rect")
    .attr("x", sbX).attr("y", sbY)
    .attr("width", SCROLL_W).attr("height", sbH)
    .attr("fill", "transparent").style("cursor", "pointer")
    .on("click", (event) => {
      const yClick = d3.pointer(event, _svg.node())[1];
      const ratio = (yClick - sbY) / sbH;
      _applyScrollFn(ratio * _maxScroll);
    })
    .lower();
}

// ─── Leyenda gradiente ────────────────────────────────────────────────────────
function _buildLegend(W, H, innerW) {
  const lgY = H - MARGIN.bottom + 12;
  const lgW = Math.min(160, innerW * 0.5);
  const lgH = 7;
  const lgX = MARGIN.left + (innerW - lgW) / 2;

  _svg.append("line")
    .attr("x1", 0).attr("x2", W)
    .attr("y1", lgY - 10).attr("y2", lgY - 10)
    .attr("stroke", "rgba(255,255,255,0.06)").attr("stroke-width", 1);

  const uid  = Math.random().toString(36).slice(2, 6);
  const gid  = `hm-lg-${uid}`;
  const defs = _svg.select("defs");
  const grad = defs.append("linearGradient").attr("id", gid).attr("x1","0%").attr("x2","100%");
  grad.append("stop").attr("offset","0%")  .attr("stop-color", COLOR(0));
  grad.append("stop").attr("offset","50%") .attr("stop-color", COLOR(0.5));
  grad.append("stop").attr("offset","100%").attr("stop-color", COLOR(1));

  const lgG = _svg.append("g").attr("transform", `translate(${lgX}, ${lgY})`);
  lgG.append("rect").attr("width", lgW).attr("height", lgH).attr("rx", 3).attr("fill", `url(#${gid})`);

  [["Bajo", 0, "start"], ["Alto", lgW, "end"]]
    .forEach(([t, x, a]) => {
      lgG.append("text").attr("x", x).attr("y", lgH + 11)
        .attr("fill", "var(--text-hint)")
        .attr("font-size", "9px")
        .attr("text-anchor", a).text(t);
    });

  lgG.append("text").attr("x", lgW/2).attr("y", lgH + 22)
    .attr("fill", "var(--text-muted)")
    .attr("font-size", "9.5px")
    .attr("text-anchor", "middle").text("Intensidad relativa por feature");
}

// ─── Focus / restore ─────────────────────────────────────────────────────────
function _applyFocus(genre, genres, yPos, instant = false) {
  if (!_bodyG) return;
  const dur = instant ? 0 : TRANSITION;

  _bodyG.selectAll("rect.hm-cell")
    .transition().duration(dur)
    .attr("fill-opacity", d => d.genre === genre ? 1 : 0.1);

  [_bodyG.selectAll("text.hm-ylabel"), _yFixedG?.selectAll("text.hm-ylabel")]
    .forEach(sel => {
      if (!sel) return;
      sel.transition().duration(dur)
        .attr("fill",        d => d === genre ? "var(--spotify-green)" : "rgba(255,255,255,0.18)")
        .attr("font-weight", d => d === genre ? "600" : "400");
    });

  // Auto-scroll al género en modo fullscreen
  if (_isFS && _applyScrollFn && genres) {
    const idx = genres.indexOf(genre);
    if (idx >= 0) {
      const targetY  = yPos(idx);
      const centeredY = targetY - HEADER_H - _viewH / 2;
      _applyScrollFn(centeredY);
    }
  }
}

function _restoreAll() {
  if (!_bodyG) return;
  _bodyG.selectAll("rect.hm-cell")
    .transition().duration(TRANSITION).attr("fill-opacity", 1);
  [_bodyG.selectAll("text.hm-ylabel"), _yFixedG?.selectAll("text.hm-ylabel")]
    .forEach(sel => {
      if (!sel) return;
      sel.transition().duration(TRANSITION)
        .attr("fill", "var(--text-secondary)").attr("font-weight", "400");
    });
}

// ─── Toggle ──────────────────────────────────────────────────────────────────
function _toggleGenre(genre) {
  if (_selected === genre) { _selected = null; clearAllFilters(); }
  else                     { _selected = genre; selectGenre(genre); }
}

// ─── Fullscreen ───────────────────────────────────────────────────────────────
function _buildFsButton() {
  const header = _panel ? _panel.querySelector(".panel__header") : null;
  const targetContainer = header || _container;

  if (!header) _container.style.position = "relative";

  const old = targetContainer.querySelector(".hm-fs-btn");
  if (old) old.remove();

  const btn = document.createElement("button");
  btn.className = "hm-fs-btn";
  btn.innerHTML = _isFS ? _iconCollapse() : _iconExpand();
  btn.title     = _isFS ? "Salir de pantalla completa" : "Ver todos los géneros (pantalla completa)";
  
  if (header) {
    btn.style.cssText = `
      margin-left: auto; background: transparent; border: none; cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      color: var(--text-secondary); transition: color 0.15s; padding: 4px; z-index: 10;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.color = "#fff"; });
    btn.addEventListener("mouseleave", () => { btn.style.color = "var(--text-secondary)"; });
  } else {
    btn.style.cssText = `
      position:absolute;top:6px;right:10px;z-index:20;
      background:rgba(20,20,20,0.85);border:1px solid rgba(255,255,255,0.12);
      border-radius:6px;width:26px;height:26px;cursor:pointer;
      display:flex;align-items:center;justify-content:center;
      color:var(--text-secondary);transition:all 0.15s;padding:0;
    `;
    btn.addEventListener("mouseenter", () => { btn.style.background="rgba(50,50,50,0.95)"; btn.style.color="#fff"; });
    btn.addEventListener("mouseleave", () => { btn.style.background="rgba(20,20,20,0.85)"; btn.style.color="var(--text-secondary)"; });
  }

  btn.addEventListener("click", _toggleFullscreen);
  targetContainer.appendChild(btn);

  document.removeEventListener("fullscreenchange", _onFsChange);
  document.addEventListener("fullscreenchange", _onFsChange);
  _unsubs.push(() => {
    document.removeEventListener("fullscreenchange", _onFsChange);
    btn.remove();
  });
}

function _toggleFullscreen() {
  const target = _panel || _container;
  if (!document.fullscreenElement) {
    target.requestFullscreen?.().catch(e => console.warn(e));
  } else {
    document.exitFullscreen?.();
  }
}

function _onFsChange() {
  _isFS = !!document.fullscreenElement;
  if (_panel) _panel.style.overflow = _isFS ? "hidden" : "";
  setTimeout(() => { if (_container) _build(); }, 80);
}

function _iconExpand() {
  return `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <path d="M1 4.5V1h3.5M8.5 1H12v3.5M12 8.5V12H8.5M4.5 12H1V8.5"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}
function _iconCollapse() {
  return `<svg width="13" height="13" viewBox="0 0 13 13" fill="none">
    <path d="M4.5 1v3.5H1M12 4.5H8.5V1M8.5 12V8.5H12M1 8.5h3.5V12"
    stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initHeatmap };