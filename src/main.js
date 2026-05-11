/**
 * main.js — Entry point del dashboard
 *
 * Responsabilidades:
 *   1. Cargar datos (fase 1 crítica + fase 2 en background)
 *   2. Inicializar navegación entre vistas
 *   3. Registrar listeners globales (topbar, filtro clear)
 *   4. Inicializar gráficos cuando sus datos estén listos
 */

import { loadAll }       from "./core/dataLoader.js";
import { on, emit }      from "./core/eventBus.js";
import store             from "./core/store.js";
import { clearAllFilters, selectGenre } from "./core/filters.js";

// ── Gráficos implementados ─────────────────────────────────────────────────
import { initTreemap }   from "./charts/treemap.js";
import { initHeatmap }   from "./charts/heatmap.js";      
import { initScatter }   from "./charts/scatterplot.js";
import { initStreamgraph }  from "./charts/streamgraph.js";
import { initRadar } from "./charts/radar.js";
import { initChord } from "./charts/chord.js";
import { initViolin } from "./charts/violin.js";
import { initRidgeline } from "./charts/ridgeline.js";
import { initParallel } from "./charts/parallel.js";
import { initHexbin } from "./charts/hexbin.js";

// ── Textos por vista ────────────────────────────────────────────────────────
const VIEW_TITLES = {
  overview:  ["Overview",    "Análisis general del dataset"],
  genres:    ["Géneros",     "Distribución y características por género"],
  features:  ["Features",    "Exploración de atributos de audio"],
  artists:   ["Artistas",    "Top artistas y patrones musicales"],
  relations: ["Relaciones",  "Similitudes y conexiones entre géneros"],
};

// ── Navegación ──────────────────────────────────────────────────────────────
function initNavigation() {
  const navItems = document.querySelectorAll(".nav-item[data-view]");

  navItems.forEach((item) => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      switchView(item.dataset.view);
    });
  });
}

function switchView(viewId) {
  document.querySelectorAll(".nav-item").forEach((el) => {
    el.classList.toggle("active", el.dataset.view === viewId);
  });

  document.querySelectorAll(".view").forEach((el) => {
    el.classList.toggle("active", el.id === `view-${viewId}`);
  });

  const [title, subtitle] = VIEW_TITLES[viewId] ?? ["", ""];
  document.getElementById("view-title").textContent    = title;
  document.getElementById("view-subtitle").textContent = subtitle;

  store.set("ui.activeView", viewId);
  emit("view:change", { view: viewId });
}

// ── KPI cards + select de géneros ───────────────────────────────────────────
function updateKPIs(meta, genres) {
  // Sidebar meta-stats
  document.getElementById("meta-tracks").textContent  =
    meta.total_tracks.toLocaleString("es");
  document.getElementById("meta-genres").textContent  = meta.total_genres;
  document.getElementById("meta-artists").textContent =
    meta.total_artists.toLocaleString("es");

  // KPI cards
  document.getElementById("kpi-popularity").textContent =
    meta.avg_popularity.toFixed(1);

  const avg = (key) =>
    (genres.reduce((s, g) => s + (g[key] ?? 0), 0) / genres.length).toFixed(2);

  document.getElementById("kpi-energy").textContent  = avg("energy");
  document.getElementById("kpi-dance").textContent   = avg("danceability");
  document.getElementById("kpi-valence").textContent = avg("valence");

  // Poblar <select> global con géneros ordenados alfabéticamente
  const select = document.getElementById("global-genre-select");
  // Limpiar opciones previas (excepto la primera "Todos los géneros")
  while (select.options.length > 1) select.remove(1);

  [...genres]
    .sort((a, b) => a.track_genre.localeCompare(b.track_genre))
    .forEach((g) => {
      const opt = document.createElement("option");
      opt.value       = g.track_genre;
      opt.textContent = g.track_genre;
      select.appendChild(opt);
    });
}

// ── Filtro global (select + pill de limpiar) ─────────────────────────────────
function initGlobalFilter() {
  const select = document.getElementById("global-genre-select");
  let isSettingValue = false;  // Flag para evitar loop de sincronización

  select.addEventListener("change", (e) => {
    // Ignorar cambios programáticos (evita loop infinito)
    if (isSettingValue) return;
    
    const genre = e.target.value;
    if (genre) selectGenre(genre);
    else clearAllFilters();
  });

  document.getElementById("filter-clear")?.addEventListener("click", () => {
    clearAllFilters();
    isSettingValue = true;
    select.value = "";
    isSettingValue = false;
  });

  // Sincronizar select cuando se filtra desde un gráfico (p.ej. clic en treemap)
  on("genre:select", ({ genre }) => {
    isSettingValue = true;
    select.value = genre ?? "";
    isSettingValue = false;
  });

  on("filters:clear", () => {
    isSettingValue = true;
    select.value = "";
    isSettingValue = false;
  });
}

// ── Inicialización de gráficos por vista ─────────────────────────────────────
// Inicializa los gráficos de una vista solo cuando se activa por primera vez.
const _initialized = new Set();

function initViewCharts(viewId) {
  if (_initialized.has(viewId)) return;
  _initialized.add(viewId);

  switch (viewId) {
    case "overview":
      initTreemap(document.getElementById("chart-treemap"));
      initHeatmap(document.getElementById("chart-heatmap"));
      initScatter(document.getElementById("chart-scatter"));
      initStreamgraph(document.getElementById("chart-streamgraph"));
      break;

    case "genres":
      initRadar(document.getElementById("chart-radar"));
      initChord(document.getElementById("chart-chord"));
      initViolin(document.getElementById("chart-violin"));
      initRidgeline(document.getElementById("chart-ridgeline"));
      break;

    case "features":
      initParallel(document.getElementById("chart-parallel"));
      initHexbin(document.getElementById("chart-hexbin"));
      // initHistogram(document.getElementById("chart-histogram"));
      break;

    case "artists":
      // initBubble(document.getElementById("chart-bubble"));
      // initPacking(document.getElementById("chart-packing"));
      // initSmallMultiples(document.getElementById("chart-small-multiples"));
      break;

    case "relations":
      // initForce(document.getElementById("chart-force"));
      // initChord(document.getElementById("chart-chord"));
      // initSankey(document.getElementById("chart-sankey"));
      break;
  }
}

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function bootstrap() {
  // 1. Nav y filtros (no dependen de datos)
  initNavigation();
  initGlobalFilter();

  // 2. Cargar datos fase 1 (meta + genresSummary + featuresSample)
  await loadAll();

  const meta   = store.getData("meta");
  const genres = store.getData("genresSummary");

  if (meta && genres) {
    updateKPIs(meta, genres);
  }

  // 3. Inicializar gráficos de la vista activa (overview por defecto)
  initViewCharts(store.get("ui.activeView") || "overview");

  // 4. Cuando el usuario cambia de vista, inicializar los gráficos de esa vista
  on("view:change", ({ view }) => {
    initViewCharts(view);
  });

  console.log("✅ Dashboard listo — treemap activo");
}

bootstrap();