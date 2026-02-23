# CivicSentinel API Server

Backend API for CivicSentinel — Karst Basin Community Watchdog.

Proxies search requests to Claude AI with web search so users don't need their own API key.

## Setup

1. Set environment variable: `ANTHROPIC_API_KEY=sk-ant-...`
2. `npm install`
3. `npm start`

## Deploy to Railway

1. Push to GitHub
2. Connect repo in Railway dashboard
3. Add `ANTHROPIC_API_KEY` as environment variable
4. Railway auto-deploys

## API

`POST /api/search` — Search for community issues
```json
{
  "city": "Murfreesboro, Tennessee",
  "topic": "sinkhole karst",
  "category": "karst_sinkholes",
  "dateFrom": "2025-01-01",
  "dateTo": "",
  "includeSocial": true
}
```

`GET /health` — Health check
