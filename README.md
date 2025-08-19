# Used Car Project (v4.1) — AI Cost Estimator + Carfax Parsing + Polished UI

- Carfax PDF parsing on upload (extracts accidents, owners, service records, recalls, odometer, usage, brandings).
- AI: Estimate Hidden Maintenance (calls OpenAI; set OPENAI_API_KEY in env).
- Wholesale/Retail valuation display.
- Costs card (hidden maintenance + additional line items + totals).
- **New (v4.1)**: History & Maintenance cards styled like the Value card, with a "Raw data" toggle.

## Render
Build: `npm install`
Start: `node server.js`
Env: `OPENAI_API_KEY` (required for AI), optional `PORT`
Optional disk: mount `/opt/render/project/src/uploads` to persist uploads