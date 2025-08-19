# Used Car Project (v4) — AI Cost Estimator + Carfax Parsing

Adds:
- **Carfax PDF parsing** on upload (extracts accidents, owners, service records, recalls, odometer, usage, brandings).
- **AI: Estimate Hidden Maintenance** button that asks ChatGPT to propose maintenance items NOT explicitly on Carfax (tires, brakes, fluids, etc.), with amounts.
- **Wholesale/Retail** valuation display, saved and included in PDF.
- **Costs** card (hidden maintenance + additional line items + totals).

## Quick Start (local)
```
npm install
npm run dev
# open http://localhost:3000
```

## Deploy on Render
- Build: `npm install`
- Start: `node server.js`
- Env vars:
  - `OPENAI_API_KEY` (required for AI estimator)
  - Optional: `PORT`, `VEHICLE_DATABASES_AUTH_KEY`
- Optional disk: mount `/uploads` to persist Carfax PDFs

## Key Endpoints
- `POST /api/carfax/upload` → parses PDF → `{ url, summary, text }`
- `POST /api/costs/ai-estimate` → sends Carfax text+summary to ChatGPT → returns JSON { items[], hiddenMaintenanceCost?, notes? }
- `GET /api/value/:vin` → stub valuation with `wholesale` and `retail`
- `POST /api/appraisals` / `GET /api/appraisals`
- `POST /api/report` → PDF includes Valuation, History, Maintenance, Carfax Summary, and Costs Summary