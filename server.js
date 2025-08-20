\
require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const pdfParse = require('pdf-parse');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const AI_ENABLED = !!openai && process.env.OPENAI_MOCK !== '1';
const MOCK = process.env.OPENAI_MOCK === '1';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// Storage for Carfax uploads
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, Date.now() + '_' + safe);
  }
});
const upload = multer({ storage });

// Simple in-file storage
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dataFile = path.join(dataDir, 'appraisals.json');
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]');
const readAppraisals = () => JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
const writeAppraisals = (list) => fs.writeFileSync(dataFile, JSON.stringify(list, null, 2));

// ---------- Helpers ----------
function parseCarfaxText(text) {
  const lower = text.toLowerCase();
  const accidents = (text.match(/accident reported/gi) || []).length;
  const damageReports = (text.match(/damage reported/gi) || []).length;

  let owners = 0;
  const ownerMatches = text.match(/owner\s+\d+/gi);
  if (ownerMatches) owners = new Set(ownerMatches.map(s => s.toLowerCase())).size;
  const ownersNumMatch = text.match(/owners?:\s*(\d{1,2})/i);
  if (ownersNumMatch) owners = Math.max(owners, parseInt(ownersNumMatch[1], 10));

  const serviceRecords = (text.match(/service\s(record|history|performed|inspected|maintenance)/gi) || []).length;
  const recalls = (text.match(/recall/gi) || []).length;

  const lastOdoMatch = text.match(/last reported odometer.*?([0-9,]{3,})/i);
  const lastOdometer = lastOdoMatch ? lastOdoMatch[1] : null;

  const brandings = [];
  const brandingKeywords = ['salvage','rebuilt','junk','flood','lemon','hail','fire','odometer rollback','not actual mileage','tmu','structural damage'];
  brandingKeywords.forEach(k => { if (lower.includes(k)) brandings.push(k); });

  let usage = null;
  if (lower.includes('personal vehicle')) usage = 'Personal';
  else if (lower.includes('commercial vehicle')) usage = 'Commercial';
  else if (lower.includes('fleet vehicle')) usage = 'Fleet';

  return { accidents, damageReports, owners, serviceRecords, recalls, lastOdometer, usage, brandings: Array.from(new Set(brandings)) };
}

function safeOutputText(resp) {
  try { if (resp.output_text) return resp.output_text; } catch(e){}
  try { return resp.choices?.[0]?.message?.content || ''; } catch(e){}
  try {
    if (resp.output && Array.isArray(resp.output)) {
      const parts = [];
      resp.output.forEach(o => (o?.content||[]).forEach(c => { if (c?.text) parts.push(c.text); }));
      return parts.join('\n');
    }
  } catch(e){}
  return '';
}

// Basic cost map for maintenance
const COST_MAP = {
  "Oil change": 60,
  "Cabin filter": 40,
  "Engine air filter": 45,
  "Tire rotation": 30,
  "Wheel alignment": 110,
  "Battery": 180,
  "Brake fluid exchange": 120,
  "Coolant service": 180,
  "Transmission service": 250,
  "Spark plugs": 250,
  "Wiper blades": 30
};

// ---------- STUB endpoints ----------
app.get('/api/value/:vin', async (req, res) => {
  const estimate = 12500;
  res.json({ vin: req.params.vin, estimate, wholesale: Math.round(estimate*0.90), retail: Math.round(estimate*1.15), currency: 'USD', source: 'stub' });
});

app.get('/api/history/:vin', async (req, res) => {
  res.json({ vin: req.params.vin, accidents: 0, owners: 2, serviceRecords: 7, source: 'stub' });
});

app.get('/api/maintenance/:vin', async (req, res) => {
  res.json({ vin: req.params.vin, upcoming: ['Oil change','Cabin filter'], intervals: {'Oil change':'5k mi'}, source: 'stub' });
});

// Carfax upload + parse
app.post('/api/carfax/upload', upload.single('file'), async (req, res) => {
  try {
    const buffer = fs.readFileSync(req.file.path);
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';
    const summary = parseCarfaxText(text);
    const url = `/uploads/${path.basename(req.file.path)}`;
    res.json({ ok: true, path: req.file.path, url, summary, text });
  } catch (e) {
    const url = `/uploads/${path.basename(req.file.path)}`;
    res.json({ ok: true, path: req.file.path, url, summary: { error: 'parse_failed' }, text: '' });
  }
});
app.use('/uploads', express.static(uploadDir));

// --- maintenance costs from 'upcoming'
app.post('/api/maintenance/costs', async (req, res) => {
  try {
    const { upcoming = [], vehicle = '', region = 'Kansas City, MO', laborRate = 120 } = req.body;
    let items = upcoming.map(label => {
      let amount = COST_MAP[label] ?? null;
      if (amount == null) return null;
      return { label, amount, rationale: 'default map', source: 'map' };
    }).filter(Boolean);

    const unknowns = upcoming.filter(label => COST_MAP[label] == null);
    if (unknowns.length && AI_ENABLED) {
      if (MOCK) {
        unknowns.forEach(u => items.push({ label: u, amount: 120, rationale: 'mock', source: 'mock' }));
      } else {
        const schema = {
          name: 'LineItems',
          schema: { type:'object', properties: { items: { type:'array', items: { type:'object', properties: { label:{type:'string'}, amount:{type:'number'}, rationale:{type:'string'} }, required:['label','amount'] } } }, required:['items'] },
          strict: true
        };
        const prompt = `Estimate fair parts+labor prices in ${region} (labor=$${laborRate}/hr) for these items on ${vehicle}: ${unknowns.join(', ')}`;
        const resp = await openai.responses.create({ model:'gpt-4o-mini', input: prompt, response_format: { type:'json_schema', json_schema: schema } });
        const out = JSON.parse(safeOutputText(resp) || '{}');
        (out.items||[]).forEach(it => items.push({ ...it, source: 'ai' }));
      }
    } else if (unknowns.length && !AI_ENABLED) {
      unknowns.forEach(u => items.push({ label: u, amount: 100, rationale: 'fallback', source: 'fallback' }));
    }
    return res.json({ ok:true, items });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'maintenance_costs_failed' });
  }
});

// --- common issues (AI)
app.post('/api/maintenance/common-issues', async (req, res) => {
  try {
    const { vin='', vehicle='', carfaxSummary={}, carfaxText='' } = req.body;
    if (MOCK || !AI_ENABLED) {
      return res.json({ ok:true, issues: [
        { title: 'Starter relay (example)', details: 'Intermittent no-crank around high mileage.' },
        { title: 'Oil consumption check', details: 'Monitor usage and PCV function.' }
      ], notes: 'Mock result (set OPENAI_MOCK=0 and add OPENAI_API_KEY for live data).' });
    }
    const schema = {
      name: 'CommonIssues',
      schema: {
        type: 'object',
        properties: {
          issues: { type: 'array', items: { type: 'object', properties: { title:{type:'string'}, details:{type:'string'} }, required:['title'] } },
          notes: { type:'string' }
        },
        required: ['issues']
      },
      strict: true
    };
    const prompt = `List concise, widely reported issues for this vehicle, considering Carfax context if relevant.
Vehicle: ${vehicle || 'Unknown'}; VIN: ${vin || 'Unknown'}
Carfax summary: ${JSON.stringify(carfaxSummary)}
Snippets: ${carfaxText.slice(0, 1000)}`;
    const resp = await openai.responses.create({ model:'gpt-4o-mini', input: prompt, response_format: { type:'json_schema', json_schema: schema } });
    const data = JSON.parse(safeOutputText(resp) || '{}');
    return res.json({ ok:true, ...data });
  } catch (e) {
    return res.status(500).json({ ok:false, error:'common_issues_failed' });
  }
});

// --- hidden maintenance estimator
app.post('/api/costs/ai-estimate', async (req, res) => {
  try {
    if (MOCK) {
      return res.json({ ok: true, estimate: { items: [
        { label: "Tires (set of 4)", amount: 800, laborHours: 0.5, risk: "medium", rationale: "Mock" },
        { label: "Front brakes (pads+rotors)", amount: 450, laborHours: 1.5, risk: "medium", rationale: "Mock" },
        { label: "Fluids & filters baseline", amount: 220, laborHours: 1.0, risk: "low", rationale: "Mock" }
      ], hiddenMaintenanceCost: 300, notes: "Mock estimate for UI testing" } });
    }
    if (!AI_ENABLED) return res.status(400).json({ ok: false, error: 'missing_openai_api_key' });
    const { vin, vehicle, region='Kansas City, MO', laborRate=120, carfaxSummary={}, carfaxText='' } = req.body;

    const ruleHints = [];
    const odo = Number(String(carfaxSummary?.lastOdometer||'0').replace(/,/g,''));
    if (odo>=90000) ruleHints.push("Timing components (if belt), coolant hoses, struts/shocks likely due.");
    if (odo>=60000) ruleHints.push("Brakes near end of life; transmission service; spark plugs possible.");
    if ((carfaxSummary?.serviceRecords ?? 0) < 2) ruleHints.push("Low service history: add fluids and filters baseline.");
    if ((carfaxSummary?.accidents ?? 0) > 0) ruleHints.push("Check alignment, tires, control arms, suspension wear.");
    if (carfaxSummary?.usage === 'Fleet') ruleHints.push("Fleet usage: bushings, brakes, tires, battery, alternator.");

    const jsonSchema = {
      name: "HiddenMaintenanceEstimate",
      schema: {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                amount: { type: "number" },
                laborHours: { type: "number" },
                risk: { type: "string", enum: ["low","medium","high"] },
                rationale: { type: "string" }
              },
              required: ["label", "amount"]
            }
          },
          hiddenMaintenanceCost: { type: "number" },
          notes: { type: "string" }
        },
        required: ["items"]
      },
      strict: true
    };

    const prompt = `You are a dealership service estimator. Using the vehicle info, region, labor rate, and the Carfax text & summary, propose maintenance costs that are LIKELY NEEDED BUT NOT explicitly listed on the Carfax.
- Output a careful, realistic estimate for ${region} parts+labor using laborRate = $${laborRate}/hr.
- Consider mileage, age, usage (fleet/personal), low service history, accidents, and common wear items.
- Strict JSON per provided schema.

Vehicle: ${vehicle || "Unknown"}; VIN: ${vin || "Unknown"}
Rule hints: ${ruleHints.join('; ')}
Carfax summary: ${JSON.stringify(carfaxSummary)}
Carfax text (first 6000 chars): ${carfaxText.slice(0, 6000)}`;

    const resp = await openai.responses.create({
      model: "gpt-4o-mini",
      input: prompt,
      response_format: { type: "json_schema", json_schema: jsonSchema }
    });
    const data = JSON.parse(safeOutputText(resp) || "{}");
    return res.json({ ok: true, estimate: data });
  } catch (err) {
    return res.status(500).json({ ok: false, error: "ai_estimate_failed" });
  }
});

// Appraisals
app.post('/api/appraisals', (req, res) => {
  const list = readAppraisals();
  const item = { id: Date.now(), createdAt: new Date().toISOString(), ...req.body };
  list.unshift(item); writeAppraisals(list);
  res.json({ ok: true, appraisal: item });
});
app.get('/api/appraisals', (req, res) => {
  const q = (req.query.vin||'').toLowerCase();
  let list = readAppraisals();
  if (q) list = list.filter(a => (a.vin||'').toLowerCase().includes(q));
  res.json(list);
});

// PDF
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
app.post('/api/report', (req, res) => {
  const { vin, vehicle, valuation, history, maintenance, commonIssues, notes, reconItems, carfaxUrl, carfaxSummary, dealer, hiddenMaintenanceCost, additionalCosts } = req.body;
  const filePath = path.join(reportsDir, `${vin || 'report'}_${Date.now()}.pdf`);
  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  doc.fontSize(18).text(dealer?.name || 'OpenSource Autos - Appraisal Report', { align:'center' });
  if (dealer?.address) doc.moveDown(0.2).fontSize(10).text(dealer.address,{align:'center'});
  if (dealer?.phone) doc.text(dealer.phone,{align:'center'});
  if (dealer?.site) doc.text(dealer.site,{align:'center'});
  doc.moveDown();

  doc.moveDown().fontSize(14).text(`VIN: ${vin || 'N/A'}`);
  if (vehicle) doc.text(`Vehicle: ${vehicle}`);

  doc.moveDown().fontSize(12).text('Valuation', { underline: true });
  if (valuation && typeof valuation === 'object' && ('wholesale' in valuation || 'retail' in valuation)) {
    if (valuation.wholesale !== undefined) doc.fontSize(11).text(`Wholesale: $${Number(valuation.wholesale).toLocaleString()}`);
    if (valuation.retail !== undefined) doc.fontSize(11).text(`Retail: $${Number(valuation.retail).toLocaleString()}`);
    doc.fontSize(10).text('Details:');
    doc.fontSize(9).text(JSON.stringify(valuation, null, 2));
  } else {
    doc.fontSize(10).text(typeof valuation === 'string' ? valuation : JSON.stringify(valuation, null, 2));
  }

  doc.moveDown().fontSize(12).text('History', { underline: true });
  doc.fontSize(10).text(typeof history === 'string' ? history : JSON.stringify(history, null, 2));

  doc.moveDown().fontSize(12).text('Maintenance', { underline: true });
  doc.fontSize(10).text(typeof maintenance === 'string' ? maintenance : JSON.stringify(maintenance, null, 2));
  if (commonIssues && Array.isArray(commonIssues.issues) && commonIssues.issues.length) {
    doc.moveDown(0.5).fontSize(11).text('Common Issues:');
    commonIssues.issues.forEach((it) => {
      doc.fontSize(10).text(`• ${it.title}${it.details ? ' — ' + it.details : ''}`);
    });
    if (commonIssues.notes) doc.moveDown(0.2).fontSize(9).text(commonIssues.notes);
  }

  if (carfaxSummary && typeof carfaxSummary === 'object') {
    doc.moveDown().fontSize(12).text('Carfax Summary', { underline: true });
    Object.entries(carfaxSummary).forEach(([k, v]) => {
      if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) return;
      const val = Array.isArray(v) ? v.join(', ') : String(v);
      doc.fontSize(10).text(`${k}: ${val}`);
    });
  }

  if (notes) {
    doc.moveDown().fontSize(12).text('Notes', { underline: true });
    doc.fontSize(10).text(notes);
  }

  if (reconItems) {
    doc.moveDown().fontSize(12).text('Reconditioning Items', { underline: true });
    doc.fontSize(10).text(Array.isArray(reconItems) ? reconItems.join('\n') : String(reconItems));
  }

  if (carfaxUrl) {
    doc.moveDown().fontSize(10).fillColor('blue').text(`Carfax: ${carfaxUrl}`, { link: carfaxUrl, underline: true });
    doc.fillColor('black');
  }

  const addl = Array.isArray(additionalCosts) ? additionalCosts : [];
  const addlTotal = addl.reduce((s,it)=> s + Number(it.amount||0), 0);
  const hidden = Number(hiddenMaintenanceCost || 0);
  const grand = addlTotal + hidden;

  doc.moveDown().fontSize(12).text('Costs Summary', { underline: true });
  if (addl.length === 0 && !hidden) {
    doc.fontSize(10).text('No additional costs recorded.');
  } else {
    addl.forEach(it => doc.fontSize(10).text(`${it.label}: $${Number(it.amount||0).toLocaleString()}`));
    doc.moveDown(0.2).fontSize(10).text(`Hidden maintenance: $${hidden.toLocaleString()}`);
    doc.moveDown(0.3).fontSize(11).text(`Total additional costs: $${addlTotal.toLocaleString()}`);
    doc.fontSize(11).text(`Grand total (additional + hidden): $${grand.toLocaleString()}`);
  }

  doc.end();
  stream.on('finish', () => res.json({ ok:true, path:filePath, url:`/reports/${path.basename(filePath)}` }));
});

app.get('/healthz', (_, res) => res.json({ ok:true }));
app.listen(PORT, () => console.log(`Used Car Project server running at http://localhost:${PORT}`));
