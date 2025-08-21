
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
const MOCK = process.env.OPENAI_MOCK === '1';
const AI_ENABLED = !!openai && !MOCK;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const uploadDir = path.join(__dirname, 'uploads');
const reportsDir = path.join(__dirname, 'reports');
const dataDir = path.join(__dirname, 'data');
[uploadDir, reportsDir, dataDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

app.use('/uploads', express.static(uploadDir));
app.use('/reports', express.static(reportsDir));

// multer
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_'))
});
const upload = multer({ storage });

// simple store
const storeFile = path.join(dataDir, 'appraisals.json');
if (!fs.existsSync(storeFile)) fs.writeFileSync(storeFile, '[]');
const readStore = () => JSON.parse(fs.readFileSync(storeFile, 'utf8'));
const writeStore = (arr) => fs.writeFileSync(storeFile, JSON.stringify(arr, null, 2));

function safeText(resp) {
  try { if (resp.output_text) return resp.output_text; } catch {}
  try { return resp.choices?.[0]?.message?.content || ''; } catch {}
  return '';
}

// ---- Carfax summary (text only) ----
function extractCarfaxSummary(text) {
  const t = (text || '').replace(/\r/g, '');
  const lower = t.toLowerCase();

  let accidents = 0;
  if (/no accidents? reported/i.test(t)) accidents = 0;
  else {
    const a1 = (t.match(/accident reported/gi) || []).length;
    const a2 = (t.match(/accidents?\/damage/gi) || []).length;
    accidents = Math.max(a1, a2);
  }

  const damageReports = (t.match(/damage reported/gi) || []).length;

  let owners = 0;
  const ownerHeader = (t.match(/owner\s+\d+/gi) || []).length;
  const ownersLine = t.match(/owners?\s*:\s*(\d{1,2})/i);
  owners = Math.max(owners, ownerHeader || 0);
  if (ownersLine) owners = Math.max(owners, parseInt(ownersLine[1], 10));

  const serviceRecords = (t.match(/service\s(record|history|performed|inspected|maintenance)/gi) || []).length;
  const recalls = (t.match(/recall/gi) || []).length;

  let lastOdometer = null;
  const m1 = t.match(/last reported odometer.*?([0-9,]{3,})/i);
  const m2 = t.match(/odometer.*?:\s*([0-9,]{3,})/i);
  if (m1) lastOdometer = m1[1];
  else if (m2) lastOdometer = m2[1];

  const brandingKeywords = ['salvage','rebuilt','junk','flood','lemon','hail','fire','odometer rollback','not actual mileage','tmu','structural damage'];
  const brandings = brandingKeywords.filter(k => lower.includes(k));

  let usage = null;
  if (lower.includes('personal vehicle')) usage = 'Personal';
  else if (lower.includes('commercial vehicle')) usage = 'Commercial';
  else if (lower.includes('fleet vehicle')) usage = 'Fleet';
  else if (lower.includes('rental vehicle')) usage = 'Rental';
  else if (lower.includes('lease vehicle')) usage = 'Lease';

  return { accidents, damageReports, owners, serviceRecords, recalls, lastOdometer, usage, brandings };
}

const COST_MAP = {
  "Oil change": 60, "Cabin filter": 40, "Engine air filter": 45,
  "Tire rotation": 30, "Wheel alignment": 110, "Battery": 180,
  "Brake fluid exchange": 120, "Coolant service": 180, "Transmission service": 250,
  "Spark plugs": 250, "Wiper blades": 30
};

// ---- VIN decode (VPIC) ----
app.get('/api/vin/:vin', async (req, res) => {
  try {
    const vin = String(req.params.vin || '').trim();
    if (!vin) return res.status(400).json({ ok:false, error:'no_vin' });
    const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
    const j = await r.json();
    const row = j?.Results?.[0] || {};
    res.json({
      ok: true, vin,
      year: row.ModelYear || null,
      make: row.Make || null,
      model: row.Model || null,
      trim: row.Trim || row.Series || null,
      bodyClass: row.BodyClass || null
    });
  } catch (e) { res.status(500).json({ ok:false, error:'vin_failed' }); }
});

// ---- Value (mileage aware) ----
app.get('/api/value/:vin', async (req, res) => {
  try {
    const mileage = Number(req.query.mileage || 0);
    const year = Number(req.query.year || 0);
    const base = 12500;
    const now = new Date().getFullYear();
    const age = (year && year > 1900 && year <= now) ? (now - year) : 0;
    const expected = age * 12000;
    const delta = expected ? (mileage - expected) : 0;
    const wholesale = Math.round((base * 0.90) - (delta * 0.06));
    const retail = Math.round((base * 1.15) - (delta * 0.08));
    res.json({ vin: req.params.vin, mileage, year, estimate: base, wholesale, retail, details:{ age, expected, delta } });
  } catch (e) { res.json({ vin: req.params.vin, estimate: 12500, wholesale: 11250, retail: 14375, source: 'stub' }); }
});

// ---- History/Maintenance stubs ----
app.get('/api/history/:vin', (req, res) => res.json({ vin: req.params.vin, accidents: 0, owners: 2, serviceRecords: 7, source:'stub' }));
app.get('/api/maintenance/:vin', (req, res) => res.json({ vin: req.params.vin, upcoming: ['Oil change','Cabin filter'], intervals:{'Oil change':'5k mi'}, source:'stub' }));

// ---- Carfax upload + parse ----
app.post('/api/carfax/upload', upload.single('file'), async (req, res) => {
  try {
    const buffer = fs.readFileSync(req.file.path);
    const parsed = await pdfParse(buffer);
    const text = parsed.text || '';
    const summary = text.trim() ? extractCarfaxSummary(text) : { note:'no_text_extracted' };
    const url = `/uploads/${path.basename(req.file.path)}`;
    res.json({ ok:true, path:req.file.path, url, summary, text });
  } catch (e) {
    const url = `/uploads/${path.basename(req.file.path)}`;
    res.json({ ok:true, path:req.file.path, url, summary:{ error:'parse_failed' }, text:'' });
  }
});

// ---- Carfax summarize pasted text ----
app.post('/api/carfax/summarize-text', async (req, res) => {
  try {
    const { rawText = '' } = req.body || {};
    if (!rawText.trim()) return res.status(400).json({ ok:false, error:'no_text' });
    const summary = extractCarfaxSummary(rawText);
    res.json({ ok:true, summary });
  } catch (e) { res.status(500).json({ ok:false, error:'summarize_failed' }); }
});

// ---- Maintenance gap inference ----
function inferMissingMaintenance({ summary = {}, text = '', mileage = 0, year = 0 }) {
  const t = String(text || '').toLowerCase();
  const m = Number(mileage || 0);
  const now = new Date().getFullYear();
  const age = (year && year > 1900 && year <= now) ? (now - year) : 0;
  const svcCount = Number(summary?.serviceRecords || 0);

  const items = [];
  const push = (label, rationale) => items.push({ label, rationale, source:'carfax_gap' });
  const has = (kw) => t.includes(kw);
  const noneOf = (...kws) => !kws.some(has);

  const expectedSvc = Math.max(2, Math.round(age * 1.2));
  if (svcCount < expectedSvc / 2) {
    push('Oil change', `Low service history (${svcCount}/${expectedSvc} expected)`);
    push('Engine air filter', 'Low service history');
    push('Cabin filter', 'Low service history');
  }
  if (noneOf('oil change','engine oil','changed oil')) push('Oil change', 'No oil change found in Carfax text');
  if (m >= 60000) {
    if (noneOf('transmission service','transmission fluid','trans fluid')) push('Transmission service','>=60k mi and no service noted');
    if (noneOf('brake fluid')) push('Brake fluid exchange','>=60k mi and no service noted');
    if (noneOf('coolant service','coolant flush','radiator flushed')) push('Coolant service','>=60k mi and no service noted');
  }
  if (m >= 90000 && noneOf('spark plug')) push('Spark plugs','>=90k mi and no plugs noted');
  return items;
}

// ---- Adjusted wholesale ----
app.post('/api/value/adjusted', async (req, res) => {
  try {
    const { baseWholesale = 0, carfaxSummary = {}, carfaxText = '', mileage = 0, year = 0 } = req.body || {};
    const items = inferMissingMaintenance({ summary: carfaxSummary, text: carfaxText, mileage, year });
    const priced = items.map(it => ({ ...it, amount: (COST_MAP[it.label] ?? 100) }));
    const deduction = priced.reduce((s, it) => s + Number(it.amount || 0), 0);
    const adjustedWholesale = Math.max(0, Math.round(Number(baseWholesale || 0) - deduction));
    res.json({ ok:true, baseWholesale: Number(baseWholesale||0), deduction, adjustedWholesale, items: priced });
  } catch (e) { res.status(500).json({ ok:false, error:'adjust_failed' }); }
});

// ---- PDF report ----
app.post('/api/report', (req, res) => {
  const { vin, vehicle, valuation, history, maintenance, carfaxUrl, carfaxSummary, hiddenMaintenanceCost, additionalCosts, mileage } = req.body;
  const filePath = path.join(reportsDir, `${vin || 'report'}_${Date.now()}.pdf`);
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  const brand = 'Used Car Project';
  doc.rect(40, 40, 532, 40).fill('#0F172A');
  doc.fillColor('#FFFFFF').fontSize(16).text(brand, 50, 52, { width: 512, align: 'left' });
  doc.fillColor('#475569').fontSize(10);
  doc.moveTo(40, 90).lineTo(572, 90).strokeColor('#E2E8F0').lineWidth(1).stroke();

  doc.fillColor('#0F172A').fontSize(18).text('Vehicle Appraisal Report', 40, 100);
  doc.fontSize(10).fillColor('#475569').text(new Date().toLocaleString(), { align: 'right' });

  const y0 = 130;
  doc.roundedRect(40, y0, 532, 90, 8).strokeColor('#E2E8F0').lineWidth(1).stroke();
  doc.fontSize(11).fillColor('#0F172A');
  const top1 = [['VIN', vin || 'N/A'], ['Vehicle', vehicle || '—'], ['Mileage', (typeof mileage !== 'undefined') ? `${Number(mileage||0).toLocaleString()} mi` : '—']];
  const wholesale = valuation?.wholesale != null ? `$${Number(valuation.wholesale).toLocaleString()}` : '—';
  const retail = valuation?.retail != null ? `$${Number(valuation.retail).toLocaleString()}` : '—';
  const top2 = [['Wholesale', wholesale], ['Retail', retail], ['Recon Total', '$0']];
  const colW = 532/2;
  let y = y0 + 12;
  top1.forEach((kv, i) => { const yy = y + i*18; doc.text(kv[0], 50, yy, { width: colW-20, continued: true }).fillColor('#111827').text(kv[1]).fillColor('#0F172A'); });
  top2.forEach((kv, i) => { const yy = y + i*18; doc.text(kv[0], 50+colW, yy, { width: colW-20, continued: true }).fillColor('#111827').text(kv[1]).fillColor('#0F172A'); });

  function section(title) { y = doc.y + 16; doc.fillColor('#334155').fontSize(12).text(title, 40, y); doc.moveDown(0.2); doc.moveTo(40, doc.y).lineTo(572, doc.y).strokeColor('#E2E8F0').lineWidth(1).stroke(); doc.moveDown(0.3); doc.fillColor('#0F172A').fontSize(10); }
  section('History'); doc.text(history ? JSON.stringify(history, null, 2) : '—');
  section('Maintenance'); doc.text(maintenance ? JSON.stringify(maintenance, null, 2) : '—');
  if (carfaxSummary) { section('Carfax Summary'); doc.text(JSON.stringify(carfaxSummary, null, 2)); }
  if (carfaxUrl) { doc.moveDown().fontSize(10).fillColor('#2563EB').text(`Carfax: ${carfaxUrl}`, { link: carfaxUrl, underline: true }); doc.fillColor('#0F172A'); }

  doc.moveTo(40, 740).lineTo(572, 740).strokeColor('#E2E8F0').lineWidth(1).stroke();
  doc.fontSize(9).fillColor('#64748B').text('Generated by Used Car Project', 40, 745);

  doc.end();
  stream.on('finish', () => res.json({ ok:true, path:filePath, url:`/reports/${path.basename(filePath)}` }));
});

app.get('/healthz', (_, res) => res.json({ ok:true }));

app.listen(PORT, () => console.log(`Server running at http://0.0.0.0:${PORT}`));


  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Palette
  const brand = 'Used Car Project';
  const cPrimary = '#2563EB';  // blue
  const cGreen   = '#10B981';  // emerald
  const cAmber   = '#F59E0B';  // amber
  const cIndigo  = '#6366F1';  // indigo
  const cText    = '#0F172A';
  const cMuted   = '#475569';
  const cRule    = '#E2E8F0';

  // Header bar
  doc.rect(40, 40, 532, 46).fill(cPrimary);
  doc.fillColor('#FFFFFF').fontSize(16).text('Vehicle Appraisal (Customer Copy)', 50, 52, { width: 400 });
  doc.fontSize(10).text(new Date().toLocaleString(), 50, 72);
  doc.fillColor('#FFFFFF').fontSize(10).text(brand, 522, 52, { width: 40, align: 'right' });
  doc.fillColor(cText);

  // Vehicle banner
  const bannerY = 100;
  doc.roundedRect(40, bannerY, 532, 68, 8).strokeColor(cRule).lineWidth(1).stroke();
  doc.fillColor(cText).fontSize(14).text(vehicle || 'Vehicle', 50, bannerY + 12, { width: 400 });
  doc.fillColor(cMuted).fontSize(10).text(`VIN: ${vin || '—'}`, 50, bannerY + 36, { width: 260 });
  if (mileage) doc.text(`Mileage: ${Number(mileage||0).toLocaleString()} mi`, 310, bannerY + 36, { width: 262, align: 'right' });
  doc.fillColor(cText);

  // Valuation cards (left column)
  let y = bannerY + 84;
  const colW = 260;

  // Card helper
  function card(x, y, w, h, title, accent) {
    doc.roundedRect(x, y, w, h, 10).fillAndStroke(accent, cRule);
    doc.fillColor('#FFFFFF').fontSize(11).text(title, x + 12, y + 10);
    doc.fillColor(cText);
    doc.roundedRect(x, y + 28, w, h - 28, 10).fill('#FFFFFF').strokeColor(cRule).stroke();
  }

  // Value card
  const wWholesale = valuation?.wholesale != null ? `$${Number(valuation.wholesale).toLocaleString()}` : '—';
  const wRetail = valuation?.retail != null ? `$${Number(valuation.retail).toLocaleString()}` : '—';
  const adj = (adjustedWholesale != null) ? `$${Number(adjustedWholesale).toLocaleString()}` : '—';
  const ded = deduction ? `$${Number(deduction).toLocaleString()}` : '$0';

  card(40, y, colW, 150, 'Valuation', cGreen);
  doc.fontSize(11).fillColor(cText);
  const leftX = 40 + 14, leftW = colW - 28;
  const line = (k, v) => { doc.font('Helvetica-Bold').text(k, leftX, doc.y + 6, { continued: true, width: leftW/2 }); doc.font('Helvetica').text(v, leftX + leftW/2, doc.y - 14, { align: 'right', width: leftW/2 }); };
  doc.moveDown(1.2);
  line('Retail', wRetail);
  line('Wholesale', wWholesale);
  line('Maint. deduction', `-${ded}`);
  line('Wholesale (after gaps)', adj);

  // Carfax at a glance (right column)
  card(312, y, colW, 150, 'Carfax at a glance', cIndigo);
  doc.fontSize(11).fillColor(cText);
  const rightX = 312 + 14, rightW = colW - 28;
  const cf = carfaxSummary || {};
  const cfRows = [
    ['Accidents', cf.accidents ?? '—'],
    ['Owners', cf.owners ?? '—'],
    ['Service records', cf.serviceRecords ?? '—'],
    ['Usage', cf.usage || '—']
  ];
  doc.text(' ', 312, y + 34); // move into body
  cfRows.forEach(([k,v]) => { doc.font('Helvetica-Bold').text(k, rightX, doc.y + 6, { continued:true, width:rightW/2 }); doc.font('Helvetica').text(String(v), rightX + rightW/2, doc.y - 14, { align:'right', width:rightW/2 }); });

  y += 170;

  // Maintenance deductions breakdown
  const tableH = 160;
  card(40, y, 532, tableH, 'Maintenance Deductions (Reasonable Estimates)', cAmber);
  doc.text(' ', 40, y + 34);
  const headerY = doc.y;
  doc.fontSize(10).fillColor(cMuted).text('Item', 54, headerY, { width: 200 });
  doc.text('Amount', 340, headerY, { width: 80, align: 'right' });
  doc.text('Why', 430, headerY, { width: 130 });
  doc.moveTo(50, headerY + 14).lineTo(560, headerY + 14).strokeColor(cRule).lineWidth(1).stroke();
  doc.fillColor(cText);
  let rowY = headerY + 18;
  const rows = Array.isArray(gapItems) ? gapItems : [];
  if (rows.length === 0) {
    doc.text('No deductions applied.', 54, rowY);
  } else {
    rows.forEach((it, i) => {
      const bg = (i % 2 === 0) ? '#F8FAFC' : '#FFFFFF';
      doc.rect(44, rowY - 4, 520, 18).fill(bg);
      doc.fillColor(cText).text(it.label || '', 54, rowY, { width: 200 });
      doc.text(`$${Number(it.amount||0).toLocaleString()}`, 340, rowY, { width: 80, align:'right' });
      doc.fillColor(cMuted).text(it.rationale || '', 430, rowY, { width: 130 });
      rowY += 20;
    });
  }
  doc.fillColor(cText);
  doc.moveTo(50, rowY + 4).lineTo(560, rowY + 4).strokeColor(cRule).stroke();
  doc.font('Helvetica-Bold').text('Total deduction', 54, rowY + 8, { width: 200 });
  doc.font('Helvetica').text(ded, 340, rowY + 8, { width: 80, align:'right' });

  // Footer link + disclaimer
  doc.fillColor(cMuted).fontSize(9);
  if (carfaxUrl) doc.text(`Carfax: ${carfaxUrl}`, 40, 740, { link: carfaxUrl, underline: true });
  doc.text('Estimates are for guidance only and not an official offer. Values depend on inspection/condition.', 40, 752);

  doc.end();
  stream.on('finish', () => res.json({ ok:true, url:`/reports/${path.basename(filePath)}` }));
});

// ---------- Common issues (AI-backed; falls back to mock) ----------
    const text = safeText(resp) || '{"issues":[]}';
    const data = JSON.parse(text);
    return res.json({ ok:true, ...data });
  } catch (e) {
    console.error('common-issues error', e);
    res.status(500).json({ ok:false, error:'common_issues_failed' });
  }
});

// ---------- Customer PDF (clean, branded, with maintenance deduction breakdown) ----------
app.post('/api/report/customer', (req, res) => {
  const { vin, vehicle='', valuation={}, adjustedWholesale=null, deduction=0, gapItems=[], carfaxSummary={}, carfaxUrl='', mileage=0, additionalCosts=[] } = req.body || {};
  const filePath = path.join(reportsDir, `${vin || 'customer'}_${Date.now()}.pdf`);
  const doc = new PDFDocument({ margin: 40, size: 'LETTER' });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Palette
  const brand = 'Used Car Project';
  const cPrimary = '#2563EB';  // blue
  const cGreen   = '#10B981';  // emerald
  const cAmber   = '#F59E0B';  // amber
  const cIndigo  = '#6366F1';  // indigo
  const cText    = '#0F172A';
  const cMuted   = '#475569';
  const cRule    = '#E2E8F0';

  // Header bar
  doc.rect(40, 40, 532, 46).fill(cPrimary);
  doc.fillColor('#FFFFFF').fontSize(16).text('Vehicle Appraisal (Customer Copy)', 50, 52, { width: 400 });
  doc.fontSize(10).text(new Date().toLocaleString(), 50, 72);
  doc.fillColor('#FFFFFF').fontSize(10).text(brand, 522, 52, { width: 40, align: 'right' });
  doc.fillColor(cText);

  // Vehicle banner
  const bannerY = 100;
  doc.roundedRect(40, bannerY, 532, 68, 8).strokeColor(cRule).lineWidth(1).stroke();
  doc.fillColor(cText).fontSize(14).text(vehicle || 'Vehicle', 50, bannerY + 12, { width: 400 });
  doc.fillColor(cMuted).fontSize(10).text(`VIN: ${vin || '—'}`, 50, bannerY + 36, { width: 260 });
  if (mileage) doc.text(`Mileage: ${Number(mileage||0).toLocaleString()} mi`, 310, bannerY + 36, { width: 262, align: 'right' });
  doc.fillColor(cText);

  // Values
  let y = bannerY + 84;
  const colW = 260;
  function card(x, y, w, h, title, accent) {
    doc.roundedRect(x, y, w, h, 10).fillAndStroke(accent, cRule);
    doc.fillColor('#FFFFFF').fontSize(11).text(title, x + 12, y + 10);
    doc.fillColor(cText);
    doc.roundedRect(x, y + 28, w, h - 28, 10).fill('#FFFFFF').strokeColor(cRule).stroke();
  }
  const wWholesale = valuation?.wholesale != null ? `$${Number(valuation.wholesale).toLocaleString()}` : '—';
  const wRetail = valuation?.retail != null ? `$${Number(valuation.retail).toLocaleString()}` : '—';
  const adj = (adjustedWholesale != null) ? `$${Number(adjustedWholesale).toLocaleString()}` : '—';
  const ded = deduction ? `$${Number(deduction).toLocaleString()}` : '$0';

  card(40, y, colW, 170, 'Valuation', cGreen);
  doc.fontSize(11).fillColor(cText);
  const LX = 40 + 14, LW = colW - 28;
  const line = (k, v) => { doc.font('Helvetica-Bold').text(k, LX, doc.y + 6, { continued: true, width: LW/2 }); doc.font('Helvetica').text(v, LX + LW/2, doc.y - 14, { align: 'right', width: LW/2 }); };
  doc.moveDown(1.2);
  line('Retail', wRetail);
  line('Wholesale', wWholesale);
  line('Maint. deduction', `-${ded}`);
  line('Wholesale (after gaps)', adj);

  // Recon card
  const reconTotal = (Array.isArray(additionalCosts) ? additionalCosts.reduce((s,it)=>s+Number(it.amount||0),0) : 0);
  const targetBuy = (adjustedWholesale != null) ? Math.max(0, Number(adjustedWholesale) - reconTotal) : null;
  card(312, y, colW, 170, 'Reconditioning Costs', cIndigo);
  doc.fontSize(11).fillColor(cText);
  const RX = 312 + 14, RW = colW - 28;
  doc.text(' ', 312, y + 34);
  line('Reconditioning total', `$${reconTotal.toLocaleString()}`);
  line('Target purchase price', targetBuy != null ? `$${Number(targetBuy).toLocaleString()}` : '—');

  y += 190;

  // Maintenance deductions breakdown
  const tableH = 160;
  card(40, y, 532, tableH, 'Maintenance Deductions (Reasonable Estimates)', cAmber);
  doc.text(' ', 40, y + 34);
  const headerY = doc.y;
  doc.fontSize(10).fillColor(cMuted).text('Item', 54, headerY, { width: 200 });
  doc.text('Amount', 340, headerY, { width: 80, align: 'right' });
  doc.text('Why', 430, headerY, { width: 130 });
  doc.moveTo(50, headerY + 14).lineTo(560, headerY + 14).strokeColor(cRule).lineWidth(1).stroke();
  doc.fillColor(cText);
  let rowY = headerY + 18;
  const rows = Array.isArray(gapItems) ? gapItems : [];
  if (rows.length === 0) {
    doc.text('No deductions applied.', 54, rowY);
  } else {
    rows.forEach((it, i) => {
      const bg = (i % 2 === 0) ? '#F8FAFC' : '#FFFFFF';
      doc.rect(44, rowY - 4, 520, 18).fill(bg);
      doc.fillColor(cText).text(it.label || '', 54, rowY, { width: 200 });
      doc.text(`$${Number(it.amount||0).toLocaleString()}`, 340, rowY, { width: 80, align:'right' });
      doc.fillColor(cMuted).text(it.rationale || '', 430, rowY, { width: 130 });
      rowY += 20;
    });
  }
  doc.fillColor(cText);
  doc.moveTo(50, rowY + 4).lineTo(560, rowY + 4).strokeColor(cRule).stroke();
  doc.font('Helvetica-Bold').text('Total deduction', 54, rowY + 8, { width: 200 });
  doc.font('Helvetica').text(ded, 340, rowY + 8, { width: 80, align:'right' });


  // Evidence summary (if provided through body.evidence)
  try {
    const ev = req.body && req.body.evidence ? req.body.evidence : null;
    if (ev) {
      let y2 = rowY + 38;
      if (y2 < 540) y2 = 540;
      // Evidence card
      function card(x, y, w, h, title, accent) {
        doc.roundedRect(x, y, w, h, 10).fillAndStroke(accent, cRule);
        doc.fillColor('#FFFFFF').fontSize(11).text(title, x + 12, y + 10);
        doc.fillColor(cText);
        doc.roundedRect(x, y + 28, w, h - 28, 10).fill('#FFFFFF').strokeColor(cRule).stroke();
      }
      const cardH = 130;
      card(40, y2, 532, cardH, 'Evidence Summary', cPrimary);
      doc.text(' ', 40, y2 + 34);
      const yy = doc.y;
      doc.fontSize(10).fillColor(cText).text(`NHTSA Recalls: ${ev.counts?.recalls ?? 0}`, 54, yy);
      doc.text(`Complaints: ${ev.counts?.complaints ?? 0}`, 200, yy);
      doc.text(`TSBs: ${ev.counts?.tsbs ?? 0}`, 340, yy);
      doc.moveTo(50, yy + 14).lineTo(560, yy + 14).strokeColor(cRule).lineWidth(1).stroke();
      const risks = Array.isArray(ev.topRisks)?ev.topRisks.slice(0,4):[];
      let ry = yy + 20;
      risks.forEach(r => { doc.text(`• ${r.label} — score ${r.score} (${r.rationale})`, 54, ry, { width: 500 }); ry += 14; });
    }
  } catch(e){}

  // Footer
  doc.fillColor(cMuted).fontSize(9);

  if (carfaxUrl) doc.text(`Carfax: ${carfaxUrl}`, 40, 740, { link: carfaxUrl, underline: true });
  doc.text('Estimates are for guidance only and not an official offer. Values depend on inspection/condition.', 40, 752);

  doc.end();
  stream.on('finish', () => res.json({ ok:true, url:`/reports/${path.basename(filePath)}` }));
});

// ---------- Common issues (NHTSA + optional web search; NO OpenAI required) ----------
app.post('/api/maintenance/common-issues', async (req, res) => {
  try {
    const { vin='', vehicle='' } = req.body || {};
    // Try to parse "2015 HONDA Accord ..." from vehicle banner
    let year = null, make = null, model = null;
    try {
      const parts = (vehicle||'').split(/\s+/);
      const y = parseInt(parts[0], 10);
      if (!isNaN(y)) { year = y; make = parts[1] || null; model = parts[2] || null; }
    } catch {}
    // If not parsed, decode VIN to get make/model/year
    if ((!year || !make || !model) && vin){
      try {
        const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
        const j = await r.json();
        const row = j?.Results?.[0] || {};
        year = year || parseInt(row.ModelYear, 10) || null;
        make = make || row.Make || null;
        model = model || row.Model || null;
      } catch {}
    }

    // Helper to fetch safely
    async function getJSON(url){
      try { const r = await fetch(url, { timeout: 12000 }); return await r.json(); }
      catch(e){ return null; }
    }

    // NHTSA: Recalls + Complaints (ODI)
    let recalls = [];
    let complaints = [];
    if (make && model && year){
      const rec = await getJSON(`https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`);
      if (rec && rec.results) recalls = rec.results;

      const cmp = await getJSON(`https://api.nhtsa.gov/Complaints/ByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`);
      if (cmp && cmp.results) complaints = cmp.results;
    }

    // Heuristic keyword bucketing from complaint component/summary
    const buckets = [
      { key:'engine', label:'Engine / Oil consumption' },
      { key:'trans', label:'Transmission' },
      { key:'brake', label:'Brakes' },
      { key:'air bag', label:'Airbags / SRS' },
      { key:'electr', label:'Electrical' },
      { key:'steering', label:'Steering' },
      { key:'susp', label:'Suspension' },
      { key:'fuel', label:'Fuel system' },
      { key:'ac', label:'HVAC / A/C' },
      { key:'paint', label:'Paint / Exterior' },
    ];
    const counts = new Map();
    complaints.forEach(c => {
      const txt = `${c?.component || ''} ${c?.summary || ''} ${c?.narrative || ''}`.toLowerCase();
      buckets.forEach(b => {
        if (txt.includes(b.key)) counts.set(b.label, (counts.get(b.label)||0)+1);
      });
    });
    const top = Array.from(counts.entries()).sort((a,b)=>b[1]-a[1]).slice(0,6);
    const issues = top.map(([label,count]) => ({ title: label, details: `${count} complaint(s) in NHTSA database` }));

    const noteParts = [];
    if (recalls.length) noteParts.push(`${recalls.length} active/archived recall(s)`);
    if (!issues.length && complaints.length) noteParts.push(`${complaints.length} complaints found (varied components)`);
    const note = noteParts.join(' · ') || 'Data from NHTSA ODI (public).';

    // Optional: Web search (SERPAPI)
    const SERP_API_KEY = process.env.SERP_API_KEY || '';
    if (SERP_API_KEY && make && model) {
      try {
        const q = `${year||''} ${make} ${model} common problems`;
        const resp = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=5&api_key=${SERP_API_KEY}`);
        const data = await resp.json();
        const snippets = (data?.organic_results || []).map(r => r.snippet || '').join(' ').toLowerCase();
        const add = [];
        buckets.forEach(b => { if (snippets.includes(b.key)) add.push(b.label); });
        add.slice(0,3).forEach(lbl => { if (!issues.find(i => i.title === lbl)) issues.push({ title: lbl, details: 'Mentioned across top web results' }); });
      } catch {}
    }

    res.json({ ok:true, issues, note, source: 'nhtsa+web' });
  } catch (e) {
    console.error('common-issues (nhtsa) error', e);
    res.status(500).json({ ok:false, error:'common_issues_failed' });
  }
});

// ---------- Technical Service Bulletins (TSB) via DOT Socrata dataset (no key required) ----------
app.post('/api/maintenance/tsb', async (req, res) => {
  try {
    const { vin='', vehicle='' } = req.body || {};

    // Try to parse "2015 HONDA Accord ..." from vehicle banner
    let year = null, make = null, model = null;
    try {
      const parts = (vehicle||'').split(/\s+/);
      const y = parseInt(parts[0], 10);
      if (!isNaN(y)) { year = y; make = parts[1] || null; model = parts[2] || null; }
    } catch {}

    // If not parsed, decode VIN to get make/model/year
    if ((!year || !make || !model) && vin){
      try {
        const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
        const j = await r.json();
        const row = j?.Results?.[0] || {};
        year = year || parseInt(row.ModelYear, 10) || null;
        make = make || row.Make || null;
        model = model || row.Model || null;
      } catch {}
    }
    if (!year || !make || !model) return res.status(400).json({ ok:false, error:'need_year_make_model' });

    // Query Socrata dataset (TSB summaries). Dataset ID: hczg-qbhf
    const baseUrl = 'https://data.transportation.gov/resource/hczg-qbhf.json';
    const url = `${baseUrl}?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&model_year=${encodeURIComponent(year)}&$limit=50`;
    const headers = { 'Accept': 'application/json' };
    if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;

    let data = [];
    try {
      const r = await fetch(url, { headers });
      data = await r.json();
      if (!Array.isArray(data)) data = [];
    } catch (e) {
      return res.status(502).json({ ok:false, error:'tsb_fetch_failed' });
    }

    // Normalize fields
    const items = data.map(d => {
      const title = d.component || d.system_type || 'TSB';
      const tsbNum = d.bulletin_number || d.tsb_number || d.nhtsa_tsb_number || '';
      const summary = d.summary || d.bulletin_summary || d.bulletinsummary || d.description || '';
      return { title: tsbNum ? `${title} (${tsbNum})` : title, summary };
    }).slice(0, 25);

    res.json({ ok:true, year, make, model, count: items.length, items, source: 'nhtsa-tsb (DOT Socrata)' });
  } catch (e) {
    console.error('tsb route error', e);
    res.status(500).json({ ok:false, error:'tsb_error' });
  }
});

// ---------- Evidence (NHTSA Recalls + Complaints + TSB) with risk scoring ----------
app.post('/api/evidence/score', async (req, res) => {
  try {
    const { vin='', vehicle='' } = req.body || {};

    // Parse/derive Y/M/M
    let year = null, make = null, model = null;
    try {
      const parts = (vehicle||'').trim().split(/\s+/);
      const y = parseInt(parts[0], 10);
      if (!isNaN(y)) { year = y; make = parts[1] || null; model = parts[2] || null; }
    } catch {}
    if ((!year || !make || !model) && vin){
      try {
        const r = await fetch(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${encodeURIComponent(vin)}?format=json`);
        const j = await r.json();
        const row = j?.Results?.[0] || {};
        year = year || parseInt(row.ModelYear, 10) || null;
        make = make || row.Make || null;
        model = model || row.Model || null;
      } catch {}
    }
    if (!year || !make || !model) return res.status(400).json({ ok:false, error:'need_year_make_model' });

    async function getJSON(url){ try { const r = await fetch(url); return await r.json(); } catch { return null; } }

    // Fetch NHTSA recalls + complaints
    let recalls = [];
    let complaints = [];
    const rec = await getJSON(`https://api.nhtsa.gov/recalls/recallsByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`);
    if (rec && rec.results) recalls = rec.results;
    const cmp = await getJSON(`https://api.nhtsa.gov/Complaints/ByVehicle?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&modelYear=${encodeURIComponent(year)}`);
    if (cmp && cmp.results) complaints = cmp.results;

    // Fetch TSBs via DOT Socrata
    const baseUrl = 'https://data.transportation.gov/resource/hczg-qbhf.json';
    let tsbs = [];
    try {
      const headers = { 'Accept': 'application/json' };
      if (process.env.SOCRATA_APP_TOKEN) headers['X-App-Token'] = process.env.SOCRATA_APP_TOKEN;
      const url = `${baseUrl}?make=${encodeURIComponent(make)}&model=${encodeURIComponent(model)}&model_year=${encodeURIComponent(year)}&$limit=100`;
      const r = await fetch(url, { headers }); tsbs = await r.json(); if (!Array.isArray(tsbs)) tsbs = [];
    } catch { tsbs = []; }

    // Buckets
    const buckets = [
      { key:'engine', label:'Engine / Oil consumption' },
      { key:'trans', label:'Transmission' },
      { key:'brake', label:'Brakes' },
      { key:'air bag', label:'Airbags / SRS' },
      { key:'electr', label:'Electrical' },
      { key:'steering', label:'Steering' },
      { key:'susp', label:'Suspension' },
      { key:'fuel', label:'Fuel system' },
      { key:'ac', label:'HVAC / A/C' },
      { key:'paint', label:'Paint / Exterior' },
    ];
    const lowerIncludes = (txt, needle) => (txt||'').toLowerCase().includes(needle);
    const buckCounts = new Map(); // complaints
    const buckTSB = new Map();    // has tsb mention
    const buckRecall = new Map(); // has recall mention

    complaints.forEach(c => {
      const txt = `${c?.component || ''} ${c?.summary || ''} ${c?.narrative || ''}`.toLowerCase();
      buckets.forEach(b => { if (lowerIncludes(txt, b.key)) buckCounts.set(b.label, (buckCounts.get(b.label)||0)+1); });
    });

    recalls.forEach(r => {
      const txt = `${r?.Component || ''} ${r?.Summary || ''}`.toLowerCase();
      buckets.forEach(b => { if (lowerIncludes(txt, b.key)) buckRecall.set(b.label, true); });
    });

    tsbs.forEach(t => {
      const txt = `${t?.component || ''} ${t?.system_type || ''} ${t?.summary || ''}`.toLowerCase();
      buckets.forEach(b => { if (lowerIncludes(txt, b.key)) buckTSB.set(b.label, true); });
    });

    const scored = buckets.map(b => {
      const c = buckCounts.get(b.label)||0;
      const hasT = !!buckTSB.get(b.label);
      const hasR = !!buckRecall.get(b.label);
      const score = (hasT?3:0) + (hasR?2:0) + Math.floor(c/10); // simple weighting
      const rationale = [
        hasT ? 'TSB present (+3)' : null,
        hasR ? 'Recall mention (+2)' : null,
        c ? `${c} complaints (~+${Math.floor(c/10)})` : null
      ].filter(Boolean).join(' · ');
      return { label: b.label, complaints: c, tsb: hasT, recall: hasR, score, rationale };
    }).filter(x => x.score > 0).sort((a,b)=>b.score-a.score).slice(0,5);

    // Optional: web corroboration via SerpAPI allowlist
    const SERP_API_KEY = process.env.SERP_API_KEY || '';
    const allow = ['nhtsa.gov','carcomplaints.com','repairpal.com','consumerreports.org','iihs.org','edmunds.com','kbb.com','cars.com','autorecalls']; // rough
    let webSignals = [];
    if (SERP_API_KEY) {
      try {
        const q = `${year} ${make} ${model} common problems`;
        const resp = await fetch(`https://serpapi.com/search.json?engine=google&q=${encodeURIComponent(q)}&num=10&api_key=${SERP_API_KEY}`);
        const data = await resp.json();
        const org = (data?.organic_results || []).filter(r => {
          try { const u = new URL(r.link); return allow.some(d => u.hostname.includes(d)); } catch { return false; }
        });
        const snippets = org.map(r=> (r.snippet||'').toLowerCase()).join(' ');
        buckets.forEach(b => {
          if (snippets.includes(b.key)) {
            const idx = scored.findIndex(s => s.label === b.label);
            if (idx >= 0) { scored[idx].score += 1; scored[idx].rationale += ' · web corroboration (+1)'; }
            else webSignals.push(b.label);
          }
        });
      } catch {}
      scored.sort((a,b)=>b.score-a.score);
    }

    // Suggested recon items (non-binding hints)
    function suggestCosts(label){
      const out = [];
      const push = (lbl, amt, why) => out.push({ label: lbl, amount: amt, rationale: why, source: 'risk_map' });
      if (label.startsWith('Engine')) { push('Engine air filter', 45, 'Engine bucket'); push('Oil change', 60, 'Engine bucket'); }
      else if (label === 'Transmission') { push('Transmission service', 250, 'Trans bucket'); }
      else if (label === 'Brakes') { push('Brakes (pads/rotors est.)', 450, 'Brakes bucket'); }
      else if (label === 'Electrical') { push('Battery', 180, 'Electrical bucket'); }
      else if (label === 'Steering') { push('Wheel alignment', 110, 'Steering bucket'); }
      else if (label === 'Suspension') { push('Suspension inspection', 120, 'Suspension bucket'); }
      else if (label === 'HVAC / A/C') { push('A/C service', 150, 'HVAC bucket'); }
      return out;
    }
    const recommendations = scored.flatMap(s => suggestCosts(s.label));

    res.json({
      ok:true,
      vehicle: { year, make, model },
      counts: { recalls: recalls.length, complaints: complaints.length, tsbs: tsbs.length },
      topRisks: scored,
      recommendations,
      source: 'nhtsa+tsb (+web if configured)'
    });
  } catch (e) {
    console.error('evidence score error', e);
    res.status(500).json({ ok:false, error:'evidence_failed' });
  }
});
