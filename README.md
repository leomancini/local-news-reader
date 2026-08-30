# Local News Reader

Identifier: local-news-reader

Created: Wed 25 Feb 2026 11:43:05 PM EST

## Environment

Copy these into a local `.env` (gitignored):

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | optional | Geocoding intersections via Claude. Falls back to NYC GeoSearch when unset. |
| `CARTO_API_KEY` | recommended | CARTO basemap tiles. Without it CARTO returns tiles stamped "API KEY REQUIRED". Free key at <https://carto.com/basemaps/apikey>. |

Map tiles are fetched server-side through `/map-tiles/:z/:x/:y`, so `CARTO_API_KEY`
is never included in the HTML sent to the browser.
