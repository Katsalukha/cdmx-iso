# cdmx-iso

Photorealistic **isometric** viewer for CDMX — a fork of
[`cdmx-3d`](https://github.com/Katsalukha/cdmx-3d) that swaps the stylized OSM extrusions for
**Google Photorealistic 3D Tiles** (the real-world photogrammetry mesh behind Google Earth) rendered
through a fixed **orthographic camera**. This is the technique behind
[isometric.nyc](https://isometric.nyc/).

> The original stylized `cdmx-3d` is preserved unchanged as the archive (tag `v1-stylized`).

Default location: **Plaza Luis Cabrera** (19.41633, -99.15955), Roma Norte.

## Status — Phase 1

A single-location live 3D view under the iso camera (pan + zoom). This is the building block for the
whole-city options below; **decide Phase 2 after Phase 1 is working.**

| Path | What it is | Whole-city | Cost to run | Effort |
|------|------------|------------|-------------|--------|
| **A. Live 3D roam** | Stream tiles in-browser | yes, coarse when zoomed out | bills Google per view/pan | low–med |
| **B. Baked iso map** (true isometric.nyc) | Offline-render → image pyramid → static images | yes, instant, exact look | free to serve | high (offline GPU pipeline) |
| **C. Neighborhood viewer** | One spot via search/dropdown | no | bounded | low |

## Tech

- **three.js r0.170** + **`3d-tiles-renderer@0.4.28`** (NASA-AMMOS), loaded from
  [esm.sh](https://esm.sh) via an `importmap`. No build step, no package manager — same as `cdmx-3d`.
- `GoogleCloudAuthPlugin` (direct Google key) · `ReorientationPlugin` (puts the target lat/lon at the
  scene origin) · `GLTFExtensionsPlugin` + `DRACOLoader` (Google tiles are Draco-compressed glTF) ·
  `TileCompressionPlugin` · `TilesFadePlugin`.

```
index.html         # UI shell (ported cdmx-3d aesthetic) + importmap + key modal
app.js             # renderer: tiles + auth + reorientation + ortho iso camera + loop
config.example.js  # optional local-dev key (copy → config.local.js)
.nojekyll          # serve as-is on GitHub Pages
```

## Google Maps Platform key (required)

The realism comes from Google's tiles, which need an API key with **billing enabled**.

1. [Google Cloud Console](https://console.cloud.google.com/) → new/existing project.
2. Enable the **Map Tiles API**.
3. **APIs & Services → Credentials → Create credentials → API key.**
4. **Restrict the key** (important — a client key is public):
   - *Application restrictions* → **HTTP referrers**: `https://katsalukha.github.io/*` and
     `http://localhost:*`
   - *API restrictions* → **Map Tiles API** only.
5. **Billing → Budgets & alerts**: set a budget + a quota cap. 3D Tiles bill per request/session;
   a fixed-zoom neighborhood view is light, but pan-heavy use (and Path A) adds up. There's a free
   monthly allowance — check current pricing before opening it to the public.

### Giving the app your key

- **In-app (default):** the first load shows a modal; paste the key — it's stored in `localStorage`
  for that browser only, never committed.
- **Local dev (optional):** `cp config.example.js config.local.js`, put your key in it, and add
  `<script src="./config.local.js"></script>` just before the importmap in `index.html`.
  `config.local.js` is gitignored.

## Run locally

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

Must be served over `http://localhost` or HTTPS (the key's referrer restriction and tile fetches fail
under `file://`).

## Deploy

Push to the `cdmx-iso` repo and enable **GitHub Pages** (branch `main`, root). Confirm the
referrer-restricted key works on `https://katsalukha.github.io/cdmx-iso/`.

## Tuning (in `app.js`)

- `ERROR_TARGET` — lower = sharper / more tiles / more cost (try 6–24).
- `ISO_EL` — `35.264°` is true isometric; `~30°` reads closer to the isometric.nyc reference.
- `VIEW_RADIUS` — metres framed at zoom 1.
- Lighting (`AmbientLight` / `HemisphereLight` / `DirectionalLight`) — tiles are PBR + baked texture;
  adjust if the mesh looks too dark or washed out.
