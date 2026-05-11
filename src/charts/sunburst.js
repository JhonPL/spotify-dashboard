/**
 * sunburst.js — Gráfico de jerarquía musical v1
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { selectGenre, clearAllFilters } from "../core/filters.js";
import { genreColor, initGenreScale } from "../utils/scales.js";
import tooltip from "../utils/tooltip.js";

// ─── Constantes ──────────────────────────────────────────────────────────────
const TRANSITION = 750;
const DEBOUNCE_MS = 380;

// Mapeo simple para crear jerarquía
const CATEGORIES = {
  "metal": ["black-metal", "death-metal", "heavy-metal", "metalcore", "power-metal", "alt-rock"],
  "rock": ["rock", "hard-rock", "psych-rock", "punk-rock", "rock-n-roll", "grunge"],
  "electronic": ["house", "techno", "trance", "dubstep", "edm", "club", "breakbeat", "chicago-house"],
  "latin": ["reggaeton", "salsa", "tango", "samba", "forro", "mpb", "latin"],
  "pop": ["pop", "k-pop", "j-pop", "dance", "disney", "indie-pop"],
  "chill": ["ambient", "sleep", "study", "new-age", "acoustic", "lo-fi"]
};

// ─── Estado ───────────────────────────────────────────────────────────────────
let _container = null;
let _svg       = null;
let _resizeObs = null;
let _unsubs    = [];
let _activeGenre = null;

export function initSunburst(container) {
  if (!container) return;
  _container = container;
  
  const data = store.getData("genresSummary");
  if (!data) {
    on("data:ready", ({ key }) => { if (key === "genresSummary") _init(); });
    return;
  }
  _init();
}

function _init() {
  _build();

  // ResizeObserver (solo una vez fuera de _build)
  if (_resizeObs) _resizeObs.disconnect();
  _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
  _resizeObs.observe(_container);
}

function _build() {
  const raw = store.getData("genresSummary");
  if (!raw || !_container) return;

  _container.innerHTML = "";
  const { w, h } = _dims();
  _prevW = w; _prevH = h;
  const radius = Math.min(w, h) / 2;

  // ── Preparar Datos Jerárquicos ───────────────────────────────────────────
  const hierarchyData = _prepareHierarchy(raw);
  const root = d3.hierarchy(hierarchyData)
    .sum(d => d.value)
    .sort((a, b) => b.value - a.value);

  const partition = d3.partition().size([2 * Math.PI, radius]);
  partition(root);

  // ── Render ───────────────────────────────────────────────────────────────
  _svg = d3.select(_container).append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .attr("viewBox", `0 0 ${w} ${h}`)
    .append("g")
    .attr("transform", `translate(${w / 2},${h / 2})`);

  const arc = d3.arc()
    .startAngle(d => d.x0)
    .endAngle(d => d.x1)
    .padAngle(d => Math.min((d.x1 - d.x0) / 2, 0.005))
    .padRadius(radius / 2)
    .innerRadius(d => d.y0)
    .outerRadius(d => d.y1 - 1);

  const paths = _svg.selectAll("path")
    .data(root.descendants().filter(d => d.depth))
    .join("path")
    .attr("display", d => d.depth ? null : "none")
    .attr("d", arc)
    .attr("fill", d => genreColor(d.data.name))
    .attr("fill-opacity", 0.8)
    .style("cursor", "pointer")
    .on("mouseenter", (event, d) => {
      tooltip.show(event, tooltip.html({
        title: d.data.name,
        color: genreColor(d.data.name),
        rows: [{ key: "Peso", value: d.value }]
      }));
    })
    .on("mouseleave", () => tooltip.hide())
    .on("click", (event, d) => {
      if (d.data.name) selectGenre(d.data.name);
    });

  // Etiquetas (solo para rebanadas suficientemente grandes)
  _svg.selectAll(".sb-label")
    .data(root.descendants().filter(d => d.depth && (d.y1 - d.y0) * (d.x1 - d.x0) > 0.03))
    .join("text")
    .attr("class", "sb-label")
    .attr("transform", d => {
      const x = (d.x0 + d.x1) / 2 * 180 / Math.PI;
      const y = (d.y0 + d.y1) / 2;
      return `rotate(${x - 90}) translate(${y},0) rotate(${x < 180 ? 0 : 180})`;
    })
    .attr("dy", "0.35em")
    .attr("text-anchor", "middle")
    .attr("font-size", "9px")
    .attr("font-weight", "600")
    .attr("fill", "#fff")
    .attr("pointer-events", "none")
    .text(d => d.data.name.length > 10 ? d.data.name.slice(0, 8) + ".." : d.data.name);

  // Título central
  const centerText = _svg.append("text")
    .attr("text-anchor", "middle")
    .attr("dominant-baseline", "central")
    .attr("font-size", "14px")
    .attr("font-weight", "800")
    .attr("fill", "var(--text-primary)")
    .text("Explorar");

  // Animación de entrada
  paths.transition().duration(TRANSITION)
    .attrTween("d", d => {
      const i = d3.interpolate({ x0: 0, x1: 0 }, d);
      return t => arc(i(t));
    });

  _unsubs.push(on("genre:select", ({ genre }) => {
    _activeGenre = genre;
    centerText.text(genre).attr("fill", genreColor(genre));
    paths.transition().duration(300)
      .attr("fill-opacity", d => (d.data.name === genre || d.parent?.data.name === genre) ? 1 : 0.2);
  }));

  _unsubs.push(on("filters:clear", () => {
    _activeGenre = null;
    centerText.text("Explorar").attr("fill", "var(--text-primary)");
    paths.transition().duration(300).attr("fill-opacity", 0.8);
  }));
}

function _rebuild() {
  const { w, h } = _dims();
  if (Math.abs(w - _prevW) < 10 && Math.abs(h - _prevH) < 10) return;
  _build();
}

let _prevW = 0, _prevH = 0;
function _dims() {
  if (!_container) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  const w = Math.max(r.width, 100);
  const h = Math.max(r.height, 100);
  return { w, h };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function _prepareHierarchy(raw) {
  const children = [];
  const processed = new Set();

  Object.entries(CATEGORIES).forEach(([cat, genres]) => {
    const catChildren = raw
      .filter(g => genres.includes(g.track_genre))
      .map(g => { processed.add(g.track_genre); return { name: g.track_genre, value: g.popularity || 10 }; });
    
    if (catChildren.length > 0) {
      children.push({ name: cat, children: catChildren });
    }
  });

  // Otros géneros
  const others = raw
    .filter(g => !processed.has(g.track_genre))
    .slice(0, 40) // Limitar para no saturar
    .map(g => ({ name: g.track_genre, value: g.popularity || 5 }));

  children.push({ name: "otros", children: others });

  return { name: "root", children };
}

export default { initSunburst };
