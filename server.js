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

app.use(express.json());

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

// ─── URL verification ───
async function verifyUrl(url) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const r = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      headers: { 'User-Agent': 'CivicSentinel/2.0 (community watchdog)' },
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
        headers: { 'User-Agent': 'CivicSentinel/2.0', 'Range': 'bytes=0-0' },
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

// ─── Extract REAL citations from Claude's web search results ───
// These are the actual URLs and snippets the search engine returned,
// NOT Claude's reinterpretation. This is the source of truth.
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
  res.json({
    service: 'CivicSentinel API',
    status: 'running',
    version: '2.0.0',
    mission: 'Karst Basin Community Watchdog',
    factChecking: 'enabled — all results verified against source URLs'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Main search endpoint ───
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

    // LAYER 1: Extract real citations from web search
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

    // LAYER 2: Parse Claude's structured response
    const fullText = textParts.join('\n');
    const cleaned = fullText.replace(/```json|```/g, '').trim();

    if (cleaned.includes('"no_results"')) {
      return res.json({ items: [], rawResponse: rawParts.join('\n\n'), verifiedSources: realCitations, stats: { totalFound: 0, verified: 0, rejected: 0 } });
    }

    const match = cleaned.match(/\[[\s\S]*\]/);

    // If Claude didn't return structured items, build from raw citations
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

    // LAYER 3: Cross-reference and verify
    try {
      const parsedItems = JSON.parse(match[0]);

      // Build lookup of real URLs
      const realUrlSet = new Set();
      for (const c of realCitations) {
        try { realUrlSet.add(new URL(c.url).hostname + new URL(c.url).pathname); } catch {}
        realUrlSet.add(c.url); // also exact match
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

        // Check against real citations
        let urlKey = '';
        try { urlKey = new URL(item.url).hostname + new URL(item.url).pathname; } catch { urlKey = item.url; }

        if (realUrlSet.has(urlKey) || realUrlSet.has(item.url)) {
          item.verified = true;
          item.verificationNote = 'Confirmed — URL found in web search results';
          verifiedItems.push(item);
        } else if (realDomainSet.has(extractDomain(item.url))) {
          // Domain matches — verify URL actually responds
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
          // Unknown domain — verify URL
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
          rawParts.push(`❌ "${r.title}" — ${r.verificationNote}\n   URL: ${r.url}`);
        });
      }

      if (verifiedItems.length > 0) {
        rawParts.push(`\n--- VERIFICATION SUMMARY ---`);
        rawParts.push(`✅ ${verifiedItems.length} results passed verification`);
        if (rejectedItems.length > 0) rawParts.push(`❌ ${rejectedItems.length} results REJECTED (fabricated or broken URLs)`);
      }

      return res.json({
        items: verifiedItems,
        rawResponse: rawParts.join('\n\n'),
        verifiedSources: realCitations,
        stats: {
          totalFound: parsedItems.length,
          verified: verifiedItems.length,
          rejected: rejectedItems.length
        }
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
  console.log(`CivicSentinel API v2.0 — Fact-Checked Edition`);
  console.log(`Port: ${PORT}`);
  console.log(`Verification: 3-layer (citation extraction → cross-reference → URL check)`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  ANTHROPIC_API_KEY not set!');
  } else {
    console.log('✅ API key configured');
  }
});
