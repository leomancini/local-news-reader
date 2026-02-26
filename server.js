import express from 'express';

const app = express();
const port = 3126;

function slugToSubreddit(slug) {
  return slug.replace(/-/g, '');
}

function slugToQuery(slug) {
  return slug.replace(/-/g, ' ');
}

// Address extraction for map pins
const STREET_SUFFIX = '(?:Street|St\\.?|Avenue|Ave\\.?|Boulevard|Blvd\\.?|Place|Pl\\.?|Road|Rd\\.?|Drive|Dr\\.?|Way|Court|Ct\\.?|Lane|Ln\\.?|Plaza|Broadway|Parkway|Pkwy\\.?)';
const STREET_SUFFIXES = new RegExp(STREET_SUFFIX + '(?:\\s|,|$)', 'i');
// Intersection pattern: "41st Ave and 26th St" or "Vernon and 47th Rd"
const INTERSECTION_RE = new RegExp('(\\d+\\w*\\s+' + STREET_SUFFIX + ')\\s+(?:and|&|at)\\s+(\\d+\\w*\\s+' + STREET_SUFFIX + ')', 'i');
// Also match "StreetName and NNth St" like "Vernon and 47th Rd"
const INTERSECTION_RE2 = new RegExp('([A-Z][a-z]+)\\s+(?:and|&)\\s+(\\d+\\w*\\s+' + STREET_SUFFIX + ')', 'i');

function extractAddress(text) {
  if (!text) return '';
  // Try intersection first (e.g. "41st ave and 26th st")
  const ix = INTERSECTION_RE.exec(text);
  if (ix) return (ix[1] + ' and ' + ix[2]).trim();
  const ix2 = INTERSECTION_RE2.exec(text);
  if (ix2) return (ix2[1] + ' and ' + ix2[2]).trim();
  // Then try standard address with house number
  const suffixMatch = STREET_SUFFIXES.exec(text);
  if (!suffixMatch) return '';
  const before = text.substring(0, suffixMatch.index + suffixMatch[0].length);
  const m = before.match(new RegExp('(\\d+[-–]?\\d*\\s+(?:[NSEW]\\.\\s+)?(?:[\\w]+\\s+){0,4}' + STREET_SUFFIX + ')', 'i'));
  return m ? m[1].trim() : '';
}

// Normalize spelled-out street numbers for geocoding (e.g. "Second Street" → "2nd Street")
const ORDINALS = {
  'first':'1st','second':'2nd','third':'3rd','fourth':'4th','fifth':'5th',
  'sixth':'6th','seventh':'7th','eighth':'8th','ninth':'9th','tenth':'10th',
  'eleventh':'11th','twelfth':'12th','thirteenth':'13th','fourteenth':'14th',
  'fifteenth':'15th','sixteenth':'16th','seventeenth':'17th','eighteenth':'18th',
  'nineteenth':'19th','twentieth':'20th',
};
function normalizeStreetName(addr) {
  return addr.replace(/\b([A-Za-z]+)\b(?=\s+(?:Street|St|Avenue|Ave|Place|Pl|Road|Rd|Drive|Dr|Boulevard|Blvd))/i,
    (_, w) => ORDINALS[w.toLowerCase()] || w);
}

// Geocoding with in-memory cache + rate limiting
const geocodeCache = new Map();
let lastGeocode = 0;

async function geocodeAddress(address) {
  if (!address) return null;
  if (geocodeCache.has(address)) return geocodeCache.get(address);

  // Rate limit: 1 req/sec for Nominatim
  const now = Date.now();
  const wait = Math.max(0, 1100 - (now - lastGeocode));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocode = Date.now();

  try {
    const q = encodeURIComponent(address);
    const resp = await fetch(`https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=3`, {
      headers: { 'User-Agent': 'local-news-reader/1.0 (neighborhood news aggregator)' }
    });
    const data = await resp.json();
    // Prefer house/road results, skip area-level matches (quarter, city, etc.)
    const hit = data.find(d => ['house', 'residential', 'tertiary', 'secondary', 'primary', 'road', 'building'].includes(d.type) || d.class === 'building') || data[0];
    const result = hit ? { lat: parseFloat(hit.lat), lng: parseFloat(hit.lon) } : null;
    geocodeCache.set(address, result);
    return result;
  } catch {
    geocodeCache.set(address, null);
    return null;
  }
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// API: Reddit (uses RSS feed — more reliable from servers)
app.get('/api/:neighborhood/reddit', async (req, res) => {
  const sub = slugToSubreddit(req.params.neighborhood);
  try {
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
      // Extract image from content (HTML encoded in RSS)
      let image = '';
      const imgMatch = content.match(/&lt;img\s[^&]*src=&quot;([^&]*)&quot;/i)
        || content.match(/<img[^>]*src="([^"]*)"[^>]*/i);
      if (imgMatch) image = decodeHtmlEntities(imgMatch[1]);
      // Extract thumbnail from media:thumbnail
      const thumbMatch = entry.match(/<media:thumbnail[^>]*url="([^"]*)"/);
      if (thumbMatch) image = decodeHtmlEntities(thumbMatch[1]);
      // Convert preview.redd.it to i.redd.it for full-res images
      if (image && image.includes('preview.redd.it') && !image.includes('external-preview')) {
        const path = image.split('?')[0].replace('https://preview.redd.it/', '');
        image = 'https://i.redd.it/' + path;
      }
      // Extract text excerpt from content — pull from <div class="md"> and strip Reddit boilerplate
      // Double-decode because RSS content is double-encoded (e.g. &amp;#32;)
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
      posts.push({ title, url: link, permalink: link, created, image, excerpt, flair: '', address });
    }
    res.json({ posts, subreddit: sub });
  } catch (e) {
    res.status(500).json({ error: e.message, posts: [] });
  }
});

// API: QNS (RSS feed for accurate timestamps)
app.get('/api/:neighborhood/qns', async (req, res) => {
  const slug = req.params.neighborhood;
  try {
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
          excerpt = descMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          if (excerpt.length > 200) excerpt = excerpt.substring(0, 200) + '…';
        }
        const rawImg = imgMatch ? decodeHtmlEntities(imgMatch[1]) : '';
        const t = decodeHtmlEntities(titleMatch[1].trim());
        const address = extractAddress(t) || extractAddress(excerpt);
        articles.push({
          title: t,
          url: linkMatch[1].trim(),
          timestamp,
          category: '',
          image: rawImg ? upgradeQnsImage(rawImg) : '',
          excerpt,
          address,
        });
      }
    }
    res.json({ articles });
  } catch (e) {
    res.status(500).json({ error: e.message, articles: [] });
  }
});

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
  // Strip WordPress -WxH suffix: image-260x148.jpg → image.jpg
  return url.replace(/-\d+x\d+(\.\w+)$/, '$1');
}

// API: YIMBY
app.get('/api/:neighborhood/yimby', async (req, res) => {
  const query = slugToQuery(req.params.neighborhood);
  try {
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
          // Parse "7:30 am on February 18, 2026" style dates
          const cleaned = rawDate.replace(/^\d+:\d+\s*(am|pm)\s+on\s+/i, '');
          const parsed = new Date(cleaned);
          if (!isNaN(parsed)) timestamp = Math.floor(parsed.getTime() / 1000);
        }
        let excerpt = '';
        if (excerptMatch) {
          excerpt = excerptMatch[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
          if (excerpt.length > 200) excerpt = excerpt.substring(0, 200) + '…';
        }
        const t = titleMatch[2].replace(/<[^>]*>/g, '').trim();
        const address = extractAddress(t) || extractAddress(excerpt);
        articles.push({
          title: t,
          url: titleMatch[1],
          date: rawDate,
          timestamp,
          image: imgMatch ? upgradeYimbyImage(imgMatch[1]) : '',
          excerpt,
          address,
        });
      }
    }
    res.json({ articles });
  } catch (e) {
    res.status(500).json({ error: e.message, articles: [] });
  }
});

// API: Geocode (cached, rate-limited Nominatim proxy)
app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  const neighborhood = (req.query.neighborhood || '').replace(/-/g, ' ').trim();
  if (!q) return res.json({ lat: null, lng: null });

  // For intersections like "41st Ave and 26th St", use the first street
  const isIntersection = /\band\b/i.test(q);
  const baseAddr = isIntersection ? q.split(/\band\b/i)[0].trim() : q;
  const normalized = normalizeStreetName(baseAddr);
  const fullQuery = neighborhood ? `${normalized}, ${neighborhood}, Queens, New York, NY` : normalized;
  let result = await geocodeAddress(fullQuery);
  // Fallback: strip house number and try street + Queens (no neighborhood to avoid matching the area itself)
  if (!result) {
    const streetOnly = normalized.replace(/^\d+[-–]?\d*\s+/, '');
    if (streetOnly !== normalized) {
      result = await geocodeAddress(`${streetOnly}, Queens, NY`);
    }
  }
  res.json(result || { lat: null, lng: null });
});

// Home page
app.get('/', (req, res) => {
  res.send(getHomePage());
});

// Neighborhood page
app.get('/:neighborhood', (req, res) => {
  const slug = req.params.neighborhood;
  if (slug === 'favicon.ico') return res.status(404).end();
  res.send(getNeighborhoodPage(slug));
});

function getHomePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Local News Reader</title>
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <h1>Local News Reader</h1>
    <p>Enter a neighborhood to see aggregated local news.</p>
    <form onsubmit="go(event)">
      <input type="text" id="hood" placeholder="e.g. long-island-city" autofocus>
      <button type="submit">Go</button>
    </form>
    <div class="examples">
      <p>Try:</p>
      <a href="/long-island-city">Long Island City</a>
      <a href="/astoria">Astoria</a>
      <a href="/williamsburg">Williamsburg</a>
      <a href="/bushwick">Bushwick</a>
    </div>
  </div>
  <script>
    function go(e) {
      e.preventDefault();
      const v = document.getElementById('hood').value.trim().toLowerCase().replace(/\\s+/g, '-');
      if (v) window.location.href = '/' + v;
    }
  </script>
</body>
</html>`;
}

function getNeighborhoodPage(slug) {
  const displayName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const subreddit = slugToSubreddit(slug);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${displayName} - Local News</title>
  <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
  <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <a href="/" class="back">&larr; Home</a>
      <h1>${displayName}</h1>
      <div class="filter-tabs">
        <button class="filter-tab active" data-source="all">All</button>
        <button class="filter-tab" data-source="reddit">Reddit</button>
        <button class="filter-tab" data-source="qns">QNS</button>
        <button class="filter-tab" data-source="yimby">YIMBY</button>
      </div>
      <div class="controls-row">
        <div class="crime-toggle">
          <label>
            <input type="checkbox" id="crimeToggle">
            Include crime news
          </label>
        </div>
      </div>
    </header>

    <div class="feed-container">
      <div id="loading" class="loading">Loading news from all sources...</div>
      <ul id="feed" class="post-list"></ul>
    </div>
  </div>

  <script>
    const SLUG = '${slug}';
    const CRIME_KEYWORDS = ['crime', 'shooting', 'stabbing', 'robbery', 'assault', 'murder', 'arrest', 'theft', 'burglary', 'homicide', 'nypd', 'police', 'suspect', 'victim', 'fatal'];

    function isCrime(text) {
      const lower = text.toLowerCase();
      return CRIME_KEYWORDS.some(k => lower.includes(k));
    }

    function showCrime() {
      return document.getElementById('crimeToggle').checked;
    }

    let activeSource = 'all';

    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelector('.filter-tab.active').classList.remove('active');
        tab.classList.add('active');
        activeSource = tab.dataset.source;
        filterFeed();
      });
    });

    document.getElementById('crimeToggle').addEventListener('change', filterFeed);

    function filterFeed() {
      document.querySelectorAll('.post-item').forEach(el => {
        const sourceHidden = activeSource !== 'all' && el.dataset.source !== activeSource;
        const crimeHidden = el.dataset.crime === 'true' && !showCrime();
        el.style.display = (sourceHidden || crimeHidden) ? 'none' : '';
      });
    }

    function timeAgo(epoch) {
      if (!epoch) return '';
      const diff = Date.now() / 1000 - epoch;
      if (diff < 0) return '';
      const m = Math.floor(diff / 60);
      if (m < 60) return m + (m === 1 ? ' minute ago' : ' minutes ago');
      const h = Math.floor(diff / 3600);
      if (h < 8) return h + (h === 1 ? ' hour ago' : ' hours ago');
      return new Date(epoch * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s;
      return d.innerHTML;
    }

    async function fetchAll() {
      const [redditRes, qnsRes, yimbyRes] = await Promise.allSettled([
        fetch('/api/' + SLUG + '/reddit').then(r => r.json()),
        fetch('/api/' + SLUG + '/qns').then(r => r.json()),
        fetch('/api/' + SLUG + '/yimby').then(r => r.json()),
      ]);

      const items = [];

      if (redditRes.status === 'fulfilled') {
        (redditRes.value.posts || []).forEach(p => {
          items.push({
            title: p.title,
            url: p.permalink,
            timestamp: p.created || 0,
            source: 'reddit',
            meta: '',
            flair: p.flair || '',
            excerpt: p.excerpt || '',
            image: p.image || '',
            address: p.address || '',
          });
        });
      }

      if (qnsRes.status === 'fulfilled') {
        (qnsRes.value.articles || []).forEach(a => {
          items.push({
            title: a.title,
            url: a.url,
            timestamp: a.timestamp || 0,
            source: 'qns',
            meta: '',
            flair: '',
            excerpt: a.excerpt || '',
            image: a.image || '',
            address: a.address || '',
          });
        });
      }

      if (yimbyRes.status === 'fulfilled') {
        (yimbyRes.value.articles || []).forEach(a => {
          items.push({
            title: a.title,
            url: a.url,
            timestamp: a.timestamp || 0,
            source: 'yimby',
            meta: a.date || '',
            flair: '',
            excerpt: a.excerpt || '',
            image: a.image || '',
            address: a.address || '',
          });
        });
      }

      // Sort newest first; items without timestamps go to the end
      items.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

      return items;
    }

    function renderFeed(items) {
      document.getElementById('loading').remove();
      const ul = document.getElementById('feed');

      if (!items.length) {
        ul.innerHTML = '<li class="empty">No articles found</li>';
        return;
      }

      const mapTargets = [];

      items.forEach((item, i) => {
        const crime = isCrime(item.title + ' ' + item.flair + ' ' + item.excerpt);
        const li = document.createElement('li');
        li.className = 'post-item';
        li.dataset.crime = crime;
        li.dataset.source = item.source;
        const sourceHidden = activeSource !== 'all' && item.source !== activeSource;
        if ((crime && !showCrime()) || sourceHidden) li.style.display = 'none';

        const date = item.timestamp ? timeAgo(item.timestamp) : '';
        const sourceLabel = { reddit: 'Reddit', qns: 'QNS', yimby: 'YIMBY' }[item.source];

        const mapId = 'map-' + i;
        li.innerHTML =
          (item.image ? '<img src="' + esc(item.image) + '" class="thumb" loading="lazy">' : '') +
          '<a href="' + esc(item.url) + '" target="_blank" class="post-title">' + esc(item.title) + '</a>' +
          (item.excerpt ? '<p class="excerpt">' + esc(item.excerpt) + '</p>' : '') +
          '<span class="meta">' + sourceLabel + (date ? ' &middot; ' + date : '') + '</span>' +
          (item.address ? '<div class="card-map" id="' + mapId + '"></div>' : '');

        ul.appendChild(li);
        if (item.address) mapTargets.push({ id: mapId, address: item.address });
      });

      // Geocode addresses and init maps
      mapTargets.forEach(t => {
        fetch('/api/geocode?q=' + encodeURIComponent(t.address) + '&neighborhood=' + encodeURIComponent(SLUG))
          .then(r => r.json())
          .then(geo => {
            if (!geo.lat || !geo.lng) {
              const el = document.getElementById(t.id);
              if (el) el.remove();
              return;
            }
            const map = L.map(t.id, {
              zoomControl: false,
              scrollWheelZoom: false,
              dragging: false,
              touchZoom: false,
              doubleClickZoom: false,
              boxZoom: false,
              keyboard: false,
              attributionControl: false,
            }).setView([geo.lat, geo.lng], 15);
            L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}' + (window.devicePixelRatio > 1 ? '@2x' : '') + '.png', {
              maxZoom: 19,
            }).addTo(map);
            L.circleMarker([geo.lat, geo.lng], {
              radius: 7, color: '#000', fillColor: '#000', fillOpacity: 1, weight: 0,
            }).addTo(map);
          })
          .catch(() => {
            const el = document.getElementById(t.id);
            if (el) el.remove();
          });
      });
    }

    fetchAll().then(renderFeed).catch(() => {
      document.getElementById('loading').textContent = 'Failed to load news';
    });
  </script>
</body>
</html>`;
}

function getStyles() {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
    header { margin-bottom: 24px; }
    .back { color: #666; text-decoration: none; font-size: 14px; }
    .back:hover { color: #333; }
    h1 { font-size: 28px; margin: 8px 0 12px; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    h2 a { color: #333; text-decoration: none; }
    h2 a:hover { text-decoration: underline; }
    .crime-toggle { margin-bottom: 8px; }
    .crime-toggle label { font-size: 14px; cursor: pointer; display: flex; align-items: center; gap: 6px; }
    .filter-tabs { display: flex; gap: 8px; margin-bottom: 12px; }
    .filter-tab { padding: 6px 16px; border: none; border-radius: 20px; background: #e8e8e8; color: #666; font-size: 14px; cursor: pointer; transition: all 0.15s; }
    .filter-tab:hover { background: #ddd; }
    .filter-tab.active { background: #333; color: #fff; }
    .controls-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 4px; }
    * { -webkit-tap-highlight-color: transparent; }
    .feed-container { max-width: 720px; }
    .loading { color: #999; font-size: 14px; padding: 20px 0; }
    .post-list { list-style: none; display: flex; flex-direction: column; gap: 20px; }
    .post-item { padding: 16px; background: #fff; border-radius: 20px; box-shadow: 0 4px 16px rgba(0,0,0,0.08); }
    .post-title { color: #333; text-decoration: none; font-size: 20px; font-weight: 700; display: block; line-height: 1.3; }
    .post-title:hover { text-decoration: underline; }
    .meta { font-size: 12px; color: #888; margin-top: 6px; display: block; }

    .excerpt { font-size: 13px; color: #666; margin-top: 4px; line-height: 1.4; }
    .thumb { width: calc(100% + 32px); margin: -16px -16px 12px -16px; max-height: 300px; object-fit: cover; border-radius: 20px 20px 0 0; display: block; }
    .card-map { width: calc(100% + 32px); height: 160px; margin: 10px -16px -16px -16px; border-radius: 0 0 20px 20px; overflow: hidden; }
    .card-map .leaflet-container { border-radius: 0 0 20px 20px; }
    .empty { color: #999; font-size: 14px; padding: 20px 0; }
    form { display: flex; gap: 8px; margin: 16px 0; }
    form input { flex: 1; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 16px; }
    form button { padding: 10px 20px; background: #1a73e8; color: #fff; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; }
    form button:hover { background: #1557b0; }
    .examples { margin-top: 16px; }
    .examples p { font-size: 14px; color: #888; margin-bottom: 8px; }
    .examples a { display: inline-block; margin-right: 12px; color: #1a73e8; text-decoration: none; font-size: 14px; }
    .examples a:hover { text-decoration: underline; }
  `;
}

app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
