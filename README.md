# Local News Reader

Identifier: local-news-reader

Created: Wed 25 Feb 2026 11:43:05 PM EST

## Environment

Copy these into a local `.env` (gitignored):

| Variable | Required | Purpose |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | optional | Translating the feed into the reader's phone language, and geocoding intersections, via Claude. Without it the feed is served in English and geocoding falls back to NYC GeoSearch. |
| `TRANSLATION_MODEL` | optional | Claude model used for feed translation. Defaults to `claude-opus-5`. |
| `CARTO_API_KEY` | recommended | CARTO basemap tiles. Without it CARTO returns tiles stamped "API KEY REQUIRED". Free key at <https://carto.com/basemaps/apikey>. |

Map tiles are fetched server-side through `/map-tiles/:z/:x/:y`, so `CARTO_API_KEY`
is never included in the HTML sent to the browser.

## Translation

The app sends the phone's language (`navigator.language`) with every feed
request. English is served as scraped; anything else has each post's title and
excerpt translated with Claude before the response goes out. Translations are
cached on disk in `translation-cache.json` (gitignored) keyed by language and
source text, so a string is only ever sent to Claude once. The feed itself is
still assembled fresh on every request, so new posts always appear; they just
cost one translation call the first time someone in that language loads them.
