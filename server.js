import dotenv from 'dotenv';
dotenv.config({ override: true });
import express from 'express';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.static(join(__dirname, 'public')));
const port = 3126;

function slugToSubreddit(slug) {
  return slug.replace(/-/g, '');
}

function slugToQuery(slug) {
  return slug.replace(/-/g, ' ');
}

// ── Wikipedia og:image cache (permanent, neighborhood images don't change) ──
const wikiImageCache = new Map();

async function fetchWikiImage(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  if (wikiImageCache.has(displayName)) return wikiImageCache.get(displayName);

  for (const query of [`${displayName}, Queens`, displayName]) {
    try {
      const resp = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
      if (!resp.ok) continue;
      const data = await resp.json();
      const url = data.originalimage?.source || data.thumbnail?.source || '';
      if (url) {
        wikiImageCache.set(displayName, url);
        return url;
      }
    } catch { /* try next */ }
  }
  wikiImageCache.set(displayName, '');
  return '';
}

// ── Source caching (5 min TTL) ──
const SOURCE_TTL = 5 * 60 * 1000;
const sourceCache = new Map();

function getCached(key) {
  const c = sourceCache.get(key);
  if (c && Date.now() - c.ts < SOURCE_TTL) return c.data;
  return null;
}
function setCache(key, data) {
  sourceCache.set(key, { data, ts: Date.now() });
}

// ── Geocode caching (persistent to disk) ──
const GEOCODE_CACHE_FILE = new URL('geocode-cache.json', import.meta.url).pathname;
const resolvedCache = new Map(); // address|neighborhood → { result, ts }
const NULL_TTL = 24 * 60 * 60 * 1000; // retry failed lookups after 24h
let cacheDirty = false;

try {
  if (existsSync(GEOCODE_CACHE_FILE)) {
    const data = JSON.parse(readFileSync(GEOCODE_CACHE_FILE, 'utf8'));
    let migrated = 0;
    for (const [k, v] of Object.entries(data)) {
      // Migrate old format (bare value) → new format ({ result, ts })
      if (v === null || (v && v.lat !== undefined && v.ts === undefined)) {
        resolvedCache.set(k, { result: v, ts: Date.now() });
        migrated++;
      } else {
        resolvedCache.set(k, v);
      }
    }
    if (migrated > 0) cacheDirty = true;
    console.log(`Loaded ${resolvedCache.size} cached geocode results${migrated ? ` (migrated ${migrated})` : ''}`);
  }
} catch { /* start fresh */ }

function saveResolvedCache() {
  if (!cacheDirty) return;
  try {
    writeFileSync(GEOCODE_CACHE_FILE, JSON.stringify(Object.fromEntries(resolvedCache)));
    cacheDirty = false;
  } catch { /* ignore */ }
}

setInterval(saveResolvedCache, 30_000);
process.on('SIGTERM', saveResolvedCache);
process.on('SIGINT', () => { saveResolvedCache(); process.exit(); });

// ── Address extraction ──
const STREET_SUFFIX = '(?:Street|St\\.?|Avenue|Ave\\.?|Boulevard|Blvd\\.?|Place|Pl\\.?|Road|Rd\\.?|Drive|Dr\\.?|Way|Court|Ct\\.?|Lane|Ln\\.?|Plaza|Broadway|Parkway|Pkwy\\.?)';
const STREET_SUFFIXES = new RegExp(STREET_SUFFIX + '(?:\\s|,|$)', 'i');
const INTERSECTION_RE = new RegExp('(\\d+\\w*\\s+' + STREET_SUFFIX + ')\\s+(?:and|&|at)\\s+(\\d+\\w*\\s+' + STREET_SUFFIX + ')', 'i');
const INTERSECTION_RE2 = new RegExp('([A-Z][a-z]+)\\s+(?:and|&)\\s+(\\d+\\w*\\s+' + STREET_SUFFIX + ')', 'i');

// Words that should never appear between a house number and a street suffix
const NON_STREET_WORD = /\b(?:for|the|an?|allegedly|reportedly|apparently|about|with|from|into|onto|over|under|just|only|also|even|still|that|this|were?|was|has|had|have|been|being|after|before|during|while)\b/i;

function extractAddress(text) {
  if (!text) return '';
  const ix = INTERSECTION_RE.exec(text);
  if (ix) return (ix[1] + ' and ' + ix[2]).trim();
  const ix2 = INTERSECTION_RE2.exec(text);
  if (ix2) return (ix2[1] + ' and ' + ix2[2]).trim();
  const suffixMatch = STREET_SUFFIXES.exec(text);
  if (!suffixMatch) return '';
  const before = text.substring(0, suffixMatch.index + suffixMatch[0].length);
  const m = before.match(new RegExp('(\\d+[-–]?\\d*\\s+(?:[NSEW]\\.\\s+)?(?:[\\w]+\\s+){0,4}' + STREET_SUFFIX + ')', 'i'));
  if (!m) return '';
  // Reject if the "street name" part contains common non-street words
  const addr = m[1].trim();
  const namePart = addr.replace(/^\d+[-–]?\d*\s+/, '').replace(new RegExp(STREET_SUFFIX + '$', 'i'), '').trim();
  if (namePart && NON_STREET_WORD.test(namePart)) return '';
  return addr;
}

// ── Geocoding ──
// Regular addresses → NYC GeoSearch (free, no API key)
// Intersections → Claude Haiku (LLM knows NYC geography)
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

async function geocodeAddress(address, neighborhood) {
  const searchText = neighborhood ? `${address}, ${neighborhood}` : address;
  try {
    const resp = await fetch(`https://geosearch.planninglabs.nyc/v2/search?text=${encodeURIComponent(searchText)}&size=1`);
    const data = await resp.json();
    const feature = data.features?.[0];
    return feature
      ? { lat: feature.geometry.coordinates[1], lng: feature.geometry.coordinates[0] }
      : null;
  } catch { return null; }
}

async function geocodeIntersection(address, neighborhood) {
  if (!ANTHROPIC_API_KEY) return null;
  const location = neighborhood
    ? `${address} in ${neighborhood}, Queens, NY`
    : `${address}, Queens, NY`;
  try {
    // Ask LLM for a real nearby address, then geocode it precisely
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-3-haiku-20240307',
        max_tokens: 40,
        messages: [{
          role: 'user',
          content: `Give me a real street address at or very near the intersection of ${location}. Reply with ONLY the address, nothing else.`,
        }],
      }),
    });
    const data = await resp.json();
    const nearbyAddr = data.content?.[0]?.text?.trim();
    if (!nearbyAddr) return null;
    // Geocode the LLM-suggested address with NYC GeoSearch for precision
    return await geocodeAddress(nearbyAddr, '');
  } catch { return null; }
}

const inflight = new Map(); // dedup concurrent geocode requests

async function resolveGeocode(address, neighborhood) {
  if (!address) return null;
  const rkey = `${address}|${neighborhood}`;

  // Check cache (with TTL for null results)
  const cached = resolvedCache.get(rkey);
  if (cached) {
    if (cached.result !== null) return cached.result;           // positive hit — never expires
    if (Date.now() - cached.ts < NULL_TTL) return null;        // negative hit — still fresh
    // else: negative hit expired, fall through to re-geocode
  }

  // Dedup: if another request is already geocoding this address, wait for it
  if (inflight.has(rkey)) return inflight.get(rkey);

  const promise = (async () => {
    const isIntersection = /\band\b/i.test(address);
    const result = isIntersection
      ? await geocodeIntersection(address, neighborhood)
      : await geocodeAddress(address, neighborhood);

    resolvedCache.set(rkey, { result, ts: Date.now() });
    cacheDirty = true;
    inflight.delete(rkey);
    return result;
  })();

  inflight.set(rkey, promise);
  return promise;
}

function getCachedGeocode(address, neighborhood) {
  if (!address) return null;
  const rkey = `${address}|${neighborhood}`;
  const cached = resolvedCache.get(rkey);
  if (!cached) return undefined;                                // never looked up
  if (cached.result !== null) return cached.result;             // positive hit
  if (Date.now() - cached.ts < NULL_TTL) return null;          // negative hit, still fresh
  return undefined;                                             // negative hit expired — treat as uncached
}

// ── HTML helpers ──
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', lsquo: '\u2018', rsquo: '\u2019',
  ldquo: '\u201C', rdquo: '\u201D', hellip: '…', bull: '•',
  copy: '©', reg: '®', trade: '™', '#39': "'",
};

function decodeHtmlEntities(str) {
  return str
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&([a-z#0-9]+);/gi, (m, name) => NAMED_ENTITIES[name] ?? NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function upgradeQnsImage(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('w', '900');
    u.searchParams.set('quality', '80');
    u.searchParams.delete('resize');
    return u.toString();
  } catch { return url; }
}

function upgradeYimbyImage(url) {
  return url.replace(/-\d+x\d+(\.\w+)$/, '$1');
}

// ── Source fetchers (with caching) ──
async function fetchReddit(slug) {
  const key = `reddit:${slug}`;
  const cached = getCached(key);
  if (cached) return cached;

  const sub = slugToSubreddit(slug);
  const resp = await fetch(`https://www.reddit.com/r/${sub}/.rss`, {
    headers: { 'User-Agent': 'web:local-news-reader:v1.0 (by /u/local-news-aggregator)' }
  });
  const xml = await resp.text();
  const posts = [];
  const entryRegex = /<entry>[\s\S]*?<\/entry>/gi;
  let match;
  while ((match = entryRegex.exec(xml)) !== null) {
    const entry = match[0];
    const title = decodeHtmlEntities(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || '');
    const link = entry.match(/<link[^>]*href="([^"]*)"[^>]*\/>/)?.[1] || '';
    const updated = entry.match(/<updated>([\s\S]*?)<\/updated>/)?.[1] || '';
    const content = entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1] || '';
    let image = '';
    const imgMatch = content.match(/&lt;img\s[^&]*src=&quot;([^&]*)&quot;/i)
      || content.match(/<img[^>]*src="([^"]*)"[^>]*/i);
    if (imgMatch) image = decodeHtmlEntities(imgMatch[1]);
    const thumbMatch = entry.match(/<media:thumbnail[^>]*url="([^"]*)"/);
    if (thumbMatch) image = decodeHtmlEntities(thumbMatch[1]);
    if (image && image.includes('preview.redd.it') && !image.includes('external-preview')) {
      const path = image.split('?')[0].replace('https://preview.redd.it/', '');
      image = 'https://i.redd.it/' + path;
    }
    const decoded = decodeHtmlEntities(decodeHtmlEntities(content));
    const mdMatch = decoded.match(/<div class="md">([\s\S]*?)<\/div>/);
    const body = mdMatch ? mdMatch[1] : decoded;
    const excerpt = body
      .replace(/<[^>]*>/g, ' ')
      .replace(/submitted by\s+.*$/i, '')
      .replace(/\[link\]|\[comments\]/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200);
    const created = updated ? Math.floor(new Date(updated).getTime() / 1000) : 0;
    const address = extractAddress(title) || extractAddress(excerpt);
    posts.push({ title, url: link, created, image, excerpt, source: 'reddit', flair: '', address });
  }
  if (posts.length > 0) setCache(key, posts);
  return posts;
}

async function fetchQns(slug) {
  const key = `qns:${slug}`;
  const cached = getCached(key);
  if (cached) return cached;

  const resp = await fetch(`https://qns.com/neighborhoods/${slug}/feed/`, {
    headers: { 'User-Agent': 'local-news-reader/1.0' }
  });
  const xml = await resp.text();
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/i);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const descMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i);
    const imgMatch = block.match(/<media:content[^>]*url="([^"]*)"[^>]*/i);
    if (titleMatch && linkMatch) {
      let timestamp = 0;
      if (pubDateMatch) {
        const parsed = new Date(pubDateMatch[1].trim());
        if (!isNaN(parsed)) timestamp = Math.floor(parsed.getTime() / 1000);
      }
      let excerpt = '';
      if (descMatch) {
        excerpt = decodeHtmlEntities(descMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
        if (excerpt.length > 200) excerpt = excerpt.substring(0, 200) + '…';
      }
      const rawImg = imgMatch ? decodeHtmlEntities(imgMatch[1]) : '';
      const t = decodeHtmlEntities(titleMatch[1].trim());
      const address = extractAddress(t) || extractAddress(excerpt);
      articles.push({
        title: t,
        url: linkMatch[1].trim(),
        created: timestamp,
        image: rawImg ? upgradeQnsImage(rawImg) : '',
        excerpt,
        source: 'qns',
        address,
      });
    }
  }
  if (articles.length > 0) setCache(key, articles);
  return articles;
}

async function fetchYimby(slug) {
  const key = `yimby:${slug}`;
  const cached = getCached(key);
  if (cached) return cached;

  const query = slugToQuery(slug);
  const resp = await fetch(`https://newyorkyimby.com/?s=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': 'local-news-reader/1.0' }
  });
  const html = await resp.text();
  const articles = [];
  const regex = /<article[^>]*>[\s\S]*?<\/article>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    const block = match[0];
    const titleMatch = block.match(/<h[23][^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
    const dateMatch = block.match(/<time[^>]*datetime="([^"]*)"[^>]*>([\s\S]*?)<\/time>/i)
      || block.match(/<span[^>]*date[^>]*>([\s\S]*?)<\/span>/i);
    const imgMatch = block.match(/<img[^>]*src="([^"]*)"[^>]*/i);
    const excerptMatch = block.match(/<div class="content-list-excerpt"[^>]*>([\s\S]*?)<\/div>/i);
    if (titleMatch) {
      const rawDate = dateMatch ? (dateMatch[2] || dateMatch[1]).replace(/<[^>]*>/g, '').trim() : '';
      let timestamp = 0;
      if (dateMatch && dateMatch[1]) {
        const parsed = new Date(dateMatch[1]);
        if (!isNaN(parsed)) timestamp = Math.floor(parsed.getTime() / 1000);
      }
      if (!timestamp && rawDate) {
        const cleaned = rawDate.replace(/^\d+:\d+\s*(am|pm)\s+on\s+/i, '');
        const parsed = new Date(cleaned);
        if (!isNaN(parsed)) timestamp = Math.floor(parsed.getTime() / 1000);
      }
      let excerpt = '';
      if (excerptMatch) {
        excerpt = excerptMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
        if (excerpt.length > 200) excerpt = excerpt.substring(0, 200) + '…';
      }
      const t = decodeHtmlEntities(titleMatch[2].replace(/<[^>]*>/g, '').trim());
      if (excerpt) excerpt = decodeHtmlEntities(excerpt);
      const address = extractAddress(t) || extractAddress(excerpt);
      articles.push({
        title: t,
        url: titleMatch[1],
        created: timestamp,
        image: imgMatch ? upgradeYimbyImage(imgMatch[1]) : '',
        excerpt,
        source: 'yimby',
        address,
      });
    }
  }
  if (articles.length > 0) setCache(key, articles);
  return articles;
}

// ── Combined feed endpoint (single request from frontend) ──
app.get('/api/:neighborhood/feed', async (req, res) => {
  const slug = req.params.neighborhood;
  const neighborhood = slug.replace(/-/g, ' ').trim();

  try {
    const [reddit, qns, yimby] = await Promise.allSettled([
      fetchReddit(slug),
      fetchQns(slug),
      fetchYimby(slug),
    ]);

    const items = [
      ...(reddit.status === 'fulfilled' ? reddit.value : []),
      ...(qns.status === 'fulfilled' ? qns.value : []),
      ...(yimby.status === 'fulfilled' ? yimby.value : []),
    ];

    items.sort((a, b) => (b.created || 0) - (a.created || 0));

    // Attach cached geocode results (non-blocking)
    const uncached = [];
    for (const item of items) {
      if (!item.address) continue;
      const geo = getCachedGeocode(item.address, neighborhood);
      if (geo === undefined) {
        uncached.push(item.address);
      } else if (geo) {
        item.lat = geo.lat;
        item.lng = geo.lng;
      }
      // geo === null means "looked up, not found" — no lat/lng
    }

    // Fire-and-forget: geocode uncached addresses in background
    if (uncached.length > 0) {
      (async () => {
        for (const addr of uncached) {
          try { await resolveGeocode(addr, neighborhood); } catch { /* skip */ }
        }
        saveResolvedCache();
      })();
    }

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message, items: [] });
  }
});

// Keep /api/geocode for edge cases
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  const neighborhood = (req.query.neighborhood || '').replace(/-/g, ' ').trim();
  if (!q) return res.json({ lat: null, lng: null });
  const result = await resolveGeocode(q, neighborhood);
  res.json(result || { lat: null, lng: null });
});

app.get('/manifest.json', (req, res) => {
  const startUrl = req.query.start || '/';
  const displayName = startUrl === '/' ? 'Local News Reader'
    : 'Local news in ' + startUrl.replace(/^\//, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  res.json({
    name: displayName,
    short_name: displayName,
    description: 'Queens neighborhood news',
    start_url: startUrl,
    display: 'standalone',
    background_color: '#f5f5f5',
    theme_color: '#f5f5f5',
    icons: [{ src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png' }]
  });
});

// ── Pages ──
app.get('/', (req, res) => {
  res.send(getHomePage());
});

app.get('/:neighborhood', async (req, res) => {
  const slug = req.params.neighborhood;
  if (slug === 'favicon.ico') return res.status(404).end();
  const ogImage = await fetchWikiImage(slug);
  res.send(getNeighborhoodPage(slug, ogImage));
});

app.get('/:neighborhood/settings', (req, res) => {
  const slug = req.params.neighborhood;
  if (req.query.partial) return res.send(getSettingsPartial(slug));
  res.send(getSettingsPage(slug));
});

function getHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="theme-color" content="#f5f5f5">
  <link rel="manifest" href="/manifest.json">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📰</text></svg>">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)" href="/splash-640x1136.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" href="/splash-750x1334.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1242x2208.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1125x2436.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)" href="/splash-828x1792.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1242x2688.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1170x2532.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1284x2778.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1179x2556.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1290x2796.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1206x2622.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1320x2868.png">
  <title>Local News Reader</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lora:wght@600;700&display=swap" rel="stylesheet">
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <h1>Local News Reader</h1>
    <p>Queens neighborhood news from Reddit, QNS, and YIMBY.</p>
    <div class="hood-grid">
      <a href="/long-island-city">Long Island City</a>
      <a href="/astoria">Astoria</a>
      <a href="/jackson-heights">Jackson Heights</a>
      <a href="/flushing">Flushing</a>
      <a href="/sunnyside">Sunnyside</a>
      <a href="/forest-hills">Forest Hills</a>
      <a href="/ridgewood">Ridgewood</a>
      <a href="/jamaica">Jamaica</a>
    </div>
  </div>
</body>
</html>`;
}

function getNeighborhoodPage(slug, ogImage = '') {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="Local news in ${displayName}">
  <meta name="theme-color" content="#f5f5f5">
  <link rel="manifest" href="/manifest.json?start=/${slug}">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📰</text></svg>">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2)" href="/splash-640x1136.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2)" href="/splash-750x1334.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1242x2208.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1125x2436.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2)" href="/splash-828x1792.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1242x2688.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1170x2532.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1284x2778.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1179x2556.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1290x2796.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1206x2622.png">
  <link rel="apple-touch-startup-image" media="screen and (device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3)" href="/splash-1320x2868.png">
  <title>Local news in ${displayName}</title>
  <meta property="og:title" content="Local news in ${displayName}">
  ${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
  <meta property="og:type" content="website">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lora:wght@600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <div id="page-feed">
      <header>
        <h1>${displayName}</h1>
        <div class="filter-tabs">
          <button class="filter-tab active" data-source="all">All</button>
          <button class="filter-tab" data-source="reddit">Reddit</button>
          <button class="filter-tab" data-source="qns">QNS</button>
          <button class="filter-tab" data-source="yimby">YIMBY</button>
          <button type="button" class="settings-link" aria-label="Settings">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
          </button>
        </div>
      </header>
      <div class="feed-container">
        <div id="loading" class="loading"><div class="spinner"></div></div>
        <ul id="feed" class="post-list"></ul>
      </div>
    </div>

    <div id="page-settings" style="display:none">
      <header>
        <button type="button" class="back">&larr; ${displayName}</button>
        <h1>Settings</h1>
      </header>
      <div class="settings-list">
        <div class="settings-row" id="crimeRow">
          <div class="settings-label">
            <span class="settings-title">Show crime stories</span>
            <span class="settings-desc">Include articles about crime, police, and arrests</span>
          </div>
          <div class="ios-toggle" id="crimeToggle"><div class="ios-knob"></div></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    const SLUG = '${slug}';
    const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
    document.addEventListener('touchstart', function() {}, { passive: true });
    const CRIME_KEYWORDS = ['crime', 'shooting', 'stabbing', 'robbery', 'assault', 'murder', 'arrest', 'theft', 'burglary', 'homicide', 'nypd', 'police', 'suspect', 'victim', 'fatal'];

    function preloadThumb(src) {
      return new Promise(function(resolve) {
        var img = new Image();
        img.onload = function() { resolve(img); };
        img.onerror = function() { resolve(null); };
        img.src = src;
      });
    }

    function isCrime(text) {
      const lower = text.toLowerCase();
      return CRIME_KEYWORDS.some(k => lower.includes(k));
    }

    function showCrime() { return localStorage.getItem('showCrime') === '1'; }

    let activeSource = 'all';

    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelector('.filter-tab.active').classList.remove('active');
        tab.classList.add('active');
        activeSource = tab.dataset.source;
        filterFeed();
      });
    });

    function filterFeed() {
      document.querySelectorAll('.post-item').forEach(el => {
        const sourceHidden = activeSource !== 'all' && el.dataset.source !== activeSource;
        const crimeHidden = el.dataset.crime === 'true' && !showCrime();
        el.style.display = (sourceHidden || crimeHidden) ? 'none' : '';
      });
    }

    const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    function timeAgo(epoch) {
      if (!epoch) return '';
      const now = Date.now();
      const diff = now / 1000 - epoch;
      if (diff < 0) return '';
      const m = Math.floor(diff / 60);
      if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
      const h = Math.floor(diff / 3600);
      if (h < 8) return h + (h === 1 ? ' hour ago' : ' hours ago');
      const d = new Date(epoch * 1000);
      const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const today = new Date(now);
      // "Today" / "Yesterday" / day-of-week within 7 days / full date beyond
      const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
      const daysAgo = Math.floor((startOfToday - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
      if (daysAgo === 0) return 'Today at ' + time;
      if (daysAgo === 1) return 'Yesterday at ' + time;
      if (daysAgo < 7) return DAYS[d.getDay()] + ' at ' + time;
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' at ' + time;
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    const retina = window.devicePixelRatio > 1 ? '@2x' : '';
    const tileUrl = 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}' + retina + '.png';
    const mapOpts = { zoomControl: false, scrollWheelZoom: false, dragging: false, touchZoom: false, doubleClickZoom: false, boxZoom: false, keyboard: false, attributionControl: false };
    const dotOpts = { radius: 7, color: '#000', fillColor: '#000', fillOpacity: 1, weight: 0 };

    function initMap(id, lat, lng) {
      const map = L.map(id, mapOpts).setView([lat, lng], 15);
      L.tileLayer(tileUrl, { maxZoom: 19 }).addTo(map);
      L.circleMarker([lat, lng], dotOpts).addTo(map);
    }

    const feedStart = Date.now();

    async function renderFeed(items) {
      const loadingEl = document.getElementById('loading');
      const ul = document.getElementById('feed');

      if (!items.length) {
        ul.innerHTML = '<li class="empty">No articles found</li>';
        loadingEl.remove();
        return;
      }

      // Preload all images first
      const imgPromises = items.map(item => item.image ? preloadThumb(item.image) : Promise.resolve(null));
      const loadedImages = await Promise.all(imgPromises);
      const fast = Date.now() - feedStart < 500;

      const pending = []; // items with address but no coords yet

      items.forEach((item, i) => {
        const crime = isCrime(item.title + ' ' + (item.flair || '') + ' ' + (item.excerpt || ''));
        const li = document.createElement('li');
        li.className = 'post-item';
        li.dataset.crime = crime;
        li.dataset.source = item.source;
        const sourceHidden = activeSource !== 'all' && item.source !== activeSource;
        if ((crime && !showCrime()) || sourceHidden) li.style.display = 'none';

        const date = item.created ? timeAgo(item.created) : '';
        const sourceLabel = { reddit: 'Reddit', qns: 'QNS', yimby: 'YIMBY' }[item.source] || '';

        const mapId = 'map-' + i;
        const hasCoords = item.lat && item.lng;
        const hasAddress = !!item.address;
        const hasMap = hasCoords || hasAddress;
        const mapHtml = hasCoords ? '<div class="card-map" id="' + mapId + '"></div>'
          : hasAddress ? '<div class="card-map-placeholder" id="' + mapId + '" data-address="' + esc(item.address) + '"></div>'
          : '';
        const bottomHtml = (!item.image && hasMap) ? mapHtml : '';

        // Build image HTML with preloaded dimensions
        let topHtml = '';
        const img = loadedImages[i];
        if (img) {
          img.className = 'thumb';
          img.style.aspectRatio = img.naturalWidth + '/' + img.naturalHeight;
          if (hasMap) {
            topHtml = '<div class="media-row"><div class="thumb-slot"></div>' + mapHtml + '</div>';
          } else {
            topHtml = '<div class="thumb-slot"></div>';
          }
        }

        li.innerHTML = topHtml +
          '<a href="' + esc(item.url) + '"' + (isMobile ? '' : ' target="_blank"') + ' class="post-title">' + esc(item.title) + '</a>' +
          (item.excerpt ? '<p class="excerpt">' + esc(item.excerpt) + '</p>' : '') +
          '<span class="meta">' + sourceLabel + (date ? ' &middot; ' + date : '') + '</span>' +
          bottomHtml;

        // Replace placeholder with actual preloaded img element
        const slot = li.querySelector('.thumb-slot');
        if (slot && img) slot.replaceWith(img);

        li.dataset.href = item.url;
        li.addEventListener('click', function(e) {
          if (e.target.closest('.card-map, .card-map-placeholder')) return;
          if (isMobile) { location.href = this.dataset.href; } else { window.open(this.dataset.href, '_blank'); }
        });

        ul.appendChild(li);

        if (hasCoords) {
          initMap(mapId, item.lat, item.lng);
        } else if (hasAddress) {
          pending.push({ mapId, address: item.address });
        }
      });

      // Remove loading text and show cards
      loadingEl.remove();
      if (fast) {
        ul.querySelectorAll('.post-item').forEach(li => { li.style.opacity = '1'; li.style.transition = 'none'; });
      } else {
        requestAnimationFrame(() => {
          ul.querySelectorAll('.post-item').forEach(li => li.classList.add('visible'));
          setTimeout(() => {
            ul.querySelectorAll('.post-item').forEach(li => { li.style.opacity = '1'; li.style.transition = 'none'; });
          }, 300);
        });
      }

      // Lazily geocode uncached addresses and render maps as they resolve
      pending.forEach(({ mapId, address }) => {
        fetch('/api/geocode?q=' + encodeURIComponent(address) + '&neighborhood=' + SLUG)
          .then(r => r.json())
          .then(geo => {
            const el = document.getElementById(mapId);
            if (!el || !geo.lat || !geo.lng) {
              if (el) {
                const row = el.closest('.media-row');
                if (row) { const img = row.querySelector('.thumb'); if (img) row.parentNode.insertBefore(img, row); row.remove(); }
                else el.remove();
              }
              return;
            }
            el.className = 'card-map';
            el.classList.remove('card-map-placeholder');
            initMap(mapId, geo.lat, geo.lng);
          })
          .catch(() => {
            const el = document.getElementById(mapId);
            if (el) {
              const row = el.closest('.media-row');
              if (row) { const img = row.querySelector('.thumb'); if (img) row.parentNode.insertBefore(img, row); row.remove(); }
              else el.remove();
            }
          });
      });
    }

    fetch('/api/' + SLUG + '/feed')
      .then(r => r.json())
      .then(renderFeed)
      .catch(() => {
        document.getElementById('loading').innerHTML = '<span style="color:#999;font-size:15px">Failed to load news</span>';
      });

    // Instant settings navigation — toggle visibility, no DOM destruction
    const pageFeed = document.getElementById('page-feed');
    const pageSettings = document.getElementById('page-settings');
    const DISPLAY = SLUG.replace(/-/g, ' ').replace(/\\b\\w/g, c => c.toUpperCase());

    // Init toggle once since it's always in the DOM
    const toggle = document.getElementById('crimeToggle');
    if (localStorage.getItem('showCrime') === '1') toggle.classList.add('on');
    toggle.addEventListener('click', () => {
      const isOn = toggle.classList.toggle('on');
      localStorage.setItem('showCrime', isOn ? '1' : '0');
    });

    function showSettings() {
      pageFeed.style.display = 'none';
      pageSettings.style.display = '';
      document.title = 'Settings - ' + DISPLAY;
      window.scrollTo(0, 0);
    }

    function showFeed() {
      pageSettings.style.display = 'none';
      pageFeed.style.display = '';
      document.title = DISPLAY;
      filterFeed();
    }

    let navLock = false;
    document.querySelector('.container').addEventListener('click', (e) => {
      if (navLock) return;
      const settings = e.target.closest('.settings-link');
      const back = e.target.closest('.back');
      if (settings) {
        e.preventDefault();
        navLock = true;
        showSettings();
        setTimeout(() => { navLock = false; }, 100);
      } else if (back) {
        e.preventDefault();
        navLock = true;
        showFeed();
        setTimeout(() => { navLock = false; }, 100);
      }
    });
  <\/script>
</body>
</html>`;
}

function getSettingsPage(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📰</text></svg>">
  <title>Settings - ${displayName}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Lora:wght@600;700&display=swap" rel="stylesheet">
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <a href="/${slug}" class="back">&larr; ${displayName}</a>
      <h1>Settings</h1>
    </header>

    <div class="settings-list">
      <div class="settings-row" id="crimeRow">
        <div class="settings-label">
          <span class="settings-title">Show crime stories</span>
          <span class="settings-desc">Include articles about crime, police, and arrests</span>
        </div>
        <div class="ios-toggle" id="crimeToggle"><div class="ios-knob"></div></div>
      </div>
    </div>
  </div>

  <script>
    const toggle = document.getElementById('crimeToggle');
    const on = localStorage.getItem('showCrime') === '1';
    if (on) toggle.classList.add('on');

    toggle.addEventListener('click', () => {
      const isOn = toggle.classList.toggle('on');
      localStorage.setItem('showCrime', isOn ? '1' : '0');
    });

    // Back link uses normal navigation from standalone settings page
  <\/script>
</body>
</html>`;
}

function getSettingsPartial(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  return `
    <header>
      <a href="/${slug}" class="back">&larr; ${displayName}</a>
      <h1>Settings</h1>
    </header>
    <div class="settings-list">
      <div class="settings-row" id="crimeRow">
        <div class="settings-label">
          <span class="settings-title">Show crime stories</span>
          <span class="settings-desc">Include articles about crime, police, and arrests</span>
        </div>
        <div class="ios-toggle" id="crimeToggle"><div class="ios-knob"></div></div>
      </div>
    </div>`;
}

function getStyles() {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; font-size: 15px; background: #f5f5f5; color: #333; touch-action: pan-x pan-y; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }
    .container { max-width: 720px; margin: 0 auto; padding: 24px; }
    header { margin-bottom: 24px; }
    h1 { font-family: 'Lora', Georgia, serif; font-size: 40px; line-height: 1; margin: 0 0 12px; padding: 0; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    h2 a { color: #333; text-decoration: none; }
    a, button { touch-action: manipulation; }
    .ios-toggle { width: 50px; height: 30px; border-radius: 15px; background: #ddd; position: relative; cursor: pointer; transition: background 0.2s; flex-shrink: 0; }
    .ios-toggle.on { background: #333; }
    .ios-knob { width: 26px; height: 26px; border-radius: 13px; background: #fff; position: absolute; top: 2px; left: 2px; transition: transform 0.2s; box-shadow: 0 1px 3px rgba(0,0,0,0.2); }
    .ios-toggle.on .ios-knob { transform: translateX(20px); }
    .settings-link { margin-left: auto; color: #999; padding: 4px; background: none; border: none; cursor: pointer; -webkit-tap-highlight-color: transparent; user-select: none; }
    .settings-link:active { color: #999; }
    .settings-list { max-width: 720px; }
    .settings-row { display: flex; align-items: center; justify-content: space-between; padding: 16px 0; }
    .settings-label { flex: 1; margin-right: 16px; }
    .settings-title { display: block; font-size: 16px; font-weight: 500; color: #333; }
    .settings-desc { display: block; font-size: 13px; color: #999; margin-top: 2px; }
    #page-settings header { margin-top: 0; margin-bottom: 8px; }
    #page-settings h1 { margin-top: 16px; margin-bottom: 0; }
    .back { color: #666; text-decoration: none; font-size: 14px; display: inline-block; margin-bottom: 8px; background: none; border: none; cursor: pointer; padding: 0; font-family: inherit; -webkit-tap-highlight-color: transparent; }
    .back:active { color: #666; }
    .filter-tabs { display: flex; align-items: center; gap: 8px; margin: 20px 0 16px; flex-wrap: wrap; }
    .filter-tab { padding: 6px 16px; border: none; border-radius: 20px; background: #e8e8e8; color: #666; font-family: system-ui, sans-serif; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.15s; }
    .filter-tab.active { background: #333; color: #fff; }
    * { -webkit-tap-highlight-color: transparent; }
    .feed-container { }
    .loading { position: fixed; top: 46%; left: 50%; transform: translate(-50%, -50%); }
    .spinner { width: 48px; height: 48px; border: 4px solid #ddd; border-top-color: #999; border-radius: 50%; animation: spin 0.6s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    .post-list { list-style: none; display: flex; flex-direction: column; gap: 20px; }
    .post-item { padding: 16px; background: #fff; border-radius: 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); cursor: pointer; opacity: 0; transition: opacity 0.3s; }
    .post-item.visible { opacity: 1; }
    .post-title { font-family: 'Lora', Georgia, serif; color: #333; text-decoration: none; font-size: 20px; font-weight: 700; display: block; line-height: 1.3; padding-right: 12px; }
    .meta { font-size: 14px; color: #aaa; margin-top: 6px; display: block; }
    .excerpt { font-size: 15px; color: #666; margin-top: 4px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
    .thumb { width: calc(100% + 32px); margin: -16px -16px 12px -16px; border-radius: 20px 20px 0 0; display: block; background: #f5f5f5; }
    .media-row { display: flex; margin: -16px -16px 12px -16px; gap: 2px; }
    .media-row .thumb { width: 50%; height: 200px; margin: 0; border-radius: 20px 0 0 0; flex-shrink: 0; }
    .media-row .card-map { width: 50%; height: 200px; margin: 0; border-radius: 0 20px 0 0; overflow: hidden; }
    .media-row .card-map .leaflet-container { border-radius: 0 20px 0 0; }
    .media-row .card-map-placeholder { width: 50%; height: 200px; margin: 0; border-radius: 0 20px 0 0; background: #f5f5f5; animation: pulse 1.5s ease-in-out infinite; }
    .card-map { width: calc(100% + 32px); height: 160px; margin: 10px -16px -16px -16px; border-radius: 0 0 20px 20px; overflow: hidden; }
    .card-map .leaflet-container { border-radius: 0 0 20px 20px; }
    .card-map-placeholder { width: calc(100% + 32px); height: 160px; margin: 10px -16px -16px -16px; border-radius: 0 0 20px 20px; background: #f5f5f5; animation: pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.6; } }
    .empty { color: #999; font-size: 14px; padding: 20px 0; }
    .hood-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-top: 20px; }
    .hood-grid a { display: block; padding: 14px 16px; background: #fff; border-radius: 12px; color: #333; text-decoration: none; font-size: 15px; font-weight: 500; box-shadow: 0 2px 8px rgba(0,0,0,0.06); transition: all 0.15s; }
    @media (hover: hover) {
      h2 a:hover { text-decoration: underline; }
      .settings-link:hover { color: #333; }
      .back:hover { color: #333; }
      .filter-tab:not(.active):hover { background: #ddd; }
      @media (hover: hover) { .post-item:hover .post-title { text-decoration: underline; } }
      .post-item:active .post-title { text-decoration: underline; }
      .hood-grid a:hover { background: #333; color: #fff; box-shadow: 0 4px 16px rgba(0,0,0,0.12); }
    }
  `;
}

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
