# Coverage Ops — State & County Picker

Plan vendor coverage on a real map. Pick US counties into colored **layers** (one per
vendor), mark each layer's **origin**, and share a live **board** with your team.
Flat-black console over real map tiles — a single `index.html`, no build step.

Live: https://iafahim.github.io/state-county-picker/

## What it does

- **Coverage layers** — up to 12 layers, each with its own color and key `1`-`9`. Click
  counties (or Shift-drag an area, Alt-drag to remove). Where layers overlap, the county
  is striped in every claiming color.
- **Origins + REACH** — middle-click (or the Origin mode, or `O`) marks where the vendor
  lives as a star. REACH is the signature move: a sonar front expands from that star,
  every covered county ignites in the layer color as it passes, true-mile range rings
  flash, and the farthest county holds a final pulse. It fires when you mark an origin,
  when you switch layers, and on demand with `R`. With reduced motion it renders as a
  static outline + reach ring instead.
- **Gap Finder (`G`)** — hatches every county no layer covers, with a count and a
  jump-to list. Scope switches between *In view* and *All US*.
- **Overlap Conflicts (`X`)** — lists every county claimed by two or more layers, with
  the layer names, and outlines them on the map.
- **Always-on labels** — state pills at national zoom, suffix-free county pills as you
  zoom in (`Bexar`, covered counties colored, gaps amber). No hovering needed; pills
  densify across three zoom tiers.
- **Real tiles in register** — OpenStreetMap streets, USGS satellite, or a dark basemap,
  mesh-warped into the map's Albers-USA projection so tiles and county fills line up
  exactly, at every zoom.
- **Map-first layout** — the console folds into a 44px tool edge on the right; the map
  owns ~90% of the screen. The layers + ledger drawer slides over on demand.
- **Clean names** — the UI never shows County/Parish/Borough suffixes or FIPS codes:
  `Bexar · TX` everywhere. **Copy CSV** keeps the legal name with FIPS as its own
  column; **Import** accepts pasted county names, FIPS codes, whole states, or that CSV.
- **Live boards** — type a name to open or create `/name` (anyone with the link edits,
  live: you see everyone's cursor, what they point at, and what they add). Tick **Lock**
  for `/l/name`, which needs a password to open or create.

## Using it

- **Click** a county to add it to the active layer; **middle-click** marks the origin in
  any mode. **Scroll** to zoom, **drag** to pan, **arrow keys** pan, `+`/`-` zoom, `0`
  home.
- **`/`** search (states, counties, FIPS), **`E`** rename/recolor/delete layers,
  **`?`** full mouse & keyboard reference.
- **Copy list / Copy CSV** export every layer (origin, counties, whole states).
- Without a board, everything saves to the browser.

## How it works

- `index.html` + `counties.js`: the whole front end (canvas map, Census boundaries from
  us-atlas 3.0.1). No dependencies beyond d3/topojson from CDN.
- `404.html`: GitHub Pages has no routing, so `/name` and `/l/name` are sent back to the
  app, which reads the path and opens that board.
- `api/index.mjs`: a Neon Function (no dependencies). It is the only thing that touches
  the database, which holds boards, layers, items, presence and activity. Passwords are
  hashed with scrypt, locked boards use short-lived signed tokens, writes are rate
  limited, and only this site's origin may call it.
- `serve.py`: local dev server that mimics the Pages routing: `python3 serve.py 8765`
  then open http://127.0.0.1:8765/.

## Deploying the API

The function expects `TOKEN_SECRET` (a long random string) in its environment;
`DATABASE_URL` is injected by Neon. Zip `api/index.mjs` as `index.mjs` and deploy it
with `neon functions deploy boards`, then put its URL in `API` near the top of the
boards section in `index.html`.
