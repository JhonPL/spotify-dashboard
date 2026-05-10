"""
preprocess.py
-------------
Lee data/raw/dataset.csv y genera los JSONs en public/data/
Correr UNA sola vez: python scripts/preprocess.py
"""

import pandas as pd
import numpy as np
import json
import os
from pathlib import Path

# ─── Rutas ────────────────────────────────────────────────────────────────────
ROOT       = Path(__file__).parent.parent          # raíz del proyecto
CSV_PATH   = ROOT / "data" / "raw" / "dataset.csv"
OUT_DIR    = ROOT / "public" / "data"
OUT_DIR.mkdir(parents=True, exist_ok=True)

def save(name, data):
    path = OUT_DIR / f"{name}.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, separators=(",", ":"))
    size_kb = path.stat().st_size / 1024
    print(f"  ✓  {name}.json  ({size_kb:.1f} KB)")

# ─── Carga y limpieza base ─────────────────────────────────────────────────────
print("\n📂  Cargando dataset...")
df = pd.read_csv(CSV_PATH)
df = df.drop(columns=["Unnamed: 0"], errors="ignore")
df = df.dropna(subset=["track_name", "artists", "track_genre"])
df = df.drop_duplicates(subset=["track_id"])

AUDIO_FEATURES = [
    "danceability", "energy", "speechiness",
    "acousticness", "instrumentalness", "liveness",
    "valence", "tempo", "loudness", "popularity"
]

print(f"  {len(df):,} tracks · {df['track_genre'].nunique()} géneros · {df['artists'].nunique():,} artistas\n")
print("🔧  Generando JSONs...\n")

# ─── 1. genres_summary.json ───────────────────────────────────────────────────
# Para: Treemap, Radar, Heatmap, Sankey
g = df.groupby("track_genre").agg(
    count        = ("track_id",        "count"),
    popularity   = ("popularity",      "mean"),
    danceability = ("danceability",    "mean"),
    energy       = ("energy",          "mean"),
    valence      = ("valence",         "mean"),
    acousticness = ("acousticness",    "mean"),
    speechiness  = ("speechiness",     "mean"),
    instrumentalness = ("instrumentalness", "mean"),
    liveness     = ("liveness",        "mean"),
    tempo        = ("tempo",           "mean"),
    loudness     = ("loudness",        "mean"),
).reset_index()
g = g.round(4)

save("genres_summary", g.to_dict(orient="records"))

# ─── 2. features_sample.json ──────────────────────────────────────────────────
# Para: Scatterplot, Hexbin, Parallel Coordinates
# Estratificado: 50 canciones por género → 5,700 puntos
# pandas 2.x: groupby consume la columna clave, usar nlargest por índice
idx    = df.groupby("track_genre")["popularity"].nlargest(50).index.get_level_values(1)
sample = df.loc[idx]
cols = ["track_id", "track_name", "artists", "track_genre",
        "popularity", "danceability", "energy", "valence",
        "acousticness", "tempo", "loudness", "instrumentalness",
        "speechiness", "liveness", "duration_ms"]
save("features_sample", sample[cols].round(4).to_dict(orient="records"))

# ─── 3. artists_top.json ──────────────────────────────────────────────────────
# Para: Force Graph, Bubble Chart, Circular Packing
# Top 300 artistas por popularidad media (con ≥3 canciones)
# Nota: algunos artistas están separados por ";" en el campo artists
df_artists = df.copy()
df_artists["artist"] = df_artists["artists"].str.split(";").str[0].str.strip()

artists = (
    df_artists.groupby("artist")
    .agg(
        track_count  = ("track_id",     "count"),
        popularity   = ("popularity",   "mean"),
        danceability = ("danceability", "mean"),
        energy       = ("energy",       "mean"),
        valence      = ("valence",      "mean"),
        acousticness = ("acousticness", "mean"),
        tempo        = ("tempo",        "mean"),
        genres       = ("track_genre",  lambda x: x.value_counts().index[0]),  # género principal
    )
    .reset_index()
    .query("track_count >= 3")
    .nlargest(300, "popularity")
    .round(4)
)
save("artists_top", artists.to_dict(orient="records"))

# ─── 4. genre_features_matrix.json ───────────────────────────────────────────
# Para: Heatmap de correlación género × feature
features = ["danceability","energy","valence","acousticness",
            "speechiness","instrumentalness","liveness","tempo_norm"]
df["tempo_norm"] = (df["tempo"] - df["tempo"].min()) / (df["tempo"].max() - df["tempo"].min())

matrix = (
    df.groupby("track_genre")[features]
      .mean()
      .round(4)
      .reset_index()
)
save("genre_features_matrix", {
    "genres":   matrix["track_genre"].tolist(),
    "features": features,
    "values":   matrix[features].values.tolist()
})

# ─── 5. popularity_distribution.json ─────────────────────────────────────────
# Para: Violin Plot, Ridgeline Plot, Histogramas
# Top 20 géneros por cantidad de tracks para no saturar el gráfico
top20_genres = df["track_genre"].value_counts().head(20).index.tolist()
dist_data = {}
for genre in top20_genres:
    vals = df[df["track_genre"] == genre]["popularity"].tolist()
    dist_data[genre] = vals

save("popularity_distribution", dist_data)

# ─── 6. audio_distributions.json ─────────────────────────────────────────────
# Para: Violin y Ridgeline de features de audio (todos los géneros, datos resumidos)
summary_features = ["danceability", "energy", "valence", "acousticness", "speechiness"]
audio_dist = {}
for feat in summary_features:
    genre_data = {}
    for genre in top20_genres:
        vals = df[df["track_genre"] == genre][feat].round(3).tolist()
        # Guardar percentiles en vez de raw para reducir peso
        arr = np.array(vals)
        genre_data[genre] = {
            "min":  round(float(arr.min()), 3),
            "p10":  round(float(np.percentile(arr, 10)), 3),
            "p25":  round(float(np.percentile(arr, 25)), 3),
            "p50":  round(float(np.percentile(arr, 50)), 3),
            "p75":  round(float(np.percentile(arr, 75)), 3),
            "p90":  round(float(np.percentile(arr, 90)), 3),
            "max":  round(float(arr.max()), 3),
            "mean": round(float(arr.mean()), 3),
        }
    audio_dist[feat] = genre_data

save("audio_distributions", audio_dist)

# ─── 7. genre_similarity.json ────────────────────────────────────────────────
# Para: Chord Diagram, Hierarchical Edge Bundling, Force Graph
# Similitud coseno entre géneros basada en audio features
from numpy.linalg import norm

feat_cols = ["danceability","energy","valence","acousticness",
             "speechiness","instrumentalness","liveness"]
genre_vecs = df.groupby("track_genre")[feat_cols].mean()

genres_list = genre_vecs.index.tolist()
mat = genre_vecs.values

# Normalizar vectores
norms = norm(mat, axis=1, keepdims=True)
mat_norm = mat / np.where(norms == 0, 1, norms)

# Similitud coseno
sim_matrix = (mat_norm @ mat_norm.T)

# Guardar solo los pares con similitud > 0.97 (géneros muy similares)
links = []
for i in range(len(genres_list)):
    for j in range(i + 1, len(genres_list)):
        sim = float(sim_matrix[i, j])
        if sim > 0.97:
            links.append({
                "source": genres_list[i],
                "target": genres_list[j],
                "value":  round(sim, 4)
            })

save("genre_similarity", {
    "genres": genres_list,
    "links":  links
})

# ─── 8. temporal_trends.json ─────────────────────────────────────────────────
# Para: Streamgraph, Area Chart, Animated Timeline
# El dataset NO tiene columna de año, pero tiene popularity como proxy de "era"
# Agrupamos por popularity bins como timeline alternativa
df["pop_bin"] = pd.cut(df["popularity"], bins=10, labels=False)
top10_genres = df["track_genre"].value_counts().head(10).index.tolist()

temporal = []
for pop_bin in range(10):
    subset = df[df["pop_bin"] == pop_bin]
    entry = {"pop_bin": int(pop_bin), "label": f"Tier {pop_bin+1}"}
    for genre in top10_genres:
        g_sub = subset[subset["track_genre"] == genre]
        entry[genre] = round(float(g_sub["energy"].mean()), 3) if len(g_sub) > 0 else 0
    temporal.append(entry)

save("temporal_trends", {
    "genres": top10_genres,
    "data":   temporal
})

# ─── 9. top_tracks.json ───────────────────────────────────────────────────────
# Para: tooltips detallados, drill-down, búsqueda
top_tracks = (
    df.nlargest(500, "popularity")
      [["track_id","track_name","artists","track_genre",
        "popularity","danceability","energy","valence",
        "tempo","duration_ms","explicit"]]
      .round(4)
      .to_dict(orient="records")
)
save("top_tracks", top_tracks)

# ─── 10. meta.json ────────────────────────────────────────────────────────────
# Metadata general del dataset para mostrar en el dashboard
save("meta", {
    "total_tracks":    int(len(df)),
    "total_genres":    int(df["track_genre"].nunique()),
    "total_artists":   int(df["artists"].nunique()),
    "avg_popularity":  round(float(df["popularity"].mean()), 2),
    "features":        AUDIO_FEATURES,
    "top20_genres":    top20_genres,
    "top10_genres":    top10_genres,
})

print("\n✅  Todos los JSONs generados en public/data/\n")