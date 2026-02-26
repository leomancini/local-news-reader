import express from 'express';

const app = express();
const port = 3126;

function slugToSubreddit(slug) {
  return slug.replace(/-/g, '');
}

function slugToQuery(slug) {
  return slug.replace(/-/g, ' ');
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
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
      const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.trim() || '';
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
      const created = updated ? Math.floor(new Date(updated).getTime() / 1000) : 0;
      posts.push({ title, url: link, permalink: link, created, image, score: 0, num_comments: 0, flair: '' });
    }
    res.json({ posts, subreddit: sub });
  } catch (e) {
    res.status(500).json({ error: e.message, posts: [] });
  }
});

// API: QNS
app.get('/api/:neighborhood/qns', async (req, res) => {
  const slug = req.params.neighborhood;
  try {
    const resp = await fetch(`https://qns.com/neighborhoods/${slug}/`, {
      headers: { 'User-Agent': 'local-news-reader/1.0' }
    });
    const html = await resp.text();
    const articles = [];
    const regex = /<article[^>]*>[\s\S]*?<\/article>/gi;
    let match;
    while ((match = regex.exec(html)) !== null) {
      const block = match[0];
      const titleMatch = block.match(/<h[23][^>]*>\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i);
      const imgMatch = block.match(/<img[^>]*src="([^"]*)"[^>]*/i);
      const categoryMatch = block.match(/<a[^>]*href="[^"]*\/news\/([^/"]*)\/"[^>]*>([\s\S]*?)<\/a>/i);
      if (titleMatch) {
        // Extract date from URL pattern like /2026/02/slug
        let timestamp = 0;
        const urlDateMatch = titleMatch[1].match(/\/(\d{4})\/(\d{2})\//);
        if (urlDateMatch) {
          const parsed = new Date(`${urlDateMatch[1]}-${urlDateMatch[2]}-15`);
          if (!isNaN(parsed)) timestamp = Math.floor(parsed.getTime() / 1000);
        }
        articles.push({
          title: titleMatch[2].replace(/<[^>]*>/g, '').trim(),
          url: titleMatch[1],
          timestamp,
          category: categoryMatch ? categoryMatch[2].replace(/<[^>]*>/g, '').trim() : '',
          image: imgMatch ? decodeHtmlEntities(imgMatch[1]) : '',
        });
      }
    }
    res.json({ articles });
  } catch (e) {
    res.status(500).json({ error: e.message, articles: [] });
  }
});

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
        articles.push({
          title: titleMatch[2].replace(/<[^>]*>/g, '').trim(),
          url: titleMatch[1],
          date: rawDate,
          timestamp,
          image: imgMatch ? imgMatch[1] : '',
        });
      }
    }
    res.json({ articles });
  } catch (e) {
    res.status(500).json({ error: e.message, articles: [] });
  }
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
  <style>${getStyles()}</style>
</head>
<body>
  <div class="container">
    <header>
      <a href="/" class="back">&larr; Home</a>
      <h1>${displayName}</h1>
      <div class="header-row">
        <div class="crime-toggle">
          <label>
            <input type="checkbox" id="crimeToggle" checked>
            Include crime news
          </label>
        </div>
        <div class="sources">
          Sources:
          <a href="https://www.reddit.com/r/${subreddit}" target="_blank">r/${subreddit}</a>
          <a href="https://qns.com/neighborhoods/${slug}/" target="_blank">QNS.com</a>
          <a href="https://newyorkyimby.com/neighborhoods/${slug}" target="_blank">YIMBY</a>
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

    document.getElementById('crimeToggle').addEventListener('change', () => {
      document.querySelectorAll('.post-item').forEach(el => {
        if (el.dataset.crime === 'true') {
          el.style.display = showCrime() ? '' : 'none';
        }
      });
    });

    function timeAgo(epoch) {
      if (!epoch) return '';
      const diff = Date.now() / 1000 - epoch;
      if (diff < 0) return '';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
      if (diff < 2592000) return Math.floor(diff / 86400) + 'd ago';
      return new Date(epoch * 1000).toLocaleDateString();
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
            meta: p.score + ' pts · ' + p.num_comments + ' comments',
            flair: p.flair || '',
            excerpt: '',
            image: p.image || '',
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
            flair: a.category || '',
            excerpt: '',
            image: a.image || '',
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
            excerpt: '',
            image: a.image || '',
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

      items.forEach(item => {
        const crime = isCrime(item.title + ' ' + item.flair + ' ' + item.excerpt);
        const li = document.createElement('li');
        li.className = 'post-item';
        li.dataset.crime = crime;
        if (crime && !showCrime()) li.style.display = 'none';

        const time = item.timestamp ? timeAgo(item.timestamp) : '';
        const sourceLabel = { reddit: 'Reddit', qns: 'QNS', yimby: 'YIMBY' }[item.source];

        li.innerHTML =
          (item.image ? '<img src="' + esc(item.image) + '" class="thumb" loading="lazy">' : '') +
          '<a href="' + esc(item.url) + '" target="_blank" class="post-title">' + esc(item.title) + '</a>' +
          '<span class="meta">' +
            '<span class="source-badge source-' + item.source + '">' + sourceLabel + '</span>' +
            (time ? ' · ' + time : '') +
            (item.meta && item.source === 'reddit' ? ' · ' + esc(item.meta) : '') +
          '</span>' +
          (item.flair ? '<span class="flair">' + esc(item.flair) + '</span>' : '') +
          (item.excerpt ? '<p class="excerpt">' + esc(item.excerpt) + '</p>' : '');

        ul.appendChild(li);
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
    .header-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
    .sources { font-size: 13px; color: #888; }
    .sources a { color: #1a73e8; text-decoration: none; margin-left: 8px; }
    .sources a:hover { text-decoration: underline; }
    .feed-container { max-width: 720px; }
    .source-badge { display: inline-block; font-size: 11px; font-weight: 600; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; letter-spacing: 0.3px; }
    .source-reddit { background: #ff45001a; color: #ff4500; }
    .source-qns { background: #0a66c21a; color: #0a66c2; }
    .source-yimby { background: #2e7d321a; color: #2e7d32; }
    .loading { color: #999; font-size: 14px; padding: 20px 0; }
    .post-list { list-style: none; display: flex; flex-direction: column; gap: 12px; }
    .post-item { padding: 14px; background: #fff; border-radius: 8px; box-shadow: 0 1px 4px rgba(0,0,0,0.06); }
    .post-title { color: #1a73e8; text-decoration: none; font-size: 14px; font-weight: 500; display: block; }
    .post-title:hover { text-decoration: underline; }
    .meta { font-size: 12px; color: #888; margin-top: 2px; display: block; }
    .flair { display: inline-block; font-size: 11px; background: #e8f0fe; color: #1a73e8; padding: 1px 6px; border-radius: 4px; margin-top: 4px; }
    .excerpt { font-size: 13px; color: #666; margin-top: 4px; line-height: 1.4; }
    .thumb { width: 100%; max-height: 140px; object-fit: cover; border-radius: 4px; margin-bottom: 6px; }
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
