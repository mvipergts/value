# Used Car Project (Starter)

A web app + API for appraising used vehicles for OpenSource Autos.  
Includes VIN value/history/maintenance stubs, Carfax PDF upload, appraisal save/list, and PDF report generation.

## Quick Start

```bash
# 1) Install dependencies
npm install

# 2) Run the server
npm run dev
# or
npm start
```

Open: http://localhost:3000

## Environment Variables
Create a `.env` file (optional) with:
```
PORT=3000
VEHICLE_DATABASES_AUTH_KEY=your_key_here
```

## Endpoints (starter)
- `GET /api/value/:vin`
- `GET /api/history/:vin`
- `GET /api/maintenance/:vin`
- `POST /api/carfax/upload` (multipart form, field name: `file`)
- `POST /api/appraisals` (JSON body)
- `GET /api/appraisals`
- `POST /api/report` (JSON body: { vin, vehicle, valuation, history, maintenance, notes, reconItems, carfaxUrl })

> This starter stores appraisals in a local JSON file (`data/appraisals.json`) so it runs **without a database**.  
> When you're ready, swap to Postgres/Prisma (schema included in `/prisma/schema.prisma`).

## Deploy on Render (Web Service)
- Build command: `npm install`
- Start command: `node server.js`
- Add environment variables as needed
- (Optional) Persistent disk for `/uploads`