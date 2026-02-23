const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

const ALLOWED_ORIGINS = [
  'https://civicsentinel2.netlify.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
];

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '10mb' }));

// ─── Rate limiter ───
const rateLimits = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now - record.windowStart > 60000) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= 5) return false;
  record.count++;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimits) {
    if (now - record.windowStart > 120000) rateLimits.delete(ip);
  }
}, 300000);

// ═══════════════════════════════════════════
// TDEC DATA STORE — in-memory, populated by scraper uploads
// ═══════════════════════════════════════════
const tdecStore = {
  complaints: { records: [], lastUpdated: null, statewide: 0 },
  permits: { records: [], lastUpdated: null, statewide: 0 },
  inspections: { records: [], lastUpdated: null, statewide: 0 },
  wells: { records: [], lastUpdated: null, statewide: 0 },
  drillers: { records: [], lastUpdated: null, statewide: 0 }
};

// Upload key — simple auth so only your scraper can push data
const UPLOAD_KEY = process.env.UPLOAD_KEY || 'civicsentinel2026';

// Convert TDEC records to CivicSentinel feed items
function tdecToFeedItems(records, sourceType) {
  return records.map((r, i) => {
    const text = JSON.stringify(r).toLowerCase();
    let category = 'environment';
    if (text.includes('geothermal')) category = 'geothermal';
    else if (/sinkhole|karst|subsidence/.test(text)) category = 'karst_sinkholes';
    else if (/well|groundwater|pump/.test(text)) category = 'water_wells';
    else if (/erosion|sediment|stormwater|construction/.test(text)) category = 'construction';
    else if (/sewage|overflow/.test(text)) category = 'environment';

    let severity = 'medium';
    if (/explosion|contamination|spill|illicit/.test(text)) severity = 'high';
    if (r._priority === 'HIGH') severity = 'high';

    const id = r.ID || r['Permit No'] || r['License No'] || `tdec_${i}`;
    const site = r.Site || r['Site Name'] || r['Site ID'] || '';
    const county = r.County || '';
    const concerning = r.Concerning || r.Status || '';
    const dateStr = r.Received || r.Inspected || r.Issuance || r['Date Completed'] || '';

    return {
      id: `tdec_${sourceType}_${id}`,
      title: concerning ? `TDEC: ${concerning}` : `TDEC ${sourceType}: ${site || id}`,
      summary: [
        site ? `Site: ${site}` : '',
        county ? `County: ${county}` : '',
        r.Status ? `Status: ${r.Status}` : '',
        r['Program Area'] ? `Program: ${r['Program Area']}` : '',
        r['Permit No'] ? `Permit: ${r['Permit No']}` : '',
      ].filter(Boolean).join('. ') + '.',
      source: `TDEC ${sourceType}`,
      url: 'https://dataviewers.tdec.tn.gov/dataviewers/',
      timestamp: dateStr,
      category,
      severity,
      location: county ? `${county} County, TN` : 'Tennessee',
      verified: true,
      verificationNote: 'Official TDEC public record — scraped from government database',
      dataSource: 'tdec_scraper',
      rawRecord: r
    };
  });
}

// ═══════════════════════════════════════════
// TDEC ENDPOINTS
// ═══════════════════════════════════════════

// GET /api/tdec-feed — returns all TDEC data as feed items
app.get('/api/tdec-feed', (req, res) => {
  const county = req.query.county; // optional filter
  const category = req.query.category; // optional filter
  const allItems = [];

  for (const [type, store] of Object.entries(tdecStore)) {
    if (store.records.length > 0) {
      allItems.push(...tdecToFeedItems(store.records, type));
    }
  }

  let filtered = allItems;
  if (county) {
    filtered = filtered.filter(it => it.location.toLowerCase().includes(county.toLowerCase()));
  }
  if (category && category !== 'all') {
    filtered = filtered.filter(it => it.category === category);
  }

  // Sort by date descending
  filtered.sort((a, b) => {
    const da = new Date(a.timestamp || 0);
    const db = new Date(b.timestamp || 0);
    return db - da;
  });

  res.json({
    items: filtered,
    total: filtered.length,
    sources: Object.entries(tdecStore).reduce((acc, [k, v]) => {
      acc[k] = { count: v.records.length, lastUpdated: v.lastUpdated, statewide: v.statewide };
      return acc;
    }, {}),
    lastUpdated: Object.values(tdecStore).map(s => s.lastUpdated).filter(Boolean).sort().pop() || null
  });
});

// GET /api/tdec-stats — quick summary
app.get('/api/tdec-stats', (req, res) => {
  const stats = {};
  let total = 0;
  for (const [type, store] of Object.entries(tdecStore)) {
    stats[type] = { local: store.records.length, statewide: store.statewide, lastUpdated: store.lastUpdated };
    total += store.records.length;
  }
  res.json({ totalLocalRecords: total, datasets: stats });
});

// POST /api/tdec-upload — scraper pushes data here
app.post('/api/tdec-upload', (req, res) => {
  const { key, type, records, statewide } = req.body;

  if (key !== UPLOAD_KEY) {
    return res.status(403).json({ error: 'Invalid upload key' });
  }

  const validTypes = ['complaints', 'permits', 'inspections', 'wells', 'drillers'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: `Invalid type. Use: ${validTypes.join(', ')}` });
  }

  if (!Array.isArray(records)) {
    return res.status(400).json({ error: 'Records must be an array' });
  }

  tdecStore[type] = {
    records: records,
    lastUpdated: new Date().toISOString(),
    statewide: statewide || records.length
  };

  console.log(`[TDEC Upload] ${type}: ${records.length} records (${statewide || '?'} statewide)`);

  res.json({
    success: true,
    type,
    stored: records.length,
    statewide: statewide || records.length
  });
});

// ─── URL verification ───
async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'CivicSentinel/3.0 (community watchdog)' },
      redirect: 'follow'
    });
    clearTimeout(timeout);
    return r.ok || r.status === 403 || r.status === 405;
  } catch {
    try {
      const c2 = new AbortController();
      const t2 = setTimeout(() => c2.abort(), 5000);
      const r2 = await fetch(url, {
        method: 'GET',
        signal: c2.signal,
        headers: { 'User-Agent': 'CivicSentinel/3.0', 'Range': 'bytes=0-0' },
        redirect: 'follow'
      });
      clearTimeout(t2);
      return r2.ok || r2.status === 206 || r2.status === 403;
    } catch { return false; }
  }
}

function extractDomain(url) {
  try { return new URL(url).hostname.replace('www.', ''); }
  catch { return 'Unknown'; }
}

function extractCitations(content) {
  const citations = [];
  for (const block of content) {
    if (block.type === 'web_search_tool_result' && block.content) {
      for (const item of block.content) {
        if (item.type === 'web_search_result') {
          citations.push({
            title: item.title || '',
            url: item.url || '',
            snippet: item.encrypted_content ? '[Content at source]' : (item.page_snippet || ''),
            source: extractDomain(item.url || ''),
            publishedDate: item.page_age || ''
          });
        }
      }
    }
  }
  return citations;
}

// ─── Health check ───
app.get('/', (req, res) => {
  const tdecTotal = Object.values(tdecStore).reduce((s, v) => s + v.records.length, 0);
  res.json({
    service: 'CivicSentinel API',
    status: 'running',
    version: '3.0.0',
    mission: 'Karst Basin Community Watchdog',
    factChecking: 'enabled — all results verified against source URLs',
    tdecRecords: tdecTotal,
    tdecLastUpdated: Object.values(tdecStore).map(s => s.lastUpdated).filter(Boolean).sort().pop() || null
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Main search endpoint (unchanged — web search with fact checking) ───
app.post('/api/search', async (req, res) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server API key not configured.' });
  }

  const { city, topic, category, dateFrom, dateTo, includeSocial } = req.body;
  if (!city || !topic) {
    return res.status(400).json({ error: 'City and topic are required.' });
  }

  let dateClause = '';
  if (dateFrom && dateTo) dateClause = `Only include results from between ${dateFrom} and ${dateTo}.`;
  else if (dateFrom) dateClause = `Only include results from after ${dateFrom}.`;
  else if (dateTo) dateClause = `Only include results from before ${dateTo}.`;

  const catClause = category && category !== 'all' && category !== 'other_custom'
    ? `Focus on: ${category}.` : '';

  const socialClause = includeSocial
    ? `Also search: "site:reddit.com ${city} ${topic}" and "site:twitter.com ${city} ${topic}".` : '';

  const prompt = `Search the web for: ${city} ${topic}

${dateClause}
${catClause}
${socialClause}

CRITICAL ACCURACY RULES:
1. ONLY report stories that appeared in your actual web search results.
2. DO NOT invent, fabricate, combine, or embellish any story.
3. Use the EXACT headline from each article — do not rewrite it.
4. Use the EXACT URL from each search result.
5. The summary must only describe what the article actually says.
6. If you found 0 relevant results, say so. An empty result is correct. A fabricated result is unacceptable.
7. DO NOT create incidents by combining a real place name with an imagined event.
8. If an article is about a different city or topic, DO NOT include it.

Format as JSON array:
[{"title":"EXACT headline","summary":"What the article says, nothing added","source":"publication name","url":"EXACT URL","timestamp":"date from article","category":"karst_sinkholes|geothermal|water_wells|foundation|construction|environment|infrastructure|traffic|waste|education|safety|government|housing|water_sewer|other","severity":"critical|high|medium|low","location":"location from article"}]

If NO results: {"no_results": true, "searched_for": "what you searched"}
Respond with ONLY JSON.`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) {
      return res.status(502).json({ error: data.error.message || 'API error' });
    }

    const allContent = data.content || [];
    const textParts = allContent.filter(b => b.type === 'text').map(b => b.text);
    const searchParts = allContent.filter(b => b.type === 'web_search_tool_result');
    const realCitations = extractCitations(allContent);

    const rawParts = [];
    if (searchParts.length > 0) rawParts.push(`[Web searches performed: ${searchParts.length}]`);
    if (realCitations.length > 0) rawParts.push(`[Source URLs found: ${realCitations.length}]`);
    rawParts.push(...textParts);

    if (realCitations.length > 0) {
      rawParts.push('\n--- VERIFIED SOURCE URLS ---');
      realCitations.forEach((c, i) => {
        rawParts.push(`${i+1}. ${c.title}\n   ${c.url}\n   ${c.source} | ${c.publishedDate || 'Date unknown'}`);
      });
    }

    const fullText = textParts.join('\n');
    const cleaned = fullText.replace(/```json|```/g, '').trim();

    if (cleaned.includes('"no_results"')) {
      return res.json({ items: [], rawResponse: rawParts.join('\n\n'), verifiedSources: realCitations, stats: { totalFound: 0, verified: 0, rejected: 0 } });
    }

    const match = cleaned.match(/\[[\s\S]*\]/);

    if (!match) {
      if (realCitations.length > 0) {
        const items = realCitations.filter(c => c.url && c.title).map((c, i) => ({
          id: `v${Date.now()}_${i}`,
          title: c.title,
          summary: c.snippet || 'Click source link to read the original article.',
          source: c.source,
          url: c.url,
          timestamp: c.publishedDate || 'Recent',
          category: 'other',
          severity: 'medium',
          location: city,
          verified: true,
          verificationNote: 'Direct from web search results'
        }));
        return res.json({ items, rawResponse: rawParts.join('\n\n'), verifiedSources: realCitations, stats: { totalFound: items.length, verified: items.length, rejected: 0 } });
      }
      return res.json({ items: [], rawResponse: rawParts.join('\n\n'), verifiedSources: realCitations, stats: { totalFound: 0, verified: 0, rejected: 0 } });
    }

    try {
      const parsedItems = JSON.parse(match[0]);
      const realUrlSet = new Set();
      for (const c of realCitations) {
        try { realUrlSet.add(new URL(c.url).hostname + new URL(c.url).pathname); } catch {}
        realUrlSet.add(c.url);
      }
      const realDomainSet = new Set(realCitations.map(c => c.source));

      const verifiedItems = [];
      const rejectedItems = [];

      for (let i = 0; i < parsedItems.length; i++) {
        const it = parsedItems[i];
        const item = {
          id: `l${Date.now()}_${i}`,
          title: it.title || '',
          summary: it.summary || '',
          source: it.source || 'Unknown',
          url: it.url || '',
          timestamp: it.timestamp || 'Recent',
          category: it.category || 'other',
          severity: it.severity || 'medium',
          location: it.location || city,
          verified: false,
          verificationNote: ''
        };

        if (!item.url || !item.url.startsWith('http')) {
          item.verificationNote = 'REJECTED — No valid URL';
          rejectedItems.push(item);
          continue;
        }

        let urlKey = '';
        try { urlKey = new URL(item.url).hostname + new URL(item.url).pathname; } catch { urlKey = item.url; }

        if (realUrlSet.has(urlKey) || realUrlSet.has(item.url)) {
          item.verified = true;
          item.verificationNote = 'Confirmed — URL found in web search results';
          verifiedItems.push(item);
        } else if (realDomainSet.has(extractDomain(item.url))) {
          const exists = await verifyUrl(item.url);
          if (exists) {
            item.verified = true;
            item.verificationNote = 'Verified — URL responds (domain from search results)';
            verifiedItems.push(item);
          } else {
            item.verificationNote = 'REJECTED — URL does not respond';
            rejectedItems.push(item);
          }
        } else {
          const exists = await verifyUrl(item.url);
          if (exists) {
            item.verified = true;
            item.verificationNote = 'Verified — URL responds';
            verifiedItems.push(item);
          } else {
            item.verificationNote = 'REJECTED — URL does not exist (likely fabricated)';
            rejectedItems.push(item);
          }
        }
      }

      if (rejectedItems.length > 0) {
        rawParts.push('\n--- REJECTED (FAILED VERIFICATION) ---');
        rejectedItems.forEach(r => {
          rawParts.push(`"${r.title}" — ${r.verificationNote}\n   URL: ${r.url}`);
        });
      }

      return res.json({
        items: verifiedItems,
        rawResponse: rawParts.join('\n\n'),
        verifiedSources: realCitations,
        stats: { totalFound: parsedItems.length, verified: verifiedItems.length, rejected: rejectedItems.length }
      });

    } catch (parseErr) {
      return res.json({ items: [], rawResponse: rawParts.join('\n\n'), verifiedSources: realCitations, stats: { totalFound: 0, verified: 0, rejected: 0 } });
    }

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: 'Search failed: ' + (err.message || 'Unknown error') });
  }
});

app.listen(PORT, () => {
  console.log(`CivicSentinel API v3.0 — TDEC Data + Fact-Checked Search`);
  console.log(`Port: ${PORT}`);
  console.log(`TDEC endpoints: GET /api/tdec-feed, GET /api/tdec-stats, POST /api/tdec-upload`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('WARNING: ANTHROPIC_API_KEY not set!');
  } else {
    console.log('API key configured');
  }
});
