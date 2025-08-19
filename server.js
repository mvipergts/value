require('dotenv').config();
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Simple in-file storage for appraisals so this starter runs without a DB
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
const dataFile = path.join(dataDir, 'appraisals.json');
if (!fs.existsSync(dataFile)) fs.writeFileSync(dataFile, '[]');

function readAppraisals() { return JSON.parse(fs.readFileSync(dataFile, 'utf-8')); }
function writeAppraisals(list) { fs.writeFileSync(dataFile, JSON.stringify(list, null, 2)); }

// --- API STUBS ---
app.get('/api/value/:vin', async (req, res) => {
  const { vin } = req.params;
  // Placeholder logic; replace with real provider later
  const estimate = 12500;
  const wholesale = Math.round(estimate * 0.90);
  const retail = Math.round(estimate * 1.15);
  res.json({ vin, estimate, wholesale, retail, currency: 'USD', source: 'stub' });
});

app.get('/api/history/:vin', async (req, res) => {
  const { vin } = req.params;
  res.json({ vin, accidents: 0, owners: 2, serviceRecords: 7, source: 'stub' });
});

app.get('/api/maintenance/:vin', async (req, res) => {
  const { vin } = req.params;
  res.json({ vin, upcoming: ['Oil change', 'Cabin filter'], intervals: {'Oil change': '5k mi'}, source: 'stub' });
});

// Carfax PDF upload
app.post('/api/carfax/upload', upload.single('file'), (req, res) => {
  const url = `/uploads/${path.basename(req.file.path)}`;
  res.json({ ok: true, path: req.file.path, url });
});

// Publicly serve uploads
app.use('/uploads', express.static(uploadDir));

// Appraisals
app.post('/api/appraisals', (req, res) => {
  const appraisals = readAppraisals();
  const item = { id: Date.now(), createdAt: new Date().toISOString(), ...req.body };
  appraisals.unshift(item);
  writeAppraisals(appraisals);
  res.json({ ok: true, appraisal: item });
});

app.get('/api/appraisals', (req, res) => {
  const { vin } = req.query;
  let list = readAppraisals();
  if (vin) list = list.filter(a => (a.vin||'').toLowerCase().includes(String(vin).toLowerCase()));
  res.json(list);
});

// PDF report generation
const reportsDir = path.join(__dirname, 'reports');
if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

app.post('/api/report', (req, res) => {
  const { vin, vehicle, valuation, history, maintenance, notes, reconItems, carfaxUrl, dealer, hiddenMaintenanceCost, additionalCosts } = req.body;
  const filePath = path.join(reportsDir, `${vin || 'report'}_${Date.now()}.pdf`);
  const doc = new PDFDocument({ margin: 40 });
  const stream = fs.createWriteStream(filePath);
  doc.pipe(stream);

  // Header / Branding
  doc.fontSize(18).text(dealer?.name || 'OpenSource Autos - Appraisal Report', { align: 'center' });
  if (dealer?.address) doc.moveDown(0.2).fontSize(10).text(dealer.address, { align: 'center' });
  if (dealer?.phone) doc.text(dealer.phone, { align: 'center' });
  if (dealer?.site) doc.text(dealer.site, { align: 'center' });
  doc.moveDown();

  doc.moveDown().fontSize(14).text(`VIN: ${vin || 'N/A'}`);
  if (vehicle) doc.text(`Vehicle: ${vehicle}`);

  // Valuation
  doc.moveDown().fontSize(12).text('Valuation', { underline: true });
  if (valuation && typeof valuation === 'object' && ('wholesale' in valuation || 'retail' in valuation)) {
    if (valuation.wholesale !== undefined) doc.fontSize(11).text(`Wholesale: $${Number(valuation.wholesale).toLocaleString()}`);
    if (valuation.retail !== undefined) doc.fontSize(11).text(`Retail: $${Number(valuation.retail).toLocaleString()}`);
    doc.fontSize(10).text('Details:');
    doc.fontSize(9).text(JSON.stringify(valuation, null, 2));
  } else {
    doc.fontSize(10).text(typeof valuation === 'string' ? valuation : JSON.stringify(valuation, null, 2));
  }

  // History
  doc.moveDown().fontSize(12).text('History', { underline: true });
  doc.fontSize(10).text(typeof history === 'string' ? history : JSON.stringify(history, null, 2));

  // Maintenance
  doc.moveDown().fontSize(12).text('Maintenance', { underline: true });
  doc.fontSize(10).text(typeof maintenance === 'string' ? maintenance : JSON.stringify(maintenance, null, 2));

  // Notes
  if (notes) {
    doc.moveDown().fontSize(12).text('Notes', { underline: true });
    doc.fontSize(10).text(notes);
  }

  // Recon
  if (reconItems) {
    doc.moveDown().fontSize(12).text('Reconditioning Items', { underline: true });
    doc.fontSize(10).text(Array.isArray(reconItems) ? reconItems.join('\n') : String(reconItems));
  }

  // Carfax link
  if (carfaxUrl) {
    doc.moveDown().fontSize(10).fillColor('blue').text(`Carfax: ${carfaxUrl}`, { link: carfaxUrl, underline: true });
    doc.fillColor('black');
  }

  // Costs Summary
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
  stream.on('finish', () => {
    res.json({ ok: true, path: filePath, url: `/reports/${path.basename(filePath)}` });
  });
});

// Health check
app.get('/healthz', (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Used Car Project server running at http://localhost:${PORT}`);
});