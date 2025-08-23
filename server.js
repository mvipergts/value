
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const pdfParse = require('pdf-parse');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '12mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'uploads');
const reportsDir = path.join(__dirname, 'reports');
const dataDir = path.join(__dirname, 'data');
[uploadDir, reportsDir, dataDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });
app.use('/uploads', express.static(uploadDir));
app.use('/reports', express.static(reportsDir));

// SETTINGS
const settingsFile = path.join(dataDir, 'settings.json');
if (!fs.existsSync(settingsFile)) {
  fs.writeFileSync(settingsFile, JSON.stringify({
    laborRate: 120, partsMultiplier: 1.0, desiredProfit: 2000, daysToTurn: 30,
    floorplanAPR: 0.10, avgTransport: 150, marketingFees: 85, warrantyReserve: 0,
    riskWeights: {
      "Engine / Oil consumption": 100, "Transmission": 120, "Electrical": 60, "Brakes": 50, "HVAC / A/C": 40,
      "Airbags / SRS": 80, "Steering": 70, "Suspension": 70, "Fuel system": 70, "Paint / Exterior": 30
    },
    riskReserveCapPct: 0.15, allowSerpAPI: false
  }, null, 2));
}
const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const writeSettings = (obj) => fs.writeFileSync(settingsFile, JSON.stringify(obj, null, 2));
app.get('/api/settings', (req,res)=>{ try{ res.json({ ok:true, settings: readSettings() }); }catch(e){ res.status(500).json({ ok:false }); } });
app.post('/api/settings', (req,res)=>{ try{ const s=readSettings(); const next={...s, ...(req.body||{})}; writeSettings(next); res.json({ ok:true, settings: next }); }catch(e){ res.status(500).json({ ok:false }); } });

// Uploads
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({ storage });

function expectedMileageByYear(year) {
  const now = new Date().getFullYear();
  const age = (year && year > 1900 && year <= now) ? (now - year) : 0;
  return age * 12000;
}
function money(n){ return '$' + Number(n || 0).toLocaleString(); }

// VIN decode
app.get('/api/vin/:vin', async (req, res) => {
  try {
    const vin = String(req.params.vin || '').trim();
    if (!vin) return res.status(400).json({ ok:false, error:'no_vin' });
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
    const j = await r.json();
    const row = j?.Results?.[0] || {};
    res.json({ ok:true, vin, year: row.ModelYear || null, make: row.Make || null, model: row.Model || null, trim: row.Trim || row.Series || null, bodyClass: row.BodyClass || null });
  } catch(e){ res.status(500).json({ ok:false, error:'vin_failed' }); }
});

// Heuristic values
app.get('/api/value/:vin', async (req, res) => {
  try {
    const mileage = Number(req.query.mileage || 0);
    const year = Number(req.query.year || 0);
    const baseRetail = 14000;
    const baseWholesale = 0.86 * baseRetail;
    const expected = expectedMileageByYear(year);
    const delta = mileage - expected;
    const retail = Math.round(baseRetail - (delta * 0.08));
    const wholesale = Math.round(baseWholesale - (delta * 0.06));
    res.json({ vin: req.params.vin, mileage, year, retail, wholesale, method:'heuristic' });
  } catch(e){ res.json({ vin: req.params.vin, retail: 12000, wholesale: 10000, method:'fallback' }); }
});

// History & maintenance stubs
app.get('/api/history/:vin', (req,res)=>res.json({ accidents:0, owners:2, serviceRecords:7 }));
app.get('/api/maintenance/:vin', (req,res)=>res.json({ upcoming:['Oil change','Cabin filter'], intervals:{ 'Oil change':'5k mi' } }));

// Carfax parse
function extractCarfaxSummary(text){
  const t = (text || '').replace(/\r/g, '');
  const lower = t.toLowerCase();
  const accidentHits = (t.match(/accident reported/gi) || []).length;
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

  // --- Context-aware title branding detection ---
  const brandingKeywords = ['salvage','rebuilt','junk','flood','lemon','hail','fire','odometer rollback','not actual mileage','tmu','structural damage'];
  const lines = t.split(/\n+/).map(s=>s.trim().toLowerCase()).filter(Boolean);
  const brandSet = new Set();
  for (const line of lines){
    if (!/(brand|title)/.test(line)) continue;            // must mention brand/title
    if (/may include|include:/.test(line)) continue;      // skip disclaimers/lists
    for (const kw of brandingKeywords){
      const pattern = new RegExp('\\\\b'+kw.replace(/\\s+/g,'\\\\s+')+'\\\\b','i');
      if (pattern.test(line)) brandSet.add(kw);
    }
  }
  const branded = lower.match(/branded\\s+title\\s*[:\\-]?\\s*(salvage|rebuilt|junk|flood|lemon|hail|fire|not actual mileage|odometer rollback|structural damage)/gi) || [];
  branded.forEach(m=>{
    const m2 = m.toLowerCase().replace(/^branded\\s+title\\s*[:\\-]?\\s*/,'').trim();
    if (m2) brandSet.add(m2);
  });

  const brandings = Array.from(brandSet);

  return { accidents: accidentHits, damageReports, owners, serviceRecords, recalls, lastOdometer, usage, brandings };
}
app.post('/api/carfax/upload', upload.single('file'), async (req,res)=>{
  try {
    const buffer = fs.readFileSync(req.file.path);
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';
    const summary = text.trim() ? extractCarfaxSummary(text) : { note:'no_text_extracted' };
    res.json({ ok:true, url:`/uploads/${path.basename(req.file.path)}`, summary, text });
  } catch(e){ res.json({ ok:false, error:'parse_failed' }); }
});
app.post('/api/carfax/summarize-text', (req,res)=>{
  try{ const { rawText='' } = req.body||{}; if(!rawText.trim()) return res.status(400).json({ ok:false, error:'no_text' }); res.json({ ok:true, summary: extractCarfaxSummary(rawText) }); }catch(e){ res.status(500).json({ ok:false }); }
});

// Maintenance inference
const COST_MAP = {
  oil_change: 60, cabin_filter: 40, engine_air_filter: 45,
  tire_rotation: 30, wheel_alignment: 110, battery: 180,
  brake_fluid: 120, coolant: 180, transmission_service: 250,
  spark_plugs: 250
};
function inferMaintenance({ summary={}, text='', mileage=0, year=0 }){
  const t = String(text||'').toLowerCase();
  const m = Number(mileage||0);
  const expectedSvc = Math.max(2, Math.round((new Date().getFullYear() - (year||new Date().getFullYear())) * 1.2));
  const svcCount = Number(summary?.serviceRecords || 0);
  const map = new Map();
  const add=(key,label,why)=>{ if(!map.has(key)) map.set(key,{ key,label,rationale:[],amount:COST_MAP[key]??100, source:'carfax_gap'}); map.get(key).rationale.push(why); };
  const has=(kw)=>t.includes(kw); const noneOf=(...kws)=>!kws.some(has);
  if (svcCount < expectedSvc/2){ add('oil_change','Oil change',`Low service history (${svcCount}/${expectedSvc} expected)`); add('engine_air_filter','Engine air filter','Low service history'); add('cabin_filter','Cabin filter','Low service history'); }
  if (noneOf('oil change','engine oil','changed oil')) add('oil_change','Oil change','No oil change found in Carfax text');
  if (m>=60000){ if(noneOf('transmission service','transmission fluid','trans fluid')) add('transmission_service','Transmission service','>=60k mi and no service noted'); if(noneOf('brake fluid')) add('brake_fluid','Brake fluid exchange','>=60k mi and no service noted'); if(noneOf('coolant service','coolant flush','radiator flushed')) add('coolant','Coolant service','>=60k mi and no service noted'); }
  if (m>=90000 && noneOf('spark plug')) add('spark_plugs','Spark plugs','>=90k mi and no plugs noted');
  return Array.from(map.values());
}
app.post('/api/infer/maintenance', (req,res)=>{
  try{ res.json({ ok:true, items: inferMaintenance(req.body||{}) }); }catch(e){ res.status(500).json({ ok:false, error:'infer_failed' }); }
});

// Evidence (NHTSA + TSB)
function cleanModel(m){
  if(!m) return m;
  let s=String(m);
  s = s.replace(/\(.*?\)/g,' ').replace(/[|•·]/g,' ').replace(/\s+/g,' ').trim();
  // Keep up to first two tokens for common two-word models
  const keepTwo = ['grand','range','sierra','silverado','model','transit','land','ram','civic','accord','escape','f-150','f150','cx-5','cx-9','e-class','c-class','3','5','6'];
  const parts = s.split(' ');
  if (parts.length<=2) return s;
  if (keepTwo.includes(parts[0].toLowerCase())) return parts.slice(0,2).join(' ');
  return parts[0];
}
app.post('/api/evidence/score', async (req,res)=>{
  try {
    const { vin='', vehicle='' } = req.body||{};
    let year=null, make=null, model=null;
    if (vehicle){ const parts=vehicle.split(/\s+/); const y=parseInt(parts[0],10); if(!isNaN(y)){ year=y; make=parts[1]||null; model=parts.slice(2).join(' ')||null; } }
    // Force VIN decode if model looks noisy
    if ((model && /\s·\s|\(|\)/.test(model)) || (!year||!make||!model)) {
      try{ const r=await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`); const j=await r.json(); const row=j?.Results?.[0]||{}; year=year||parseInt(row.ModelYear,10)||null; make=make||row.Make||null; model=cleanModel(model||row.Model||null); } catch {}
    }
    async function getJSON(url){ try{ const r=await fetch(url); return await r.json(); }catch(e){ return null; } }
    let recalls=[], complaints=[], tsbs=[];
    if (make && model && year){
      const rec=await getJSON(`https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`);
      if (rec && rec.results) recalls=rec.results;
      const cmp=await getJSON(`https://api.nhtsa.gov/Complaints/ByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`);
      if (cmp && cmp.results) complaints=cmp.results;
      try{
        const baseUrl='https://data.transportation.gov/resource/hczg-qbhf.json';
        const hdrs={'Accept':'application/json'}; if (process.env.SOCRATA_APP_TOKEN) hdrs['X-App-Token']=process.env.SOCRATA_APP_TOKEN;
        const url=`${baseUrl}?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&model_year=${encodeURIComponent(year)}&$limit=100`;
        const r=await fetch(url,{ headers: hdrs }); const data=await r.json(); if(Array.isArray(data)) tsbs=data;
      }catch{}
    }
    // Score buckets
    const buckets=[
      {key:'engine',label:'Engine / Oil consumption'},
      {key:'trans',label:'Transmission'},
      {key:'brake',label:'Brakes'},
      {key:'air bag',label:'Airbags / SRS'},
      {key:'electr',label:'Electrical'},
      {key:'steering',label:'Steering'},
      {key:'susp',label:'Suspension'},
      {key:'fuel',label:'Fuel system'},
      {key:'ac',label:'HVAC / A/C'},
      {key:'paint',label:'Paint / Exterior'}
    ];
    const lowerIncludes=(txt,n)=> (txt||'').toLowerCase().includes(n);
    const buckCounts=new Map(), buckTSB=new Map(), buckRecall=new Map();
    complaints.forEach(c=>{ const txt=`${c?.component||''} ${c?.summary||''} ${c?.narrative||''}`.toLowerCase(); buckets.forEach(b=>{ if(lowerIncludes(txt,b.key)) buckCounts.set(b.label,(buckCounts.get(b.label)||0)+1); }); });
    tsbs.forEach(t=>{ const txt=`${t?.component||''} ${t?.system_type||''} ${t?.summary||''}`.toLowerCase(); buckets.forEach(b=>{ if(lowerIncludes(txt,b.key)) buckTSB.set(b.label,true); }); });
    recalls.forEach(rc=>{ const txt=`${rc?.Component||''} ${rc?.Summary||''}`.toLowerCase(); buckets.forEach(b=>{ if(lowerIncludes(txt,b.key)) buckRecall.set(b.label,true); }); });
    const scored=buckets.map(b=>{
      const c=buckCounts.get(b.label)||0;
      const hasT=!!buckTSB.get(b.label), hasR=!!buckRecall.get(b.label);
      const score=(hasT?3:0)+(hasR?2:0)+Math.floor(c/10);
      const rationale=[hasT?'TSB present (+3)':null, hasR?'Recall mention (+2)':null, c?`${c} complaints (~+${Math.floor(c/10)})`:null].filter(Boolean).join(' · ');
      return { label:b.label, score, rationale, complaints:c, tsb:hasT, recall:hasR, checks:[] };
    }).filter(s=>s.score>0).sort((a,b)=>b.score-a.score).slice(0,5);
    res.json({ ok:true, counts:{recalls:recalls.length, complaints:complaints.length, tsbs:tsbs.length}, topRisks:scored });
  } catch(e){ res.status(500).json({ ok:false, error:'evidence_failed' }); }
});

// Offer calc
app.post('/api/offer/calc', (req,res)=>{
  try {
    const S = readSettings();
    const { valuation={}, maintenanceItems=[], reconItems=[], risks=[], baseWholesale=null } = req.body||{};
    const wholesaleBase = (baseWholesale!=null) ? Number(baseWholesale) : Number(valuation?.wholesale || 0);
    const retailBase = Number(valuation?.retail || 0);
    const seen=new Set();
    const dedupMaint=[]; for(const it of (maintenanceItems||[])){ const k=it.key||it.label; if(!seen.has(k)){ seen.add(k); dedupMaint.push(it);} }
    const dedupRecon=[]; for(const it of (reconItems||[])){ const k=it.key||it.label; if(seen.has(k)) continue; seen.add(k); dedupRecon.push(it); }
    const maintDeduction=dedupMaint.reduce((s,it)=>s+Number(it.amount||0),0);
    const reconTotal=dedupRecon.reduce((s,it)=>s+Number(it.amount||0),0);
    let riskReserve=0; for(const r of (risks||[])){ const weight=S.riskWeights[r.label] ?? 50; riskReserve += (r.score||0)*weight; }
    const cap=(wholesaleBase||0)*(S.riskReserveCapPct||0.15); riskReserve=Math.min(riskReserve, cap);
    const adjWholesale=Math.max(0, Math.round(wholesaleBase - maintDeduction));
    const holding=(S.floorplanAPR||0)*(S.daysToTurn||0)*(retailBase||0)/365;
    const fees=(S.avgTransport||0)+(S.marketingFees||0)+(S.warrantyReserve||0);
    const ceiling1 = adjWholesale - reconTotal - riskReserve - (S.desiredProfit||0);
    const ceiling2 = (retailBase||0) - (S.desiredProfit||0) - reconTotal - holding - fees;
    const targetMaxBuy = Math.floor(Math.max(0, Math.min(ceiling1, ceiling2)));
    res.json({ ok:true, numbers:{ retailBase, wholesaleBase, maintDeduction, adjWholesale, reconTotal, riskReserve, desiredProfit:(S.desiredProfit||0), holding:Math.round(holding), fees:Math.round(fees), targetMaxBuy }, items:{ maintenance: dedupMaint, recon: dedupRecon } });
  } catch(e){ res.status(500).json({ ok:false, error:'offer_calc_failed' }); }
});

// eBay comps
const EBAY_APP_ID = process.env.EBAY_APP_ID || '';
const EBAY_ENDPOINT = 'https://svcs.ebay.com/services/search/FindingService/v1';
async function ebayFinding(operation, params){
  if (!EBAY_APP_ID) return { error:'missing_app_id' };
  const query = new URLSearchParams({
    'OPERATION-NAME': operation,
    'SERVICE-VERSION': '1.13.0',
    'SECURITY-APPNAME': EBAY_APP_ID,
    'GLOBAL-ID': 'EBAY-US',
    'RESPONSE-DATA-FORMAT': 'JSON',
    'REST-PAYLOAD': 'true',
    ...params
  });
  const url = `${EBAY_ENDPOINT}?${query.toString()}`;
  const r = await fetch(url, { headers:{ 'Accept':'application/json' } });
  return await r.json();
}
function computeStats(arr){
  const xs = arr.filter(v=>isFinite(v)).sort((a,b)=>a-b);
  if(!xs.length) return { count:0, p25:null, median:null, p75:null };
  const q = p => {
    const pos = (xs.length - 1) * p;
    const base = Math.floor(pos), rest = pos - base;
    const next = xs[base+1] !== undefined ? xs[base+1] : xs[base];
    return Math.round(xs[base] + (next - xs[base]) * rest);
  };
  return { count: xs.length, p25: q(0.25), median: q(0.5), p75: q(0.75) };
}
function titleMatches(title, {year,make,model,trim}){
  const t = (title||'').toLowerCase();
  if (year && !t.includes(String(year))) return false;
  if (make && !t.includes(String(make).toLowerCase())) return false;
  if (model && !t.includes(String(model).toLowerCase())) return false;
  return true;
}
app.get('/api/comps/ebay/sold', async (req,res)=>{
  try {
    const { year, make, model, trim, zip, radius='500' } = req.query||{};
    const keywords = [year, make, model, trim].filter(Boolean).join(' ');
    const j = await ebayFinding('findCompletedItems', {
      keywords,
      'buyerPostalCode': zip || '',
      'paginationInput.entriesPerPage': '100',
      'itemFilter(0).name': 'SoldItemsOnly',
      'itemFilter(0).value': 'true',
      'itemFilter(1).name': 'MaxDistance',
      'itemFilter(1).value': String(radius || '500')
    });
    const items = j?.findCompletedItemsResponse?.[0]?.searchResult?.[0]?.item || [];
    const cleaned = items.map(it=>{
      const title = it.title?.[0] || '';
      const price = parseFloat(it.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || '0');
      const endTime = it.listingInfo?.[0]?.endTime?.[0] || null;
      const url = it.viewItemURL?.[0] || null;
      return { title, price, endTime, url };
    }).filter(it=> it.price>0 && titleMatches(it.title,{year,make,model,trim}));
    const stats = computeStats(cleaned.map(x=>x.price));
    res.json({ ok:true, stats, items: cleaned });
  } catch(e){ res.status(500).json({ ok:false, error:'ebay_failed' }); }
});
app.get('/api/comps/ebay/active', async (req,res)=>{
  try {
    const { year, make, model, trim, zip, radius='500' } = req.query||{};
    const keywords = [year, make, model, trim].filter(Boolean).join(' ');
    const j = await ebayFinding('findItemsAdvanced', {
      keywords,
      'buyerPostalCode': zip || '',
      'paginationInput.entriesPerPage': '50',
      'itemFilter(0).name': 'MaxDistance',
      'itemFilter(0).value': String(radius || '500')
    });
    const items = j?.findItemsAdvancedResponse?.[0]?.searchResult?.[0]?.item || [];
    const cleaned = items.map(it=>{
      const title = it.title?.[0] || '';
      const price = parseFloat(it.sellingStatus?.[0]?.currentPrice?.[0]?.__value__ || '0');
      const url = it.viewItemURL?.[0] || null;
      return { title, price, url };
    }).filter(it=> it.price>0 && titleMatches(it.title,{year,make,model,trim}));
    const stats = computeStats(cleaned.map(x=>x.price));
    res.json({ ok:true, stats, items: cleaned });
  } catch(e){ res.status(500).json({ ok:false, error:'ebay_failed' }); }
});

// Customer PDF
app.post('/api/report/customer', (req, res) => {
  const { vin, vehicle='', valuation={}, calc={}, items={}, carfaxUrl='' } = req.body || {};
  const filePath = path.join(reportsDir, `${vin || 'customer'}_${Date.now()}.pdf`);
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);
  const cPrimary='#2563EB', cText='#0F172A', cMuted='#475569', cRule='#E2E8F0', cGreen='#10B981', cAmber='#F59E0B', cIndigo='#6366F1';

  doc.rect(40,40,532,46).fill(cPrimary);
  doc.fillColor('#fff').fontSize(16).text('Vehicle Appraisal (Customer Copy)',50,52,{width:400});
  doc.fontSize(10).text(new Date().toLocaleString(),50,72);
  doc.fillColor(cText);

  const bannerY=100;
  const vehStr=vehicle||'Vehicle';
  doc.fontSize(14);
  const vehH=Math.max(18, doc.heightOfString(vehStr,{width:480}));
  const bannerH=Math.max(68,32+vehH);
  doc.roundedRect(40,bannerY,532,bannerH,8).strokeColor(cRule).lineWidth(1).stroke();
  doc.fillColor(cText).fontSize(14).text(vehStr,50,bannerY+12,{width:480});

  let y=bannerY+bannerH+16; const colW=260; const half=110;

  function card(x,y,w,h,title,accent){
    doc.roundedRect(x,y,w,h,10).fillAndStroke(accent,cRule);
    doc.fillColor('#fff').fontSize(11).text(title,x+12,y+10);
    doc.fillColor(cText);
    doc.roundedRect(x,y+28,w,h-28,10).fill('#fff').strokeColor(cRule).stroke();
    return { cx:x+12, cy:y+42, cw:w-24 };
  }

  const v=card(40,y,colW,170,'Valuation',cGreen);
  let vy=v.cy;
  const kv=(k,vv)=>{ doc.font('Helvetica-Bold').text(k,v.cx,vy,{width:half}); doc.font('Helvetica').text(vv,v.cx+half,vy,{width:colW-24-half,align:'right'}); vy+=16; };
  kv('Retail', money(valuation.retail||0));
  kv('Wholesale', money(valuation.wholesale||0));
  kv('Maint. deduction','-'+money(calc.maintDeduction||0));
  kv('Wholesale (after gaps)', money(calc.adjWholesale||0));

  const r=card(312,y,colW,170,'Offer Summary',cIndigo);
  let ry=r.cy;
  const kr=(k,vv)=>{ doc.font('Helvetica-Bold').text(k,r.cx,ry,{width:half}); doc.font('Helvetica').text(vv,r.cx+half,ry,{width:colW-24-half,align:'right'}); ry+=16; };
  kr('Recon total', money(calc.reconTotal||0));
  kr('Risk reserve', money(calc.riskReserve||0));
  kr('Holding & fees', money((calc.holding||0)+(calc.fees||0)));
  kr('Target Max Buy', money(calc.targetMaxBuy||0));

  y+=190;
  const t=card(40,y,532,160,'Maintenance Deductions',cAmber);
  const headerY=t.cy-8;
  doc.fontSize(10).fillColor(cMuted).text('Item',54,headerY,{width:200});
  doc.text('Amount',340,headerY,{width:80,align:'right'});
  doc.text('Why',430,headerY,{width:130});
  doc.moveTo(50,headerY+14).lineTo(560,headerY+14).strokeColor(cRule).stroke();
  doc.fillColor(cText);
  let rowY=headerY+18;
  const rows=Array.isArray(items?.maintenance)?items.maintenance:[];
  if(!rows.length){
    doc.text('No maintenance deductions applied.',54,rowY);
  } else {
    rows.forEach((it,i)=>{
      const why=Array.isArray(it.rationale)?it.rationale.join(' • '):(it.rationale||'');
      const whyH=Math.max(14, doc.heightOfString(why,{width:130}));
      const rowH=Math.max(18, whyH)+4;
      const bg=(i%2===0)?'#F8FAFC':'#FFFFFF';
      doc.rect(44,rowY-4,520,rowH).fill(bg);
      doc.fillColor(cText).text(it.label||'',54,rowY,{width:200});
      doc.text(money(it.amount||0),340,rowY,{width:80,align:'right'});
      doc.fillColor(cMuted).text(why,430,rowY,{width:130});
      doc.fillColor(cText);
      rowY+=rowH;
    });
  }

  doc.fillColor(cMuted).fontSize(9);
  if (carfaxUrl) doc.text(`Carfax: ${carfaxUrl}`, 40, 740, { link: carfaxUrl, underline: true });
  doc.text('Estimates are guidance, not an offer. Final price depends on inspection and market.', 40, 752);
  doc.end();
  stream.on('finish', ()=>res.json({ ok:true, url:`/reports/${path.basename(filePath)}` }));
});

// Health
app.get('/healthz', (_,res)=>res.json({ ok:true }));

app.listen(PORT, ()=>console.log('Server :'+PORT));
