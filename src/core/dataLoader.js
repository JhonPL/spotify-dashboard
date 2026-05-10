/**
 * dataLoader.js — Carga de datos con prioridad y caché
 *
 * Carga los JSONs en dos fases:
 *   1. Críticos (necesarios para renderizar Overview al inicio)
 *   2. Secundarios (el resto, en background)
 */

import * as d3 from "d3";
import store    from "./store.js";
import { emit } from "./eventBus.js";

const BASE = "/data";

// Definición de todos los archivos y su prioridad
const FILES = [
  // ── Fase 1: críticos ─────────────────────────────────────────
  { key: "meta",               file: "meta.json",                 phase: 1 },
  { key: "genresSummary",      file: "genres_summary.json",       phase: 1 },
  { key: "featuresSample",     file: "features_sample.json",      phase: 1 },
  // ── Fase 2: secundarios ──────────────────────────────────────
  { key: "artistsTop",         file: "artists_top.json",          phase: 2 },
  { key: "genreFeatureMatrix", file: "genre_features_matrix.json",phase: 2 },
  { key: "popularityDist",     file: "popularity_distribution.json", phase: 2 },
  { key: "audioDist",          file: "audio_distributions.json",  phase: 2 },
  { key: "genreSimilarity",    file: "genre_similarity.json",     phase: 2 },
  { key: "temporalTrends",     file: "temporal_trends.json",      phase: 2 },
  { key: "topTracks",          file: "top_tracks.json",           phase: 2 },
];

async function loadFile({ key, file }) {
  try {
    const data = await d3.json(`${BASE}/${file}`);
    store.setData(key, data);
    emit("data:ready", { key });
    return { key, ok: true };
  } catch (err) {
    console.error(`[dataLoader] Error cargando ${file}:`, err);
    return { key, ok: false };
  }
}

/**
 * Carga fase 1 (críticos) y devuelve una promesa.
 * Luego dispara fase 2 en background sin bloquear.
 */
export async function loadAll() {
  const phase1 = FILES.filter(f => f.phase === 1);
  const phase2 = FILES.filter(f => f.phase === 2);

  // Fase 1: esperar a que todos carguen
  await Promise.all(phase1.map(loadFile));
  emit("data:phase1Ready", {});

  // Fase 2: cargar en background, uno a uno para no saturar
  (async () => {
    for (const f of phase2) {
      await loadFile(f);
    }
    emit("data:allReady", {});
  })();
}

export default { loadAll };