/**
 * main.js — Entry point del dashboard
 *
 * Responsabilidades:
 *   1. Cargar datos
 *   2. Inicializar navegación entre vistas
 *   3. Registrar listeners globales (topbar, filtro clear)
 *   4. Inicializar gráficos cuando sus datos estén listos
 */

import { loadAll }       from "./core/dataLoader.js";
import { on, emit }      from "./core/eventBus.js";
import store             from "./core/store.js";
import { clearAllFilters, selectGenre } from "./core/filters.js";

// ── Importar gráficos (se irán añadiendo) ──────────────────────────────────
// import { initTreemap }      from "./charts/treemap.js";
// import { initHeatmap }      from "./charts/heatmap.js";
// import { initScatter }      from "./charts/scatterplot.js";
// import { initStreamgraph }  from "./charts/streamgraph.js";
// ... resto de gráficos

// ── Navegación ──────────────────────────────────────────────────────────────
const VIEW_TITLES = {
  overview:  ["Overview",    "Análisis general del dataset"],
  genres:    ["Géneros",     "Distribución y características por género"],
  features:  ["Features",    "Exploración de atributos de audio"],
  artists:   ["Artistas",    "Top artistas y patrones musicales"],
  relations: ["Relaciones",  "Similitudes y conexiones entre géneros"],
};

function initNavigation() {
  const navItems = document.querySelectorAll(".nav-item[data-view]");
  const views    = document.querySelectorAll(".view");

  navItems.forEach(item => {
    item.addEventListener("click", (e) => {
      e.preventDefault();
      const view = item.dataset.view;
      switchView(view);
    });
  });
}

function switchView(viewId) {
  // Actualizar nav
  document.querySelectorAll(".nav-item").forEach(el => {
    el.classList.toggle("active", el.dataset.view === viewId);
  });

  // Mostrar vista correcta
  document.querySelectorAll(".view").forEach(el => {
    el.classList.toggle("active", el.id === `view-${viewId}`);
  });

  // Actualizar topbar
  const [title, subtitle] = VIEW_TITLES[viewId] || ["", ""];
  document.getElementById("view-title").textContent    = title;
  document.getElementById("view-subtitle").textContent = subtitle;

  store.set("ui.activeView", viewId);
  emit("view:change", { view: viewId });
}

// ── KPI cards ───────────────────────────────────────────────────────────────
function updateKPIs(meta, genres) {
  document.getElementById("meta-tracks").textContent  = meta.total_tracks.toLocaleString("es");
  document.getElementById("meta-genres").textContent  = meta.total_genres;
  document.getElementById("meta-artists").textContent = meta.total_artists.toLocaleString("es");
  document.getElementById("kpi-popularity").textContent = meta.avg_popularity.toFixed(1);

  // Calcular promedios globales de géneros
  const avg = (key) => (genres.reduce((s, g) => s + g[key], 0) / genres.length).toFixed(2);
  document.getElementById("kpi-energy").textContent  = avg("energy");
  document.getElementById("kpi-dance").textContent   = avg("danceability");
  document.getElementById("kpi-valence").textContent = avg("valence");

  // Poblar select de géneros
  const select = document.getElementById("global-genre-select");
  genres
    .sort((a, b) => a.track_genre.localeCompare(b.track_genre))
    .forEach(g => {
      const opt = document.createElement("option");
      opt.value       = g.track_genre;
      opt.textContent = g.track_genre;
      select.appendChild(opt);
    });
}

// ── Filtro global desde select ───────────────────────────────────────────────
function initGlobalFilter() {
  const select = document.getElementById("global-genre-select");
  select.addEventListener("change", (e) => {
    const genre = e.target.value;
    if (genre) selectGenre(genre);
    else clearAllFilters();
  });

  // Botón clear pill
  document.getElementById("filter-clear")?.addEventListener("click", () => {
    clearAllFilters();
    select.value = "";
  });

  // Sincronizar select cuando se filtra desde un gráfico
  on("genre:select", ({ genre }) => {
    select.value = genre || "";
  });

  on("filters:clear", () => {
    select.value = "";
  });
}

// ── Bootstrap ───────────────────────────────────────────────────────────────
async function bootstrap() {
  initNavigation();
  initGlobalFilter();

  // Cargar datos fase 1
  await loadAll();

  const meta   = store.getData("meta");
  const genres = store.getData("genresSummary");

  if (meta && genres) {
    updateKPIs(meta, genres);
  }

  // Inicializar gráficos de overview
  // (descomentar a medida que se implementen)
  // initTreemap(document.getElementById("chart-treemap"));
  // initHeatmap(document.getElementById("chart-heatmap"));
  // initScatter(document.getElementById("chart-scatter"));
  // initStreamgraph(document.getElementById("chart-streamgraph"));

  console.log("✅ Dashboard listo");
}

bootstrap();