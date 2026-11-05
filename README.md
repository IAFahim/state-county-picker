# State & County Picker

Pick US states and counties on a zoomable map, group them into colored **layers** (one per coverage area), mark each layer's **origin**, and share a live board with your team. Flat-black console over real map tiles, no build step.

Live: https://iafahim.github.io/state-county-picker/

## What's new

- **Real map tiles** — OpenStreetMap streets, USGS satellite, or dark, mesh-warped into the map's Albers-USA projection so tiles and county fills sit in register.
- **Gap finder (`G`)** — amber-hatches every county covered by no layer, with a count and a jump-to list. The uncovered-market view.
- **Overlap conflicts (`X`)** — lists every county claimed by two or more layers (who disputes what, where).
- **Leaner console** — the default screen is map + layers + one status line; the keyboard reference hides behind `?`.
- **Clean names** — `Bexar · TX` everywhere; CSV keeps the legal name with FIPS as its own column. Import still accepts pasted FIPS codes.
- **Always-on labels** — state pills at national zoom, suffix-free county pills as you zoom in (layered counties colored, gaps amber). No hovering needed.
- **Map-first layout** — the console chrome collapsed to a 44px drawer edge; the map owns ~89% of the screen.

## Using it

- **Click** a county to add it to the active layer. **Middle-click** (or the Origin button, or `O`) marks where the vendor lives, shown as a star.
- **Layers**: one per coverage area, each with its own color. Several vendors can share one layer's area. Where layers overlap, the county is striped in each color. Keys `1`-`9` switch layers.
- **Shift-drag** adds an area, **Alt-drag** removes. Scroll to zoom, drag to pan, arrow keys pan.
- **Copy list / Copy CSV** export every layer (origin, counties, whole states). **Import** takes names, FIPS codes or that CSV.
- **Boards**: type a name to open or create `/name` (anyone with the link edits, live). Tick **Lock** for `/l/name`, which needs a password to open or create. You see everyone's cursor, what they are pointing at, and what they add.

## How it works

- `index.html` + `counties.js`: the whole front end (canvas map, Census boundaries from us-atlas 3.0.1). Without a board it runs fully offline and saves to the browser.
- `404.html`: GitHub Pages has no routing, so `/name` and `/l/name` are sent back to the app.
- `api/index.mjs`: a Neon Function (no dependencies). It is the only thing that touches the database, which holds boards, layers, items, presence and activity. Passwords are hashed with scrypt, locked boards use short-lived signed tokens, writes are rate limited and only this site's origin may call it.
- `serve.py`: local dev server that mimics the Pages routing: `python3 serve.py 8765` then open http://127.0.0.1:8765/.

## Deploying the API

The function expects `TOKEN_SECRET` (a long random string) in its environment; `DATABASE_URL` is injected by Neon. Zip `api/index.mjs` as `index.mjs` and deploy it with `neon functions deploy boards`, then put its URL in `API` near the top of the boards section in `index.html`.
