
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const app = express();
app.use(express.json({limit:'10mb'}));
app.use(express.urlencoded({extended:true}));

const upload = multer({ dest: 'uploads/' });

const SETTINGS_PATH = path.join(__dirname, 'data', 'settings.json');
let S = JSON.parse(fs.readFileSync(SETTINGS_PATH,'utf-8'));

// static
app.use(express.static(path.join(__dirname, 'public')));

// health
app.get('/api/health', (req,res)=> res.json({ ok:true, time: Date.now() }));

// settings
app.get('/api/settings', (req,res)=>{
  try{
    const raw = fs.readFileSync(SETTINGS_PATH,'utf-8');
    res.json({ ok:true, settings: JSON.parse(raw) });
  }catch(e){ res.json({ ok:false, error: e.message }); }
});
app.post('/api/settings', (req,res)=>{
  try{
    const allowed = ['desiredProfit','riskReservePerRecall','holdingPercent','docFee'];
    const next = Object.assign({}, S);
    for (const k of allowed){
      if (k in req.body){
        let v = req.body[k];
        if (typeof v === 'string') v = Number(v);
        next[k] = v;
      }
    }
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next,null,2));
    S = next;
    res.json({ ok:true, settings: S });
  }catch(e){ res.json({ ok:false, error: e.message }); }
});

// maintenance (stub)
app.get('/api/maintenance/:vin', (req,res)=>{
  res.json({
    vin: req.params.vin,
    upcoming: ['Oil change','Cabin filter'],
    intervals: { 'Oil change':'5k mi', 'Trans fluid':'60k mi' }
  });
});

// carfax upload (text-based for demo; PDF text is handled client-side)
app.post('/api/carfax/upload', upload.single('file'), (req,res)=>{
  try{
    let text = req.body.text || '';
    if (req.file){
      try { text += '\n' + fs.readFileSync(req.file.path,'utf-8'); } catch(e){}
      fs.unlink(req.file.path, ()=>{});
    }
    const lower = (text||'').toLowerCase();
    const damageReports = (text.match(/damage reported/gi)||[]).length;
    const serviceRecords = (text.match(/service (record|history|performed)/gi)||[]).length;
    const recalls = (text.match(/recall/gi)||[]).length;
    const lastOdometer = (text.match(/last reported odometer.*?([0-9,]{3,})/i)?.[1]) || null;
    let usage = null;
    if (lower.includes('personal vehicle')) usage='Personal';
    else if (lower.includes('commercial vehicle')) usage='Commercial';
    const brandings = [];
    ['salvage','rebuilt','junk','flood','lemon','hail','fire','not actual mileage','odometer rollback','structural damage'].forEach(kw=>{
      const rx = new RegExp('\\b'+kw.replace(/\s+/g,'\\s+')+'\\b','i');
      if (rx.test(text) && !/may include|include:/.test(lower)) brandings.push(kw);
    });
    res.json({ ok:true, summary:{ damageReports, serviceRecords, recalls, lastOdometer, usage, brandings } });
  }catch(e){ res.json({ ok:false, error: e.message }); }
});

// evidence score (NHTSA recalls only; complaints/TSB left 0 for demo)
app.post('/api/evidence/score', async (req,res)=>{
  try{
    const vin = (req.body.vin||'').trim();
    let vehicle = {};
    try{
      const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`);
      const j = await r.json();
      const row = j?.Results?.[0] || {};
      vehicle = { year: row.ModelYear||null, make: row.Make||null, model: row.Model||null, bodyClass: row.BodyClass||null };
    }catch(e){}
    let recs = [];
    try{
      const r = await fetch(`https://api.nhtsa.gov/recalls/recallsByVehicle?vin=${encodeURIComponent(vin)}`);
      const j = await r.json();
      recs = j?.results || j?.Results || [];
    }catch(e){}
    const counts = { recalls: recs.length, complaints: 0, tsbs: 0 };
    const topRisks = [];
    const TAGS = [
      { key:'Engine / Oil consumption', words:['engine','oil','pcv','consumption'] },
      { key:'Transmission', words:['transmission','cvt','gear','shift'] },
      { key:'Electrical', words:['electrical','alternator','battery','wiring'] },
      { key:'Brakes', words:['brake','abs','rotor','pad'] },
      { key:'HVAC / A/C', words:['hvac','a/c','heater','blend'] }
    ];
    for (const t of TAGS){
      const hits = recs.filter(rc => t.words.some(w => String(rc.Component||rc.Summary||'').toLowerCase().includes(w)));
      if (hits.length) topRisks.push({ label: t.key, score: 2, rationale: 'Recall mention (+2)' });
    }
    res.json({ ok:true, vehicle, counts, topRisks });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

// eBay comps
app.get('/api/ebay/comps', async (req,res)=>{
  try{
    const appid = process.env.EBAY_APP_ID || '';
    if(!appid) return res.json({ ok:false, error:'EBAY_APP_ID not set' });
    const { year='', make='', model='', zip='', radius='500', type='sold' } = req.query;
    const keywords = [year,make,model].filter(Boolean).join(' ');
    const categoryId = '6001';
    const common = `&SERVICE-VERSION=1.13.0&SECURITY-APPNAME=${encodeURIComponent(appid)}&RESPONSE-DATA-FORMAT=JSON&REST-PAYLOAD&categoryId=${categoryId}&keywords=${encodeURIComponent(keywords)}`;
    let url;
    if (type==='sold'){
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
    const items = (root.searchResult?.[0]?.item || []).map(it=>{
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
    const n = prices.length, median = n? (n%2 ? prices[(n-1)>>1] : (prices[(n>>1)-1]+prices[n>>1])/2) : 0;
    const avg = n? prices.reduce((s,x)=>s+x,0)/n : 0;
    const min = n? prices[0] : 0; const max = n? prices[n-1] : 0;
    res.json({ ok:true, query:{keywords, zip, radius, type}, stats:{count:n, median, avg, min, max}, items });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

// SerpAPI & manual comps
app.get('/api/serp/comps', async (req,res)=>{
  try{
    const key = process.env.SERPAPI_KEY || '';
    if(!key) return res.json({ ok:false, error:'SERPAPI_KEY not set' });
    const { site='cars', year='', make='', model='', zip='' } = req.query;
    const host = site==='facebook' ? 'facebook.com/marketplace' : 'cars.com';
    const q = [year,make,model,'used',zip].filter(Boolean).join(' ');
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
    const n = prices.length, median = n? (n%2 ? prices[(n-1)>>1] : (prices[(n>>1)-1]+prices[n>>1])/2) : 0;
    const avg = n? prices.reduce((s,x)=>s+x,0)/n : 0;
    const min = n? prices[0] : 0; const max = n? prices[n-1] : 0;
    res.json({ ok:true, query:{site, year, make, model, zip}, stats:{count:n, median, avg, min, max}, items });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});
app.post('/api/comps/manual', (req,res)=>{
  try{
    const lines = String(req.body.text||'').split('\n').map(s=>s.trim()).filter(Boolean);
    const items = [];
    for (const line of lines){
      const m = line.match(/\$?\s*([0-9][0-9,]+)\s*[-–]\s*(.+)/);
      if (m){
        const price = Number(m[1].replace(/,/g,''));
        const rest = m[2];
        const url = (rest.match(/https?:\/\/\S+/)||[])[0] || '';
        const title = url ? rest.replace(url,'').trim() : rest.trim();
        if(price>0) items.push({ title, price, url });
      }
    }
    const prices = items.map(x=>x.price).sort((a,b)=>a-b);
    const n = prices.length, median = n? (n%2 ? prices[(n-1)>>1] : (prices[(n>>1)-1]+prices[n>>1])/2) : 0;
    const avg = n? prices.reduce((s,x)=>s+x,0)/n : 0;
    const min = n? prices[0] : 0; const max = n? prices[n-1] : 0;
    res.json({ ok:true, stats:{count:n, median, avg, min, max}, items });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

// offer calc
app.post('/api/offer/calc', (req,res)=>{
  try{
    const { retailBase=0, wholesaleBase=0, maintDeduction=0, reconTotal=0, riskReserve=0 } = req.body||{};
    const adjWholesale = wholesaleBase - maintDeduction;
    const holding = Math.round((S.holdingPercent||0) * retailBase);
    const fees = S.docFee||0;
    const ceiling1 = adjWholesale - reconTotal - riskReserve - (S.desiredProfit||0);
    const ceiling2 = retailBase - (S.desiredProfit||0) - reconTotal - holding - fees;
    const targetMaxBuy = Math.min(ceiling1, ceiling2);
    res.json({ ok:true, numbers:{ retailBase, wholesaleBase, maintDeduction, adjWholesale, reconTotal, riskReserve, desiredProfit:(S.desiredProfit||0), holding, fees, targetMaxBuy } });
  }catch(e){ res.json({ ok:false, error:e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log('Server on http://localhost:'+PORT));
