// ─────────────────────────────────────────────────────────────────────────────
// STUDIO MISSIONS — Backend (Node.js + Express)
// Deploy on Render.com (free tier)
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// ─── ENV VARS (set in Render dashboard) ───────────────────────────────────────
const PORT = process.env.PORT || 3001;
const ADMIN_KEY = process.env.ADMIN_KEY || 'admin123';
const SITE_URL = process.env.SITE_URL || 'https://your-netlify-site.netlify.app';

// Google Drive
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const DRIVE_FILE_ID = process.env.DRIVE_FILE_ID; // ID du fichier JSON dans Drive

// Gmail (notifications)
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

// ─── GOOGLE DRIVE CLIENT ──────────────────────────────────────────────────────
function getDriveClient() {
  const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  return google.drive({ version: 'v3', auth });
}

async function readDB() {
  try {
    const drive = getDriveClient();
    const res = await drive.files.get({ fileId: DRIVE_FILE_ID, alt: 'media' });
    return res.data;
  } catch (e) {
    console.error('readDB error:', e.message);
    return { tasks: [], editors: [], settings: { pricePerStar: 0, briefing: '' } };
  }
}

async function writeDB(data) {
  const drive = getDriveClient();
  const { Readable } = require('stream');
  const body = Readable.from([JSON.stringify(data, null, 2)]);
  await drive.files.update({
    fileId: DRIVE_FILE_ID,
    media: { mimeType: 'application/json', body }
  });
}

// ─── MAILER ───────────────────────────────────────────────────────────────────
function getMailer() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD }
  });
}

async function sendMail(to, subject, html) {
  try {
    const mailer = getMailer();
    await mailer.sendMail({ from: `Studio Missions <${GMAIL_USER}>`, to, subject, html });
  } catch (e) {
    console.error('Mail error:', e.message);
  }
}

// ─── EMAIL TEMPLATES ──────────────────────────────────────────────────────────
function mailCorrection(editorName, taskName, note, token, round) {
  return `
  <div style="font-family:'Segoe UI',sans-serif;background:#0a0a0f;color:#f0f0f8;padding:40px;border-radius:16px;max-width:560px;margin:0 auto;">
    <div style="font-size:22px;font-weight:800;margin-bottom:8px;">Studio Missions</div>
    <div style="color:#6b6b8a;font-size:14px;margin-bottom:32px;">Retour sur votre rendu</div>
    <div style="margin-bottom:16px;">Bonjour <strong>${editorName}</strong>,</div>
    <p style="color:#c0c0d8;line-height:1.7;margin-bottom:24px;">
      Vous avez reçu un retour (round ${round}/3) sur la mission <strong style="color:#f0f0f8;">${taskName}</strong>.
    </p>
    <div style="background:#1c1c28;border:1px solid #2a2a3a;border-radius:12px;padding:20px;margin-bottom:24px;">
      <div style="font-size:12px;color:#ffb347;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">Notes du réalisateur</div>
      <p style="color:#c0c0d8;line-height:1.7;margin:0;">${note}</p>
    </div>
    <p style="color:#c0c0d8;font-size:14px;margin-bottom:24px;">Vous disposez de <strong style="color:#f0f0f8;">24 heures</strong> pour apporter les corrections et re-livrer.</p>
    <a href="${SITE_URL}/?token=${token}" style="display:inline-block;background:#c8f135;color:#0a0a0f;padding:12px 28px;border-radius:8px;font-weight:700;text-decoration:none;font-size:15px;">
      Accéder à ma mission →
    </a>
    <div style="margin-top:32px;color:#6b6b8a;font-size:12px;border-top:1px solid #2a2a3a;padding-top:16px;">
      Studio Missions — Ne pas répondre à cet email.
    </div>
  </div>`;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
function adminOnly(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== ADMIN_KEY) return res.status(401).json({ error: 'Non autorisé' });
  next();
}

// ─── DEADLINE CHECKER (toutes les 5 min) ─────────────────────────────────────
async function checkDeadlines() {
  const db = await readDB();
  const now = new Date();
  let changed = false;

  db.tasks.forEach(task => {
    if (['accepted', 'corrections'].includes(task.status) && task.deadline) {
      if (new Date(task.deadline) < now) {
        task.status = 'available';
        task.editorToken = null;
        task.deadline = null;
        task.deliveryLink = null;
        changed = true;
        console.log(`Task expired: ${task.id}`);
      }
    }
  });

  if (changed) await writeDB(db);
}

setInterval(checkDeadlines, 5 * 60 * 1000);

// ─── ROUTES : PUBLIC ──────────────────────────────────────────────────────────

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Settings
app.get('/api/settings', async (req, res) => {
  const db = await readDB();
  res.json(db.settings);
});

// Editor view (by token)
app.get('/api/editor', async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: 'Token manquant' });

  const db = await readDB();
  const editor = db.editors.find(e => e.token === token);
  if (!editor) return res.status(403).json({ error: 'Accès refusé' });

  // Return tasks: available ones + their own tasks
  const tasks = db.tasks.filter(t =>
    t.status === 'available' || t.editorToken === token
  );

  res.json({ editor, tasks, settings: db.settings });
});

// Accept task
app.post('/api/tasks/:id/accept', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token manquant' });

  const db = await readDB();
  const editor = db.editors.find(e => e.token === token);
  if (!editor) return res.status(403).json({ error: 'Accès refusé' });

  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
  if (task.status !== 'available') return res.status(409).json({ error: 'Tâche déjà prise' });

  task.status = 'accepted';
  task.editorToken = token;
  task.acceptedAt = new Date().toISOString();
  task.deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  task.correctionRound = 0;
  task.deliveryLink = null;

  await writeDB(db);
  res.json({ ok: true });
});

// Deliver task
app.post('/api/tasks/:id/deliver', async (req, res) => {
  const { token, link } = req.body;
  if (!token || !link) return res.status(400).json({ error: 'Données manquantes' });

  const db = await readDB();
  const editor = db.editors.find(e => e.token === token);
  if (!editor) return res.status(403).json({ error: 'Accès refusé' });

  const task = db.tasks.find(t => t.id === req.params.id && t.editorToken === token);
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
  if (!['accepted', 'corrections'].includes(task.status)) return res.status(409).json({ error: 'Statut invalide' });

  // Check deadline
  if (task.deadline && new Date(task.deadline) < new Date()) {
    task.status = 'available';
    task.editorToken = null;
    await writeDB(db);
    return res.status(410).json({ error: 'Délai expiré' });
  }

  task.status = 'delivered';
  task.deliveryLink = link;
  task.deliveredAt = new Date().toISOString();

  await writeDB(db);
  res.json({ ok: true });
});

// ─── ROUTES : ADMIN ───────────────────────────────────────────────────────────

// Get all tasks
app.get('/api/admin/tasks', adminOnly, async (req, res) => {
  const db = await readDB();
  res.json(db.tasks);
});

// Create task
app.post('/api/admin/tasks', adminOnly, async (req, res) => {
  const { videoName, timecode, stars } = req.body;
  if (!videoName || !timecode || !stars) return res.status(400).json({ error: 'Données manquantes' });

  const db = await readDB();
  const task = {
    id: crypto.randomUUID(),
    videoName,
    timecode,
    stars: parseInt(stars),
    status: 'available',
    editorToken: null,
    deadline: null,
    deliveryLink: null,
    correctionRound: 0,
    correctionNote: null,
    paid: false,
    createdAt: new Date().toISOString()
  };
  db.tasks.unshift(task);
  await writeDB(db);
  res.json(task);
});

// Withdraw task
app.post('/api/admin/tasks/:id/withdraw', adminOnly, async (req, res) => {
  const db = await readDB();
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
  task.status = 'withdrawn';
  task.editorToken = null;
  await writeDB(db);
  res.json({ ok: true });
});

// Validate task
app.post('/api/admin/tasks/:id/validate', adminOnly, async (req, res) => {
  const db = await readDB();
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
  task.status = 'validated';
  task.validatedAt = new Date().toISOString();
  await writeDB(db);
  res.json({ ok: true });
});

// Refuse task
app.post('/api/admin/tasks/:id/refuse', adminOnly, async (req, res) => {
  const db = await readDB();
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' });
  task.status = 'refused';
  task.editorToken = null;
  await writeDB(db);
  res.json({ ok: true });
});

// Send corrections
app.post('/api/admin/tasks/:id/correct', adminOnly, async (req, res) => {
  const { note } = req.body;
  if (!note) return res.status(400).json({ error: 'Note manquante' });

  const db = await readDB();
  const task = db.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Tâche introuvable' });

  const nextRound = (task.correctionRound || 0) + 1;

  if (nextRound > 3) {
    task.status = 'refused';
    await writeDB(db);
    return res.json({ ok: true, refused: true });
  }

  task.status = 'corrections';
  task.correctionRound = nextRound;
  task.correctionNote = note;
  task.deadline = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  await writeDB(db);

  // Send email notification
  const editor = db.editors.find(e => e.token === task.editorToken);
  if (editor) {
    await sendMail(
      editor.email,
      `Retour sur votre mission — ${task.videoName}`,
      mailCorrection(editor.name, task.videoName, note, editor.token, nextRound)
    );
  }

  res.json({ ok: true });
});

// Get all editors
app.get('/api/admin/editors', adminOnly, async (req, res) => {
  const db = await readDB();
  res.json(db.editors);
});

// Create editor
app.post('/api/admin/editors', adminOnly, async (req, res) => {
  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Données manquantes' });

  const db = await readDB();
  const token = crypto.randomBytes(24).toString('hex');
  const editor = {
    id: crypto.randomUUID(),
    name,
    email,
    token,
    createdAt: new Date().toISOString()
  };
  db.editors.push(editor);
  await writeDB(db);
  res.json(editor);
});

// Mark editor paid
app.post('/api/admin/editors/:id/pay', adminOnly, async (req, res) => {
  const db = await readDB();
  const editor = db.editors.find(e => e.id === req.params.id);
  if (!editor) return res.status(404).json({ error: 'Monteur introuvable' });

  // Mark all validated unpaid tasks as paid
  db.tasks.forEach(t => {
    if (t.editorToken === editor.token && t.status === 'validated' && !t.paid) {
      t.paid = true;
      t.paidAt = new Date().toISOString();
    }
  });

  await writeDB(db);
  res.json({ ok: true });
});

// Update settings
app.put('/api/admin/settings', adminOnly, async (req, res) => {
  const { pricePerStar, briefing } = req.body;
  const db = await readDB();
  db.settings = { pricePerStar: parseInt(pricePerStar)||0, briefing: briefing||'' };
  await writeDB(db);
  res.json(db.settings);
});

// ─── START ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => console.log(`Studio Missions backend running on port ${PORT}`));
