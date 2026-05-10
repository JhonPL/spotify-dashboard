/**
 * scales.js — Escalas reutilizables y colores centralizados
 * Importar este módulo desde cualquier chart.
 * Depende de: d3 (importado), store (para datos)
 */

import * as d3 from "d3";

// ─── Paleta de 20 géneros — perceptualmente distintos, dark-mode friendly ────
export const GENRE_COLORS = [
  "#1DB954", // spotify green
  "#4a9eff", // blue
  "#e91e8c", // pink
  "#ff6b35", // orange
  "#9b59f5", // purple
  "#00d4aa", // teal
  "#f5c542", // yellow
  "#ff4757", // red
  "#2ed573", // mint
  "#ffa502", // amber
  "#a29bfe", // lavender
  "#fd79a8", // rose
  "#00cec9", // cyan
  "#6c5ce7", // indigo
  "#fdcb6e", // sand
  "#e17055", // coral
  "#74b9ff", // sky
  "#55efc4", // seafoam
  "#fab1a0", // peach
  "#dfe6e9", // silver
];

// ─── Mapa feature → color de acento ─────────────────────────────────────────
export const FEATURE_COLORS = {
  danceability:     "#1DB954",
  energy:           "#f43f5e",
  valence:          "#f59e0b",
  acousticness:     "#38bdf8",
  instrumentalness: "#8b5cf6",
  liveness:         "#14b8a6",
  speechiness:      "#fb923c",
  tempo:            "#a78bfa",
  loudness:         "#4ade80",
  popularity:       "#facc15",
  tempo_norm:       "#a78bfa",
};

// ─── Labels legibles para features ──────────────────────────────────────────
export const FEATURE_LABELS = {
  danceability:     "Danceability",
  energy:           "Energy",
  valence:          "Valence",
  acousticness:     "Acousticness",
  instrumentalness: "Instrumentalness",
  liveness:         "Liveness",
  speechiness:      "Speechiness",
  tempo:            "Tempo",
  loudness:         "Loudness",
  popularity:       "Popularity",
  tempo_norm:       "Tempo (norm.)",
};

// ─── Escala ordinal de géneros ────────────────────────────────────────────────
// Inicializar con initGenreScale(genres) antes de usar genreColor
let _genreColor = null;

export function initGenreScale(genres) {
  _genreColor = d3.scaleOrdinal()
    .domain(genres)
    .range(GENRE_COLORS);
  return _genreColor;
}

export function genreColor(genre) {
  if (!_genreColor) {
    console.warn("[scales] genreColor usada antes de initGenreScale()");
    return GENRE_COLORS[0];
  }
  return _genreColor(genre);
}

// ─── Escala divergente para correlación [-1, 1] ──────────────────────────────
export const corrColor = d3.scaleLinear()
  .domain([-1, -0.5, 0, 0.5, 1])
  .range(["#1e3a5f", "#0d6ebd", "#2a2a2a", "#1aa34a", "#0a4f23"])
  .clamp(true);

// ─── Escala de densidad (hexbin) ─────────────────────────────────────────────
export const densityColor = d3.scaleSequential()
  .domain([0, 1])
  .interpolator(d3.interpolate("#0d2b1a", "#1DB954"));

// ─── Escala de energía ───────────────────────────────────────────────────────
export const energyColor = d3.scaleSequential()
  .domain([0, 1])
  .interpolator(d3.interpolate("#1e3a5f", "#f43f5e"));

// ─── Escala de popularidad ───────────────────────────────────────────────────
export const popularityColor = d3.scaleSequential()
  .domain([0, 100])
  .interpolator(d3.interpolate("#1a1a1a", "#1DB954"));

// ─── Escala de valence: tristeza → alegría ───────────────────────────────────
export const valenceColor = d3.scaleSequential()
  .domain([0, 1])
  .interpolator(d3.interpolate("#8b5cf6", "#f59e0b"));

// ─── Escala de tamaño para bubble / circular packing ─────────────────────────
export function bubbleScale(data, key, minR = 4, maxR = 40) {
  return d3.scaleSqrt()
    .domain([0, d3.max(data, (d) => d[key])])
    .range([minR, maxR]);
}

// ─── Obtener color de un feature por nombre ──────────────────────────────────
export function featureColor(feature) {
  return FEATURE_COLORS[feature] ?? "#a3a3a3";
}

// ─── Escala de heatmap: blanco apagado → verde Spotify ──────────────────────
export const heatmapColor = d3.scaleSequential()
  .domain([0, 1])
  .interpolator(d3.interpolate("#1a1a1a", "#1DB954"));

// ─── Utilidad: normalizar un array al rango [0,1] ───────────────────────────
export function normalize(arr) {
  const lo = d3.min(arr);
  const hi = d3.max(arr);
  const range = hi - lo || 1;
  return arr.map((v) => (v - lo) / range);
}

// ─── Utilidad: formateo compacto de números ──────────────────────────────────
export function fmt(value, decimals = 2) {
  if (value == null) return "—";
  if (Math.abs(value) >= 1000) return d3.format(".3s")(value);
  return d3.format(`,.${decimals}f`)(value);
}

export default {
  GENRE_COLORS,
  FEATURE_COLORS,
  FEATURE_LABELS,
  initGenreScale,
  genreColor,
  corrColor,
  densityColor,
  energyColor,
  popularityColor,
  valenceColor,
  bubbleScale,
  featureColor,
  heatmapColor,
  normalize,
  fmt,
};