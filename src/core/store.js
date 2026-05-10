/**
 * store.js — Estado global del dashboard
 *
 * Un objeto central que guarda el estado de todos los filtros y selecciones.
 * Los gráficos leen de aquí y notifican cambios via eventBus.
 */

const _state = {
  // Datos cargados
  data: {
    meta:               null,
    genresSummary:      null,
    featuresSample:     null,
    artistsTop:         null,
    genreFeatureMatrix: null,
    popularityDist:     null,
    audioDist:          null,
    genreSimilarity:    null,
    temporalTrends:     null,
    topTracks:          null,
  },

  // Filtros activos
  filters: {
    genre:       null,   // string | null — género seleccionado globalmente
    genres:      [],     // string[]     — múltiple selección (brushing)
    featureX:    "energy",
    featureY:    "danceability",
    brushExtent: null,   // [[x0,y0],[x1,y1]] del scatterplot brush
  },

  // Estado de UI
  ui: {
    activeView:      "overview",
    hoveredGenre:    null,
    selectedArtist:  null,
    loadingPanels:   new Set(),
  },
};

// ── Listeners por clave ─────────────────────────────────────────────────────
const _listeners = {};

function _notify(key) {
  (_listeners[key] || []).forEach(fn => fn(get(key)));
  (_listeners["*"]  || []).forEach(fn => fn(key, get(key)));
}

// ── API pública ─────────────────────────────────────────────────────────────

/** Lee una clave anidada con notación de punto: "filters.genre" */
export function get(path) {
  return path.split(".").reduce((obj, k) => obj?.[k], _state);
}

/** Escribe una clave anidada y notifica */
export function set(path, value) {
  const keys = path.split(".");
  const last  = keys.pop();
  const target = keys.reduce((obj, k) => obj[k], _state);
  target[last] = value;
  _notify(path);
}

/** Suscribirse a cambios en una clave (o "*" para todo) */
export function subscribe(path, fn) {
  if (!_listeners[path]) _listeners[path] = [];
  _listeners[path].push(fn);
  // Devuelve función para desuscribir
  return () => {
    _listeners[path] = _listeners[path].filter(f => f !== fn);
  };
}

/** Helpers de filtros */
export function setGenreFilter(genre) {
  set("filters.genre",  genre);
  set("filters.genres", genre ? [genre] : []);
}

export function clearFilters() {
  set("filters.genre",       null);
  set("filters.genres",      []);
  set("filters.brushExtent", null);
}

export function setLoadingPanel(panelId, loading) {
  const panels = get("ui.loadingPanels");
  loading ? panels.add(panelId) : panels.delete(panelId);
  const el = document.getElementById(panelId)?.querySelector(".panel__body");
  if (el) el.classList.toggle("loading", loading);
}

/** Lee todos los datos cargados */
export function getData(key) {
  return _state.data[key];
}

/** Guarda datos cargados */
export function setData(key, value) {
  _state.data[key] = value;
  _notify(`data.${key}`);
}

export default { get, set, subscribe, setGenreFilter, clearFilters, getData, setData, setLoadingPanel };