
import express from 'express';
import path from 'path';
import multer from 'multer';
import fetch from 'node-fetch';
import fs from 'fs';

const app = express();
const __dirname = path.resolve();
app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true}));

const upload = multer({ dest: 'uploads/' });

// Settings
const SETTINGS_PATH = path.join(__dirname, 'data', 'settings.json');
let S = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));

// Serve static
app.use(express.static(path.join(__dirname, 'public')));

// Basic maintenance stub
app.get('/api/maintenance/:vin', (req,res)=>{
  res.json({
    vin: req.params.vin,
    upcoming: ['Oil change', 'Cabin filter'],
    intervals: { 'Oil change': '5k mi' },
    source: 'stub'
  });
});

// VIN decode via VPIC
async function decodeVIN(vin){
  try{
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${vin}?format=json`);
    const j = await r.json();
    const row = j?.Results?.[0] || {};
    return {
      year: row.ModelYear || null,
      make: row.Make || null,
      model: row.Model || null,
      bodyClass: row.BodyClass || null
    };
  }catch(e){
    return { year:null, make:null, model:null, bodyClass:null };
  }
}

// Carfax text parser
function extractCarfaxSummary(text){
  const t = (text || '').replace(/\r/g, '');
  const lower = t.toLowerCase();
  const accidents = (t.match(/accident reported/gi) || []).length;
  const damageReports = (t.match(/damage reported/gi) || []).length;
  const owners = Math.max((t.match(/owner\s+\d+/gi) || []).length, (t.match(/owners?\s*:\s*(\d{1,2})/i)?.[1] ? parseInt((t.match(/owners?\s*:\s*(\d{1,2})/i))[1],10) : 0));
  const serviceRecords = (t.match(/service\s(record|history|performed|inspected|maintenance)/gi) || []).length;
  const recalls = (t.match(/recall/gi) || []).length;
  const lastOdometer = (t.match(/last reported odometer.*?([0-9,]{3,})/i)?.[1]) || (t.match(/odometer.*?:\s*([0-9,]{3,})/i)?.[1]) || null;
  let usage = null;
  if (lower.includes('personal vehicle')) usage = 'Personal';
  else if (lower.includes('commercial vehicle')) usage = 'Commercial';
  else if (lower.includes('fleet vehicle')) usage = 'Fleet';
  else if (lower.includes('rental vehicle')) usage = 'Rental';
  else if (lower.includes('lease vehicle')) usage = 'Lease';

  const brandingKeywords = ['salvage','rebuilt','junk','flood','lemon','hail','fire','odometer rollback','not actual mileage','tmu','structural damage'];
  const lines = t.split(/\n+/).map(s=>s.trim().toLowerCase()).filter(Boolean);
  const brandSet = new Set();
  for (const line of lines){
    if (!/(brand|title)/.test(line)) continue;
    if (/may include|include:/.test(line)) continue;
    for (const kw of brandingKeywords){
      const pattern = new RegExp('\\b'+kw.replace(/\s+/g,'\\s+')+'\\b','i');
      if (pattern.test(line)) brandSet.add(kw);
    }
  }
  const branded = lower.match(/branded\s+title\s*[:\-]?\s*(salvage|rebuilt|junk|flood|lemon|hail|fire|not actual mileage|odometer rollback|structural damage)/gi) || [];
  branded.forEach(m=>{
    const m2 = m.toLowerCase().replace(/^branded\s+title\s*[:\-]?\s*/,'').trim();
    if (m2) brandSet.add(m2);
  });
  const brandings = Array.from(brandSet);

  return { accidents, damageReports, owners, serviceRecords, recalls, lastOdometer, usage, brandings };
}

// Upload Carfax (file or text)
app.post('/api/carfax/upload', upload.single('file'), async (req,res)=>{
  try{
    let text = req.body.text || '';
    if (req.file){ text += '\n' + fs.readFileSync(req.file.path,'utf-8'); fs.unlink(req.file.path, ()=>{}); }
    const summary = extractCarfaxSummary(text);
    res.json({ ok:true, summary });
  }catch(e){
    res.json({ ok:false, error: e.message });
  }
});

// Evidence (NHTSA recalls) + simple risk scoring
const RISK_TAGS = [
  { key:'Engine / Oil consumption', words:['engine','oil','pcv','valve cover','consumption'] },
  { key:'Transmission', words:['transmission','cvt','gear','shift','clutch'] },
  { key:'Electrical', words:['electrical','alternator','battery','wiring','power'] },
  { key:'Brakes', words:['brake','abs','rotor','pad'] },
  { key:'HVAC / A/C', words:['hvac','a/c','ac','heater','blend'] }
];

app.post('/api/evidence/score', async (req,res)=>{
  try{
    const vin = (req.body.vin||'').trim();
    const dec = await decodeVIN(vin);

    // Recalls
    let recallResults = [];
    try{
      const r = await fetch(`https://api.nhtsa.gov/recalls/recallsByVehicle?vin=${encodeURIComponent(vin)}`);
      const j = await r.json();
      recallResults = j?.results || j?.Results || [];
    }catch(e){}

    // Simple counts
    const counts = { recalls: recallResults.length, complaints: 0, tsbs: 0 };

    // Score by recall titles
    const topRisks = [];
    for (const tag of RISK_TAGS){
      const hits = recallResults.filter(rc=> tag.words.some(w => String(rc.Component||rc.Summary||rc.Consequence||'').toLowerCase().includes(w)));
      if (hits.length){
        topRisks.push({
          label: tag.key,
          score: Math.min(2, hits.length>=1 ? 2 : 1),
          rationale: 'Recall mention (+2)',
          complaints: 0,
          recall: hits.length>0,
          tsb: false,
          checks: []
        });
      }
    }

    res.json({ ok:true, vehicle: dec, counts, topRisks });
  }catch(e){
    res.json({ ok:false, error:e.message });
  }
});

// Offer calc (includes desiredProfit on both ceilings)
app.post('/api/offer/calc', (req,res)=>{
  try{
    const { retailBase, wholesaleBase, maintDeduction, reconTotal, riskReserve } = req.body;
    const adjWholesale = (wholesaleBase||0) - (maintDeduction||0);
    const holding = Math.round((S.holdingPercent||0)* (retailBase||0));
    const fees = S.docFee||0;
    const ceiling1 = adjWholesale - (reconTotal||0) - (riskReserve||0) - (S.desiredProfit||0);
    const ceiling2 = (retailBase||0) - (S.desiredProfit||0) - (reconTotal||0) - holding - fees;
    const targetMaxBuy = Math.min(ceiling1, ceiling2);
    res.json({ ok:true, numbers:{
      retailBase, wholesaleBase, maintDeduction, adjWholesale, reconTotal, riskReserve,
      desiredProfit:S.desiredProfit||0, holding, fees, targetMaxBuy
    }});
  }catch(e){
    res.json({ ok:false, error:e.message });
  }
});

app.listen(3000, ()=> console.log('Server on http://localhost:3000'));

// eBay comps (requires EBAY_APP_ID Finding API key)
app.get('/api/ebay/comps', async (req,res)=>{
  try{
    const appid = process.env.EBAY_APP_ID || '';
    if(!appid) return res.json({ ok:false, error:'EBAY_APP_ID not set' });
    const { year='', make='', model='', zip='', radius='500', type='sold' } = req.query;
    const keywords = [year, make, model].filter(Boolean).join(' ');
    const categoryId = '6001';
    const common = `&SERVICE-VERSION=1.13.0&SECURITY-APPNAME=${encodeURIComponent(appid)}&RESPONSE-DATA-FORMAT=JSON&REST-PAYLOAD&categoryId=${categoryId}&keywords=${encodeURIComponent(keywords)}`;
    let url;
    if (type === 'sold'){
      url = `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findCompletedItems${common}&itemFilter(0).name=SoldItemsOnly&itemFilter(0).value=true&sortOrder=EndTimeSoonest`;
    } else {
      url = `https://svcs.ebay.com/services/search/FindingService/v1?OPERATION-NAME=findItemsAdvanced${common}&sortOrder=BestMatch`;
    }
    if (zip){
      url += `&buyerPostalCode=${encodeURIComponent(zip)}&itemFilter(1).name=MaxDistance&itemFilter(1).value=${encodeURIComponent(String(radius||'500'))}`;
    }
    url += `&itemFilter(2).name=Condition&itemFilter(2).value(0)=Used`;
    const r = await fetch(url);
    const j = await r.json();
    const root = j?.findCompletedItemsResponse?.[0] || j?.findItemsAdvancedResponse?.[0] || {};
    const ack = root.ack?.[0];
    if (ack !== 'Success' && ack !== 'Warning'){
      return res.json({ ok:false, error:'eBay API error', raw:j });
    }
    const arr = (root.searchResult?.[0]?.item || []);
    const items = arr.map(it=>{
      const priceObj = (it.sellingStatus?.[0]?.convertedCurrentPrice?.[0]) || (it.sellingStatus?.[0]?.currentPrice?.[0]) || {};
      const price = Number(priceObj.__value__ || 0);
      const url = it.viewItemURL?.[0];
      const title = it.title?.[0] || '';
      const loc = it.location?.[0] || '';
      const end = (it.listingInfo?.[0]?.endTime?.[0]) || '';
      const cond = it.condition?.[0]?.conditionDisplayName?.[0] || '';
      return { title, price, url, loc, end, cond };
    }).filter(x=>x.price>100);
    const prices = items.map(x=>x.price).sort((a,b)=>a-b);
    const n = prices.length;
    const median = n? (n%2 ? prices[(n-1)//2] : (prices[n//2-1]+prices[n//2])/2) : 0;
    const avg = n? prices.reduce((a,b)=>a+b,0)/n : 0;
    const min = n? prices[0] : 0;
    const max = n? prices[n-1] : 0;
    res.json({ ok:true, query:{keywords, zip, radius, type}, stats:{ count:n, median, avg, min, max }, items });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

// Generic SERP comps using SerpAPI (Google). Optional and ToS-friendly via provider.
// Env: SERPAPI_KEY
app.get('/api/serp/comps', async (req,res)=>{
  try{
    const key = process.env.SERPAPI_KEY || '';
    if(!key) return res.json({ ok:false, error:'SERPAPI_KEY not set' });
    const { site='cars', year='', make='', model='', zip='' } = req.query;
    const host = site==='facebook' ? 'facebook.com/marketplace' : 'cars.com';
    const q = [year, make, model, 'used', zip].filter(Boolean).join(' ');
    const url = `https://serpapi.com/search.json?engine=google&q=${encodeURIComponent('site:'+host+' \"'+q+'\"')}&num=20&api_key=${encodeURIComponent(key)}`;
    const r = await fetch(url);
    const j = await r.json();
    const org = j.organic_results || [];
    const items = [];
    const priceRe = /\$([0-9][0-9,]{2,})/;
    for (const it of org){
      const title = it.title || '';
      const snippet = it.snippet || '';
      const link = it.link;
      let m = priceRe.exec(title) || priceRe.exec(snippet);
      const price = m ? Number(m[1].replace(/,/g,'')) : 0;
      if (price>100) items.push({ title, price, url:link });
    }
    const prices = items.map(x=>x.price).sort((a,b)=>a-b);
    const n = prices.length;
    const median = n? (n%2 ? prices[(n-1)//2] : (prices[n//2-1]+prices[n//2])/2) : 0;
    const avg = n? prices.reduce((a,b)=>a+b,0)/n : 0;
    const min = n? prices[0] : 0;
    const max = n? prices[n-1] : 0;
    res.json({ ok:true, query:{site, year, make, model, zip}, stats:{count:n, median, avg, min, max}, items });
  }catch(e){
    res.json({ ok:false, error:e.message });
  }
});

// Manual comps ingest (paste: price - title - url)
app.post('/api/comps/manual', async (req,res)=>{
  try{
    const text = (req.body.text||'').split('\n').map(s=>s.trim()).filter(Boolean);
    const items = [];
    for (const line of text){
      const m = line.match(/\$?\s*([0-9][0-9,]+)\s*[-–]\s*(.+)/);
      if (m){
        const price = Number(m[1].replace(/,/g,''));
        const rest = m[2];
        const url = (rest.match(/https?:\/\/\S+/)?.[0]) || '';
        const title = url ? rest.replace(url,'').trim() : rest.trim();
        if(price>0) items.push({ title, price, url });
      }
    }
    const prices = items.map(x=>x.price).sort((a,b)=>a-b);
    const n = prices.length;
    const median = n? (n%2 ? prices[(n-1)//2] : (prices[n//2-1]+prices[n//2])/2) : 0;
    const avg = n? prices.reduce((a,b)=>a+b,0)/n : 0;
    const min = n? prices[0] : 0;
    const max = n? prices[n-1] : 0;
    res.json({ ok:true, stats:{count:n, median, avg, min, max}, items });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});
