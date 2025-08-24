Used Car Project Pro v6.3.1 (CommonJS)
Fixes:
- Avoids ESM loader issues ('Unexpected token const/import') by using CommonJS server.js.
- Uses Node's native fetch (Node >=18) — no node-fetch dependency.

Includes:
- eBay SOLD/ACTIVE comps (EBAY_APP_ID)
- Cars.com & FB comps via SerpAPI (optional SERPAPI_KEY) + manual paste
- KBB/Black Book manual entry + Weighted Retail
- Auto NHTSA Top Risks per VIN, branding parser, $2k profit floor, sticky summary.

Deploy:
- Start: node server.js
- Node: >=18 <23
- Env: EBAY_APP_ID (required for eBay), SERPAPI_KEY (optional)
