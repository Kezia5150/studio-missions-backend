// NEUTRON — Backend (Node.js + Express)
const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','x-admin-key'] }));
app.options('*', cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const SITE_URL = process.env.SITE_URL || 'https://neutron.netlify.app';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const DRIVE_FILE_ID = process.env.DRIVE_FILE_ID;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

function getDriveClient() {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

async function readDB() {
  try {
    const drive = getDriveClient();
    const res = await drive.files.get({ fileId: DRIVE_FILE_ID, alt: 'media' });
    const data = res.data;
    return {
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
      editors: Array.isArray(data.editors) ? data.editors : [],
      archivedEditors: Array.isArray(data.archivedEditors) ? data.archivedEditors : [],
      settings: data.settings || { pricePerStar: 20000, briefing: '' }
    };
  } catch (e) {
    console.error('readDB error:', e.message);
    return { tasks: [], editors: [], archivedEditors: [], settings: { pricePerStar: 20000, briefing: '' } };
  }
}

async function writeDB(data) {
  const drive = getDriveClient();
  const { Readable } = require('stream');
  const body = Readable.from([JSON.stringify(data, null, 2)]);
  await drive.files.update({ fileId: DRIVE_FILE_ID, media: { mimeType: 'application/json', body } });
}

async function sendMail(to, subject, html) {
  try {
    const mailer = nodemailer.createTransport({ service: 'gmail', auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD } });
    await mailer.sendMail({ from: `Neutron <${GMAIL_USER}>`, to, subject, html });
  } catch (e) { console.error('Mail error:', e.message); }
}

function mailCorrection(editorName, taskName, note, token, round) {
  return `<div style="font-family:'Segoe UI',sans-serif;background:#0d1521;color:#f0eef5;padding:40px;border-radius:16px;max-width:560px;margin:0 auto;">
    <div style="font-size:22px;font-weight:800;margin-bottom:8px;color:#c38eb4;">Neutron</div>
    <div style="color:#86a8cf;font-size:14px;margin-bottom:32px;">Retour sur votre rendu</div>
    <div style="margin-bottom:16px;">Bonjour <strong>${editorName}</strong>,</div>
    <p style="color:#e1cbd7;line-height:1.7;margin-bottom:24px;">Vous avez reçu un retour <strong>(round ${round}/3)</strong> sur la mission <strong>${taskName}</strong>.</p>
    <div style="background:#1a2744;border:1px solid #2d4d6a;border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="font-size:12px;color:#e8b88a;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Notes du réalisateur</div>
      <p style="color:#e1cbd7;line-height:1.7;margin:0;">${note}</p>
    </div>
    <p style="color:#e1cbd7;font-size:14px;margin-bottom:24px;">Vous disposez de <strong>24 heures</strong> pour apporter les corrections et re-livrer.</p>
    <a href="${SITE_URL}/?token=${token}" style="display:inline-block;background:#c38eb4;color:white;padding:12px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px;">Accéder à ma mission →</a>
    <div style="margin-top:32px;color:#86a8cf;font-size:12px;border-top:1px solid #2d4d6a;padding-top:16px;">Neutron — Ne pas répondre à cet email.</div>
  </div>`;
}

function adminOnly(req, res, next) {
  const key = (req.headers['x-admin-key'] || '').trim();
  const expected = (ADMIN_KEY || '').trim();
  if (key !== expected) { console.log('Auth failed'); return res.status(401).json({ error: 'Non autorisé' }); }
  next();
}

async function checkDeadlines() {
  try {
    const db = await readDB();
    const now = new Date();
    let changed = false;
    db.tasks.forEach(task => {
      if (['accepted','corrections'].includes(task.status) && task.deadline && new Date(task.deadline) < now) {
        task.status = 'available'; task.editorToken = null; task.deadline = null; task.deliveryLink = null;
        changed = true; console.log('Task expired:', task.id);
      }
    });
    if (changed) await writeDB(db);
  } catch (e) { console.error('checkDeadlines error:', e.message); }
}
setInterval(checkDeadlines, 5 * 60 * 1000);

// PUBLIC
app.get('/health', (req, res) => res.json({ ok: true, app: 'Neutron' }));

app.get('/api/settings', async (req, res) => {
  try { const db = await readDB(); res.json(db.settings); }
  catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/editor', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token manquant' });
  try {
    const db = await readDB();
    const editor = db.editors.find(e => e.token === token) || db.archivedEditors.find(e => e.token === token);
    if (!editor) return res.status(403).json({ error: 'Accès refusé' });
    const tasks = db.tasks.filter(t => t.status === 'available' || t.editorToken === token);
    res.json({ editor, tasks, settings: db.settings });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/tasks/:id/accept', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token manquant' });
  try {
    const db = await readDB();
    const editor = db.editors.find(e => e.token === token);
    if (!editor) return res.status(403).json({ error: 'Accès refusé' });
    const task = db.tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
    if (task.status !== 'available') return res.status(409).json({ error: 'Tâche déjà prise' });
    task.status = 'accepted';
    task.editorToken = token;
    task.editorName = editor.name;
    task.acceptedAt = new Date().toISOString();
    task.contractAcceptedAt = new Date().toISOString();
    task.deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    task.correctionRound = 0;
    task.correctionNote = null;
    task.deliveryLink = null;
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/tasks/:id/deliver', async (req, res) => {
  const { token, link } = req.body;
  if (!token || !link) return res.status(400).json({ error: 'Données manquantes' });
  try {
    const db = await readDB();
    const editor = db.editors.find(e => e.token === token);
    if (!editor) return res.status(403).json({ error: 'Accès refusé' });
    const task = db.tasks.find(t => t.id === req.params.id && t.editorToken === token);
    if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
    if (!['accepted','corrections'].includes(task.status)) return res.status(409).json({ error: 'Statut invalide' });
    if (task.deadline && new Date(task.deadline) < new Date()) {
      task.status = 'available'; task.editorToken = null; task.deadline = null;
      await writeDB(db);
      return res.status(410).json({ error: 'Délai expiré' });
    }
    task.status = 'delivered';
    task.deliveryLink = link;
    task.deliveredAt = new Date().toISOString();
    await writeDB(db);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

// ADMIN
app.get('/api/admin/tasks', adminOnly, async (req, res) => {
  try { const db = await readDB(); res.json(db.tasks); }
  catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/tasks', adminOnly, async (req, res) => {
  const { videoName, timecode, stars } = req.body;
  if (!videoName || !timecode || !stars) return res.status(400).json({ error: 'Données manquantes' });
  try {
    const db = await readDB();
    const task = {
      id: crypto.randomUUID(), videoName, timecode, stars: parseInt(stars),
      status: 'available', editorToken: null, editorName: null, deadline: null,
      deliveryLink: null, correctionRound: 0, correctionNote: null,
      contractAcceptedAt: null, paid: false, createdAt: new Date().toISOString()
    };
    db.tasks.unshift(task);
    await writeDB(db);
    res.json(task);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/tasks/:id/withdraw', adminOnly, async (req, res) => {
  try {
    const db = await readDB();
    const task = db.tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
    task.status = 'withdrawn'; task.editorToken = null; task.withdrawnAt = new Date().toISOString();
    await writeDB(db); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/tasks/:id/validate', adminOnly, async (req, res) => {
  try {
    const db = await readDB();
    const task = db.tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
    task.status = 'validated'; task.validatedAt = new Date().toISOString();
    await writeDB(db); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/tasks/:id/refuse', adminOnly, async (req, res) => {
  try {
    const db = await readDB();
    const task = db.tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
    task.status = 'refused'; task.refusedAt = new Date().toISOString();
    await writeDB(db); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/tasks/:id/correct', adminOnly, async (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'Note manquante' });
  try {
    const db = await readDB();
    const task = db.tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
    const nextRound = (task.correctionRound || 0) + 1;
    if (nextRound > 3) {
      task.status = 'refused'; task.refusedAt = new Date().toISOString();
      await writeDB(db); return res.json({ ok: true, refused: true });
    }
    task.status = 'corrections'; task.correctionRound = nextRound;
    task.correctionNote = note;
    task.deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
    await writeDB(db);
    const editor = db.editors.find(e => e.token === task.editorToken);
    if (editor) await sendMail(editor.email, `Retour sur votre mission — ${task.videoName}`, mailCorrection(editor.name, task.videoName, note, editor.token, nextRound));
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/editors', adminOnly, async (req, res) => {
  try { const db = await readDB(); res.json(db.editors); }
  catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.get('/api/admin/editors/archived', adminOnly, async (req, res) => {
  try { const db = await readDB(); res.json(db.archivedEditors); }
  catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/editors', adminOnly, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Données manquantes' });
  try {
    const db = await readDB();
    const token = crypto.randomBytes(24).toString('hex');
    const editor = { id: crypto.randomUUID(), name, email, token, createdAt: new Date().toISOString() };
    db.editors.push(editor);
    await writeDB(db); res.json(editor);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/editors/:id/archive', adminOnly, async (req, res) => {
  try {
    const db = await readDB();
    const idx = db.editors.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Monteur introuvable' });
    const editor = db.editors[idx];
    editor.archivedAt = new Date().toISOString();
    editor.totalEarned = db.tasks.filter(t => t.editorToken === editor.token && t.status === 'validated').reduce((s, t) => s + (db.settings.pricePerStar * t.stars), 0);
    editor.totalMissions = db.tasks.filter(t => t.editorToken === editor.token && t.status === 'validated').length;
    db.archivedEditors.push(editor);
    db.editors.splice(idx, 1);
    await writeDB(db); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/editors/:id/restore', adminOnly, async (req, res) => {
  try {
    const db = await readDB();
    const idx = db.archivedEditors.findIndex(e => e.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Monteur introuvable' });
    const editor = db.archivedEditors[idx];
    delete editor.archivedAt; delete editor.totalEarned; delete editor.totalMissions;
    db.editors.push(editor);
    db.archivedEditors.splice(idx, 1);
    await writeDB(db); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.post('/api/admin/editors/:id/pay', adminOnly, async (req, res) => {
  try {
    const db = await readDB();
    const editor = db.editors.find(e => e.id === req.params.id);
    if (!editor) return res.status(404).json({ error: 'Monteur introuvable' });
    db.tasks.forEach(t => {
      if (t.editorToken === editor.token && t.status === 'validated' && !t.paid) { t.paid = true; t.paidAt = new Date().toISOString(); }
    });
    await writeDB(db); res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.put('/api/admin/settings', adminOnly, async (req, res) => {
  const { pricePerStar, briefing } = req.body;
  try {
    const db = await readDB();
    db.settings = { pricePerStar: parseInt(pricePerStar) || 20000, briefing: briefing || '' };
    await writeDB(db); res.json(db.settings);
  } catch (e) { res.status(500).json({ error: 'Erreur serveur' }); }
});

app.listen(PORT, () => console.log(`Neutron backend running on port ${PORT}`));
