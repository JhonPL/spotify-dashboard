// src/utils/scales.js
// ─────────────────────────────────────────────────────────
// Escalas reutilizables y acceso centralizado a colores
// ─────────────────────────────────────────────────────────

const Scales = {

  // ── Escala de color por género (ordinal) ──
  genreColor: null,  // se inicializa tras cargar datos

  initGenre(genres) {
    Scales.genreColor = d3.scaleOrdinal()
      .domain(genres)
      .range(C.GENRE_COLORS);
  },

  // ── Escala de correlación divergente [-1, 1] ──
  corrColor: d3.scaleLinear()
    .domain([-1, -0.5, 0, 0.5, 1])
    .range(['#1e3a5f', '#0d6ebd', '#e0e0e0', '#1aa34a', '#0a4f23'])
    .clamp(true),

  // ── Escala de densidad hexbin ──
  densityColor: d3.scaleSequential()
    .domain([0, 1])
    .interpolator(d3.interpolate('#0d2b1a', '#1DB954')),

  // ── Escala de energía ──
  energyColor: d3.scaleSequential()
    .domain([0, 1])
    .interpolator(d3.interpolate('#38bdf8', '#f43f5e')),

  // ── Escala de popularidad ──
  popularityColor: d3.scaleSequential()
    .domain([0, 100])
    .interpolator(d3.interpolate('#1a1a1a', '#1DB954')),

  // ── Escala de valence (tristeza → alegría) ──
  valenceColor: d3.scaleSequential()
    .domain([0, 1])
    .interpolator(d3.interpolate('#8b5cf6', '#f59e0b')),

  // ── Escala de tamaño para bubble/pack ──
  bubble(data, key, maxR = 40) {
    return d3.scaleSqrt()
      .domain([0, d3.max(data, d => d[key])])
      .range([4, maxR]);
  },

  // ── Escala lineal genérica [0,1] ──
  linear01: d3.scaleLinear().domain([0, 1]).range([0, 1]),

  // ── Obtener color de feature ──
  featureColor(feature) {
    const map = {
      danceability: '#1DB954',
      energy:       '#f43f5e',
      valence:      '#f59e0b',
      acousticness: '#38bdf8',
      instrumentalness: '#8b5cf6',
      liveness:     '#14b8a6',
      speechiness:  '#fb923c',
      tempo:        '#a78bfa',
      loudness:     '#4ade80',
      popularity:   '#facc15',
    };
    return map[feature] || '#a3a3a3';
  },
};