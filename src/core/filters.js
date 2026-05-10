/**
 * filters.js — Cross-filtering coordinado
 *
 * Centraliza toda la lógica de filtrado.
 * Los gráficos llaman a estas funciones; nunca se filtran entre sí.
 */

import store from "./store.js";
import { emit } from "./eventBus.js";

/**
 * Filtrar el sample de features por los filtros activos.
 * Usado por: scatterplot, parallel coords, hexbin.
 */
export function getFilteredSample() {
  const data   = store.getData("featuresSample");
  const genre  = store.get("filters.genre");
  const extent = store.get("filters.brushExtent");

  if (!data) return [];

  let filtered = data;

  // Filtro por género
  if (genre) {
    filtered = filtered.filter(d => d.track_genre === genre);
  }

  // Filtro por brush (scatterplot extent)
  if (extent) {
    const [[x0, y0], [x1, y1]] = extent;
    const fx = store.get("filters.featureX");
    const fy = store.get("filters.featureY");
    filtered = filtered.filter(d =>
      d[fx] >= x0 && d[fx] <= x1 &&
      d[fy] >= y0 && d[fy] <= y1
    );
  }

  return filtered;
}

/**
 * Filtrar géneros summary por selección activa.
 * Usado por: treemap, heatmap, radar.
 */
export function getFilteredGenres() {
  const data  = store.getData("genresSummary");
  const genre = store.get("filters.genre");
  if (!data) return [];
  if (!genre) return data;
  return data.filter(d => d.track_genre === genre);
}

/**
 * Obtener géneros activos (para highlight coordinado).
 * Devuelve Set con los géneros que deben estar "focused".
 * Si no hay filtro, devuelve null (todos activos).
 */
export function getActiveGenres() {
  const genre  = store.get("filters.genre");
  const genres = store.get("filters.genres");
  if (genre)         return new Set([genre]);
  if (genres.length) return new Set(genres);
  return null; // todos activos
}

/**
 * Aplicar highlight coordinado a elementos SVG con data-genre.
 * Llama a esta función desde cualquier gráfico al recibir genre:select o genre:hover.
 */
export function applyGenreHighlight(containerEl, activeGenres) {
  if (!containerEl) return;

  const elements = containerEl.querySelectorAll("[data-genre]");
  if (!activeGenres) {
    // Sin filtro: todos normales
    elements.forEach(el => {
      el.classList.remove("dimmed", "focused");
    });
    return;
  }

  elements.forEach(el => {
    const genre = el.getAttribute("data-genre");
    if (activeGenres.has(genre)) {
      el.classList.remove("dimmed");
      el.classList.add("focused");
    } else {
      el.classList.remove("focused");
      el.classList.add("dimmed");
    }
  });
}

/**
 * Seleccionar un género globalmente (desde cualquier gráfico).
 * Dispara el evento que todos los gráficos escuchan.
 */
export function selectGenre(genre) {
  const current = store.get("filters.genre");

  // Toggle: si ya está seleccionado, limpiar
  if (current === genre) {
    clearAllFilters();
    return;
  }

  store.setGenreFilter(genre);
  emit("genre:select", { genre });

  // Mostrar pill en topbar
  const pill  = document.getElementById("active-filter");
  const label = document.getElementById("filter-label");
  if (pill && label) {
    label.textContent = genre;
    pill.style.display = "flex";
  }
}

/**
 * Hover sobre género (sin seleccionar).
 */
export function hoverGenre(genre) {
  store.set("ui.hoveredGenre", genre);
  emit("genre:hover", { genre });
}

/**
 * Limpiar todos los filtros.
 */
export function clearAllFilters() {
  store.clearFilters();
  emit("filters:clear", {});
  // No emitir genre:select aquí — filters:clear ya señaliza a todos los gráficos.
  // Emitirlo causaría un double-trigger que genera conflictos en transiciones D3.

  const pill = document.getElementById("active-filter");
  if (pill) pill.style.display = "none";
}

/**
 * Actualizar brush del scatterplot.
 * Recibe el extent [[x0,y0],[x1,y1]] en valores de dominio (no pixels).
 */
export function updateBrush(extent) {
  store.set("filters.brushExtent", extent);
  const filtered = getFilteredSample();
  const ids = new Set(filtered.map(d => d.track_id));
  emit("brush:update", { extent, ids });
}

export default {
  getFilteredSample,
  getFilteredGenres,
  getActiveGenres,
  applyGenreHighlight,
  selectGenre,
  hoverGenre,
  clearAllFilters,
  updateBrush,
};