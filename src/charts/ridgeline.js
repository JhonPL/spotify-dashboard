/**
 * ridgeline.js — Gráfico de Ridgeline para distribución de energía por género
 */

import * as d3 from "d3";
import store from "../core/store.js";
import { on } from "../core/eventBus.js";
import { genreColor, fmt } from "../utils/scales.js";

const MARGIN = { top: 40, right: 20, bottom: 30, left: 100 };
const OVERLAP = 0.6; // Cuánto se solapan las curvas
const DEBOUNCE_MS = 380;

let _container = null;
let _svg = null;
let _resizeObs = null;
let _prevW = 0;
let _prevH = 0;
let _activeGenre = null;
let _unsubs = [];

export function initRidgeline(container) {
  if (!container) return;
  _container = container;
  
  const data = store.getData("popularityDist"); // Usamos los mismos datos de distribución
  if (!data) {
    on("data:ready", ({ key }) => {
      if (key === "popularityDist") _build();
    });
    return;
  }
  _build();
}

function _build() {
  const raw = store.getData("popularityDist");
  if (!raw || !_container) return;

  const { w, h } = _dims();
  if (w === 0) return;

  _prevW = w;
  _prevH = h;

  // Solo los top 15 géneros para que no sea eterno
  const genres = Object.keys(raw).slice(0, 15);
  
  const innerW = w - MARGIN.left - MARGIN.right;
  const innerH = h - MARGIN.top - MARGIN.bottom;

  _svg = d3.select(_container)
    .selectAll("svg")
    .data([null])
    .join("svg")
      .attr("width", w)
      .attr("height", h);

  const gRoot = _svg.selectAll("g.ridgeline-root")
    .data([null])
    .join("g")
      .attr("class", "ridgeline-root")
      .attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

  // Eventos
  _unsubs.forEach(f => f());
  _unsubs = [
    on("genre:select", ({ genre }) => {
      _activeGenre = genre;
      _applyHighlight(genre);
    }),
    on("filters:clear", () => {
      _activeGenre = null;
      _restoreAll();
    })
  ];

  // Escalas
  const x = d3.scaleLinear()
    .domain([0, 100])
    .range([0, innerW]);

  const y = d3.scalePoint()
    .domain(genres)
    .range([0, innerH]);

  const z = d3.scaleLinear()
    .domain([0, 0.1]) // Ajustar según densidad real
    .range([0, -OVERLAP * y.step()]);

  // KDE
  function kernelDensityEstimator(kernel, X) {
    return function(V) {
      return X.map(x => [x, d3.mean(V, v => kernel(x - v))]);
    };
  }
  function kernelEpanechnikov(k) {
    return v => Math.abs(v /= k) <= 1 ? 0.75 * (1 - v * v) / k : 0;
  }

  const kde = kernelDensityEstimator(kernelEpanechnikov(7), x.ticks(40));
  
  const area = d3.area()
    .curve(d3.curveBasis)
    .x(d => x(d[0]))
    .y0(0)
    .y1(d => z(d[1]));

  const line = d3.line()
    .curve(d3.curveBasis)
    .x(d => x(d[0]))
    .y(d => z(d[1]));

  // Dibujar
  gRoot.selectAll(".ridge-group")
    .data(genres)
    .join("g")
      .attr("class", "ridge-group")
      .attr("transform", d => `translate(0,${y(d)})`)
      .style("opacity", d => _activeGenre ? (d === _activeGenre ? 1 : 0.15) : 1)
      .each(function(gName) {
        const dataValues = raw[gName] || [];
        const density = kde(dataValues);
        const color = genreColor(gName);

        d3.select(this).selectAll("path.area")
          .data([density])
          .join("path")
            .attr("class", "area")
            .attr("d", area)
            .attr("fill", color)
            .attr("fill-opacity", _activeGenre === gName ? 0.6 : 0.4)
            .attr("stroke", color)
            .attr("stroke-width", _activeGenre === gName ? 2 : 1);
            
        d3.select(this).selectAll("text.label")
          .data([gName])
          .join("text")
            .attr("class", "label")
            .attr("x", -10)
            .attr("y", 0)
            .attr("text-anchor", "end")
            .attr("fill", "var(--text-muted)")
            .attr("font-size", "10px")
            .text(d => d);
      });

  // Eje X
  gRoot.selectAll("g.axis-x")
    .data([null])
    .join("g")
      .attr("class", "axis-x")
      .attr("transform", `translate(0,${innerH})`)
      .call(d3.axisBottom(x).ticks(5).tickSize(0).tickPadding(10))
      .call(g => g.select(".domain").remove())
      .call(g => g.selectAll("text").attr("fill", "var(--text-hint)").attr("font-size", "10px"));

  if (!_resizeObs) {
    _resizeObs = new ResizeObserver(_debounce(_rebuild, DEBOUNCE_MS));
    _resizeObs.observe(_container);
  }
}

function _rebuild() {
  const { w, h } = _dims();
  if (w === 0 || (Math.abs(w - _prevW) < 12 && Math.abs(h - _prevH) < 12)) return;
  _build();
}

function _applyHighlight(genre) {
  if (!_svg) return;
  _svg.selectAll(".ridge-group")
    .transition().duration(400)
    .style("opacity", d => d === genre ? 1 : 0.15)
    .select("path.area")
      .attr("fill-opacity", d => d === genre ? 0.6 : 0.4)
      .attr("stroke-width", d => d === genre ? 2 : 1);
}

function _restoreAll() {
  if (!_svg) return;
  _svg.selectAll(".ridge-group")
    .transition().duration(400)
    .style("opacity", 1)
    .select("path.area")
      .attr("fill-opacity", 0.4)
      .attr("stroke-width", 1);
}

function _dims() {
  if (!_container || _container.clientWidth === 0) return { w: 0, h: 0 };
  const r = _container.getBoundingClientRect();
  return { w: r.width, h: r.height };
}

function _debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export default { initRidgeline };
