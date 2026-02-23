const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;

// ─── CORS: Allow your Netlify site + local development ───
const ALLOWED_ORIGINS = [
  'https://tn-karst-ground-truth.netlify.app',
  'http://localhost:3000',
  'http://localhost:5173',
  'http://127.0.0.1:3000',
];

app.use(cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (mobile apps, curl, etc)
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  }
}));

app.use(express.json());

// ─── Simple in-memory rate limiter ───
const rateLimits = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 5; // 5 requests per minute per IP

function checkRateLimit(ip) {
  const now = Date.now();
  const record = rateLimits.get(ip);
  if (!record || now - record.windowStart > RATE_LIMIT_WINDOW) {
    rateLimits.set(ip, { windowStart: now, count: 1 });
    return true;
  }
  if (record.count >= RATE_LIMIT_MAX) return false;
  record.count++;
  return true;
}

// Clean up rate limit records every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimits) {
    if (now - record.windowStart > RATE_LIMIT_WINDOW * 2) rateLimits.delete(ip);
  }
}, 5 * 60 * 1000);

// ─── Health check ───
app.get('/', (req, res) => {
  res.json({ 
    service: 'CivicSentinel API',
    status: 'running',
    version: '1.0.0',
    mission: 'Karst Basin Community Watchdog'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Main search endpoint ───
app.post('/api/search', async (req, res) => {
  // Rate limit check
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Too many requests. Please wait a minute and try again.' });
  }

  // Validate API key is configured
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server API key not configured. Contact administrator.' });
  }

  const { city, topic, category, dateFrom, dateTo, includeSocial } = req.body;

  if (!city || !topic) {
    return res.status(400).json({ error: 'City and topic are required.' });
  }

  // Build the prompt
  let dateClause = '';
  if (dateFrom && dateTo) dateClause = `Only include results from between ${dateFrom} and ${dateTo}.`;
  else if (dateFrom) dateClause = `Only include results from after ${dateFrom}.`;
  else if (dateTo) dateClause = `Only include results from before ${dateTo}.`;

  const catClause = category && category !== 'all' && category !== 'other_custom'
    ? `Focus specifically on issues related to: ${category}.`
    : '';

  const socialClause = includeSocial
    ? `IMPORTANT: Also search for social media posts and community discussions. Try:
- "site:reddit.com ${city} ${topic}"
- "site:twitter.com ${city} ${topic}" or "site:x.com ${city} ${topic}"
- "${city} ${topic} community discussion"
- "${city} ${topic} residents complain"
Include Reddit posts, tweets, and community forum posts. Use the platform name as source.`
    : '';

  const prompt = `Search the web for community issues in ${city} about: ${topic}

${dateClause}
${catClause}

Context: This search is for a community watchdog platform focused on karst basin geological risks. The Murfreesboro/Rutherford County area of Tennessee sits on Ordovician limestone with extensive karst features (sinkholes, caves, underground streams). Issues of particular interest include: geothermal drilling damage to water wells and home foundations, sinkhole formation and subsidence, construction in karst terrain, groundwater contamination, and regulatory oversight gaps.

${socialClause}

Instructions:
1. Search for "${city} ${topic}" and variations of those terms
2. Also try related searches if the first doesn't return enough results
3. Find real, verified news articles, government notices, community reports${includeSocial ? ', AND social media posts/discussions' : ''}
4. If you find relevant results, format them as a JSON array
5. If you find NO relevant results, respond with: {"no_results": true, "searched_for": "what you searched", "suggestion": "try searching for X instead"}

JSON array format (when results found):
[{"title":"headline or post title","summary":"2-3 sentence description from the actual source","source":"publication or platform name","url":"actual URL","timestamp":"date published or posted","category":"karst_sinkholes|geothermal|water_wells|foundation|construction|environment|infrastructure|traffic|waste|education|safety|government|housing|water_sewer|other","severity":"critical|high|medium|low","location":"specific location"}]

Respond with ONLY the JSON. No markdown, no backticks, no explanation before or after.`;

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
      return res.status(502).json({ error: data.error.message || 'Claude API error', rawResponse: JSON.stringify(data.error) });
    }

    // Collect response parts
    const allContent = data.content || [];
    const textParts = allContent.filter(b => b.type === 'text').map(b => b.text);
    const searchParts = allContent.filter(b => b.type === 'web_search_tool_result');
    
    const rawParts = [];
    if (searchParts.length > 0) rawParts.push(`[Web searches performed: ${searchParts.length}]`);
    rawParts.push(...textParts);
    const rawResponse = rawParts.join('\n\n');

    // Parse results
    const fullText = textParts.join('\n');
    const cleaned = fullText.replace(/```json|```/g, '').trim();

    if (cleaned.includes('"no_results"')) {
      return res.json({ items: [], rawResponse });
    }

    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) {
      return res.json({ items: [], rawResponse });
    }

    try {
      const items = JSON.parse(match[0]).map((it, i) => ({
        id: `l${Date.now()}_${i}`,
        title: it.title || '',
        summary: it.summary || '',
        source: it.source || 'Unknown',
        url: it.url || '',
        timestamp: it.timestamp || 'Recent',
        category: it.category || 'other',
        severity: it.severity || 'medium',
        location: it.location || city,
      }));
      return res.json({ items, rawResponse });
    } catch (parseErr) {
      return res.json({ items: [], rawResponse });
    }

  } catch (err) {
    console.error('Search error:', err);
    return res.status(500).json({ error: 'Search failed: ' + (err.message || 'Unknown error') });
  }
});

// ─── Start server ───
app.listen(PORT, () => {
  console.log(`CivicSentinel API running on port ${PORT}`);
  console.log(`CORS allowed for: ${ALLOWED_ORIGINS.join(', ')}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  WARNING: ANTHROPIC_API_KEY not set! Searches will fail.');
  } else {
    console.log('✅ Anthropic API key configured');
  }
});
