# Used Car Project (v2)

Includes:
- VIN lookup stubs
- Carfax PDF upload
- Appraisal save/list
- PDF report with branding
- **Costs**: Hidden maintenance + line items (tires, windshield, etc.) with totals
- **Valuation**: Shows **Wholesale** and **Retail** prices

## Quick Start (local)
```
npm install
npm run dev
# open http://localhost:3000
```

## Render (Web Service)
- Build: `npm install`
- Start: `node server.js`
- Optional env: `VEHICLE_DATABASES_AUTH_KEY`, `PORT`
- Optional disk: mount `/uploads` for persistent Carfax files

## Endpoints
- `GET /api/value/:vin` → returns { estimate, wholesale, retail }
- `GET /api/history/:vin`
- `GET /api/maintenance/:vin`
- `POST /api/carfax/upload` (field: `file`)
- `POST /api/appraisals` / `GET /api/appraisals`
- `POST /api/report` (generates PDF)