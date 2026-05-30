// server.js — Financial Move Kanban Server (with JSON file state + Google Meet AI)
'use strict';

const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');
const { google } = require('googleapis');
const Anthropic  = require('@anthropic-ai/sdk');

// ── Config (fallback for local dev) ──────────────────────────────────────────
let config;
try { config = require('./config'); } catch { config = {}; }

const gmailUser     = process.env.GMAIL_USER           || (config.gmail && config.gmail.user)        || '';
const gmailPassword = process.env.GMAIL_APP_PASSWORD   || (config.gmail && config.gmail.appPassword) || '';
const appUrl        = process.env.APP_URL               || (config.appUrl) || 'http://localhost:3000';
const team          = (config.team) || [];
const anthropicKey  = process.env.ANTHROPIC_API_KEY    || '';
const googleClientId     = process.env.GOOGLE_CLIENT_ID     || '';
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || '';

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = anthropicKey ? new Anthropic({ apiKey: anthropicKey }) : null;

// ── Google OAuth2 ─────────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  googleClientId,
  googleClientSecret,
  appUrl + '/auth/callback'
);
const tokensFile = path.join(__dirname, 'data', 'google-tokens.json');

function loadGoogleTokens() {
  try { return JSON.parse(fs.readFileSync(tokensFile, 'utf-8')); } catch { return null; }
}
function saveGoogleTokens(tokens) {
  fs.writeFileSync(tokensFile, JSON.stringify(tokens), 'utf-8');
}
// Restore saved tokens on startup
const savedTokens = loadGoogleTokens();
if (savedTokens) oauth2Client.setCredentials(savedTokens);
// Auto-refresh tokens
oauth2Client.on('tokens', (tokens) => {
  const current = loadGoogleTokens() || {};
  saveGoogleTokens({ ...current, ...tokens });
});

// ── JSON file state ───────────────────────────────────────────────────────────
const dataDir  = path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'kanban.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(stateFile)) {
  fs.writeFileSync(stateFile, JSON.stringify({ state: { cards: [], nextId: 1 }, updated_at: Date.now() }), 'utf-8');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return { state: { cards: [], nextId: 1 }, updated_at: Date.now() };
  }
}

function writeState(state) {
  const updated_at = Date.now();
  fs.writeFileSync(stateFile, JSON.stringify({ state, updated_at }), 'utf-8');
  return updated_at;
}

// ── Express app ───────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Nodemailer transporter ────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   465,
  secure: true,
  auth:   { user: gmailUser, pass: gmailPassword },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const teamWithEmail = () => team.filter(m => m.email && m.email.trim() !== '');

function memberByName(name) {
  return team.find(m => m.name === name) || null;
}

function timestamp() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

// ── HTML Email Template ───────────────────────────────────────────────────────
function buildEmailHtml({ subject, headline, body, ctaLabel, ctaUrl }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${subject}</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body { background:#0f0f0f; font-family:'Inter',Arial,sans-serif; color:#e0e0e0; }
  .wrapper { max-width:600px; margin:40px auto; background:#161616; border-radius:12px; overflow:hidden; border:1px solid #2a2a2a; }
  .header { background:#000; padding:32px 40px; border-bottom:3px solid #FF9800; display:flex; align-items:center; gap:14px; }
  .logo-mark { width:42px; height:42px; background:#FF9800; border-radius:8px; display:flex; align-items:center; justify-content:center; font-weight:900; font-size:18px; color:#000; letter-spacing:-1px; flex-shrink:0; }
  .brand-name { font-size:18px; font-weight:700; color:#fff; letter-spacing:0.5px; }
  .brand-sub { font-size:11px; color:#666; letter-spacing:1px; text-transform:uppercase; margin-top:2px; }
  .body { padding:36px 40px; }
  .headline { font-size:22px; font-weight:700; color:#fff; margin-bottom:20px; line-height:1.3; }
  .message { font-size:15px; color:#aaa; line-height:1.7; margin-bottom:28px; }
  .card-box { background:#1e1e1e; border:1px solid #2a2a2a; border-left:4px solid #FF9800; border-radius:8px; padding:18px 22px; margin-bottom:28px; }
  .card-box .label { font-size:11px; color:#666; text-transform:uppercase; letter-spacing:1px; margin-bottom:6px; }
  .card-box .value { font-size:16px; font-weight:600; color:#fff; }
  .meta-row { display:flex; gap:20px; margin-top:14px; flex-wrap:wrap; }
  .meta-item .label { font-size:10px; color:#555; text-transform:uppercase; letter-spacing:1px; margin-bottom:3px; }
  .meta-item .value { font-size:13px; color:#ccc; }
  .cta { display:inline-block; background:#FF9800; color:#000; font-weight:700; font-size:14px; padding:14px 28px; border-radius:8px; text-decoration:none; letter-spacing:0.3px; }
  .footer { padding:24px 40px; border-top:1px solid #1e1e1e; text-align:center; }
  .footer p { font-size:12px; color:#444; line-height:1.6; }
  .footer strong { color:#666; }
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <div class="logo-mark" style="background:transparent;padding:0;">
      <svg width="42" height="42" viewBox="0 0 42 42" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect width="42" height="42" rx="8" fill="#000"/>
        <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFDD00"/><stop offset="100%" stop-color="#FF8C00"/></linearGradient></defs>
        <rect x="6"  y="29" width="6" height="9"  rx="1.5" fill="url(#bg)"/>
        <rect x="14" y="22" width="6" height="16" rx="1.5" fill="url(#bg)"/>
        <rect x="22" y="13" width="6" height="25" rx="1.5" fill="url(#bg)"/>
        <rect x="30" y="18" width="6" height="20" rx="1.5" fill="url(#bg)"/>
      </svg>
    </div>
    <div>
      <div class="brand-name">Financial Move</div>
      <div class="brand-sub">Kanban · Gestão de Projetos</div>
    </div>
  </div>
  <div class="body">
    <div class="headline">${headline}</div>
    ${body}
    <a href="${ctaUrl}" class="cta">${ctaLabel}</a>
  </div>
  <div class="footer">
    <p>Você está recebendo este email porque faz parte do time <strong>Financial Move</strong>.<br/>
    Esta é uma notificação automática do sistema de Kanban.</p>
  </div>
</div>
</body>
</html>`;
}

function cardMetaHtml(card) {
  const priority = card.priority || '—';
  const dept     = card.department || '—';
  const due      = card.dueDate ? new Date(card.dueDate).toLocaleDateString('pt-BR') : '—';
  const status   = card.status || card.column || '—';
  return `
  <div class="card-box">
    <div class="label">Card</div>
    <div class="value">${card.title || 'Sem título'}</div>
    ${card.description ? `<div style="font-size:13px;color:#888;margin-top:8px;">${card.description}</div>` : ''}
    <div class="meta-row">
      <div class="meta-item"><div class="label">Departamento</div><div class="value">${dept}</div></div>
      <div class="meta-item"><div class="label">Status</div><div class="value">${status}</div></div>
      <div class="meta-item"><div class="label">Prioridade</div><div class="value">${priority}</div></div>
      <div class="meta-item"><div class="label">Prazo</div><div class="value">${due}</div></div>
    </div>
  </div>`;
}

// ── Email composers ───────────────────────────────────────────────────────────
function buildAssignedEmail({ card, assignee, changer }) {
  const changerName = changer || 'Alguém';
  const body = `
    <div class="message">
      <strong style="color:#FF9800;">${changerName}</strong> atribuiu este card a você.
      Acesse o Kanban para ver os detalhes e começar a trabalhar.
    </div>
    ${cardMetaHtml(card)}
    <div class="message" style="margin-bottom:28px;">Clique abaixo para abrir o Kanban e ver seu card.</div>`;
  return buildEmailHtml({
    subject:  `[Kanban FM] Card atribuído: ${card.title}`,
    headline: `📋 Novo card atribuído a você`,
    body,
    ctaLabel: 'Abrir no Kanban →',
    ctaUrl:   appUrl,
  });
}

function buildStatusChangedEmail({ card, assignee, changer }) {
  const changerName = changer || 'Alguém';
  const newStatus   = card.status || card.column || '—';
  const body = `
    <div class="message">
      <strong style="color:#FF9800;">${changerName}</strong> moveu seu card para
      <strong style="color:#fff;">${newStatus}</strong>.
    </div>
    ${cardMetaHtml(card)}`;
  return buildEmailHtml({
    subject:  `[Kanban FM] Status atualizado: ${card.title}`,
    headline: `🔄 Status do card atualizado`,
    body,
    ctaLabel: 'Ver no Kanban →',
    ctaUrl:   appUrl,
  });
}

function buildCommentEmail({ card, assignee, changer, comment }) {
  const changerName = changer || 'Alguém';
  const body = `
    <div class="message">
      <strong style="color:#FF9800;">${changerName}</strong> adicionou um comentário no seu card.
    </div>
    ${cardMetaHtml(card)}
    ${comment ? `
    <div class="card-box" style="border-left-color:#666;margin-bottom:28px;">
      <div class="label">Comentário</div>
      <div class="value" style="font-size:14px;font-weight:400;color:#ccc;">${comment}</div>
    </div>` : ''}`;
  return buildEmailHtml({
    subject:  `[Kanban FM] Novo comentário: ${card.title}`,
    headline: `💬 Comentário adicionado ao seu card`,
    body,
    ctaLabel: 'Ver comentário →',
    ctaUrl:   appUrl,
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
  res.json({ ok: true });
});

// Get kanban state
app.get('/api/state', (req, res) => {
  const { state, updated_at } = readState();
  res.json({ state, updated_at });
});

// Save kanban state
app.post('/api/state', (req, res) => {
  const { state } = req.body;
  if (!state) return res.status(400).json({ ok: false, error: 'Missing state' });
  const updated_at = writeState(state);
  res.json({ ok: true, updated_at });
});

// Team list (no credentials exposed)
app.get('/api/team', (req, res) => {
  const safeTeam = team.map(({ name, area, role, email }) => ({
    name, area, role,
    hasEmail: !!(email && email.trim()),
  }));
  res.json({ ok: true, team: safeTeam });
});

// Notify
app.post('/api/notify', async (req, res) => {
  const { type, card, assignee, changer, comment } = req.body;

  if (!type || !card) {
    return res.status(400).json({ ok: false, error: 'Missing type or card' });
  }

  if (!gmailUser || !gmailPassword) {
    console.warn(`[${timestamp()}] ⚠️  Gmail credentials not configured — skipping email.`);
    return res.status(503).json({ ok: false, error: 'Gmail credentials not configured' });
  }

  try {
    const sent = [];

    if (type === 'assigned') {
      const assigneeMember = memberByName(assignee);
      if (!assigneeMember || !assigneeMember.email) {
        return res.status(400).json({ ok: false, error: 'Assignee has no email configured' });
      }

      const ccList = teamWithEmail()
        .filter(m => m.email !== assigneeMember.email)
        .map(m => m.email);

      const html = buildAssignedEmail({ card, assignee, changer });
      const info = await transporter.sendMail({
        from:    `"Financial Move Kanban" <${gmailUser}>`,
        to:      assigneeMember.email,
        cc:      ccList.join(', '),
        subject: `[Kanban FM] Card atribuído: ${card.title}`,
        html,
      });
      sent.push({ to: assigneeMember.email, messageId: info.messageId });
      console.log(`[${timestamp()}] ✅ assigned → ${assigneeMember.email} | CC: ${ccList.length} | card: "${card.title}"`);

    } else if (type === 'status_changed') {
      const assigneeMember = memberByName(assignee);
      if (!assigneeMember || !assigneeMember.email) {
        return res.status(400).json({ ok: false, error: 'Assignee has no email configured' });
      }
      const html = buildStatusChangedEmail({ card, assignee, changer });
      const info = await transporter.sendMail({
        from:    `"Financial Move Kanban" <${gmailUser}>`,
        to:      assigneeMember.email,
        subject: `[Kanban FM] Status atualizado: ${card.title}`,
        html,
      });
      sent.push({ to: assigneeMember.email, messageId: info.messageId });
      console.log(`[${timestamp()}] ✅ status_changed → ${assigneeMember.email} | status: "${card.status || card.column}" | card: "${card.title}"`);

    } else if (type === 'comment') {
      const assigneeMember = memberByName(assignee);
      if (!assigneeMember || !assigneeMember.email) {
        return res.status(400).json({ ok: false, error: 'Assignee has no email configured' });
      }
      const html = buildCommentEmail({ card, assignee, changer, comment });
      const info = await transporter.sendMail({
        from:    `"Financial Move Kanban" <${gmailUser}>`,
        to:      assigneeMember.email,
        subject: `[Kanban FM] Novo comentário: ${card.title}`,
        html,
      });
      sent.push({ to: assigneeMember.email, messageId: info.messageId });
      console.log(`[${timestamp()}] ✅ comment → ${assigneeMember.email} | card: "${card.title}"`);

    } else {
      return res.status(400).json({ ok: false, error: `Unknown notification type: ${type}` });
    }

    res.json({ ok: true, sent });
  } catch (err) {
    console.error(`[${timestamp()}] ❌ Email error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Google Meet Integration ───────────────────────────────────────────────────

// Step 1: Redirect to Google OAuth consent screen
app.get('/auth/google', (req, res) => {
  if (!googleClientId) return res.status(503).send('GOOGLE_CLIENT_ID not configured');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ],
  });
  res.redirect(url);
});

// Step 2: OAuth callback — save tokens
app.get('/auth/callback', async (req, res) => {
  try {
    const { tokens } = await oauth2Client.getToken(req.query.code);
    saveGoogleTokens(tokens);
    oauth2Client.setCredentials(tokens);
    console.log(`[${timestamp()}] ✅ Google OAuth connected`);
    res.redirect('/?google=connected');
  } catch (err) {
    console.error(`[${timestamp()}] ❌ OAuth error:`, err.message);
    res.redirect('/?google=error');
  }
});

// Google connection status
app.get('/api/google/status', (req, res) => {
  const tokens = loadGoogleTokens();
  res.json({ connected: !!(tokens && (tokens.access_token || tokens.refresh_token)) });
});

// Scan Drive for recent Meet transcripts
app.get('/api/meetings/scan', async (req, res) => {
  const tokens = loadGoogleTokens();
  if (!tokens) return res.status(401).json({ ok: false, error: 'Google não conectado' });

  oauth2Client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Search for Meet transcript Google Docs
    const r1 = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.document' and modifiedTime > '${since}' and (name contains 'Transcript' or name contains 'Transcrição' or name contains 'transcrição' or name contains 'Meet')`,
      fields: 'files(id, name, createdTime, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: 20,
    });

    // Also scan Meet Recordings folder for docs
    const folderR = await drive.files.list({
      q: `name='Meet Recordings' and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id)',
    });

    let extraFiles = [];
    if (folderR.data.files?.length) {
      const folderId = folderR.data.files[0].id;
      const r2 = await drive.files.list({
        q: `'${folderId}' in parents and modifiedTime > '${since}' and mimeType='application/vnd.google-apps.document'`,
        fields: 'files(id, name, createdTime, modifiedTime, webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 10,
      });
      extraFiles = r2.data.files || [];
    }

    const all = [...(r1.data.files || []), ...extraFiles];
    const unique = all.filter((f, i, arr) => arr.findIndex(x => x.id === f.id) === i);

    res.json({ ok: true, files: unique });
  } catch (err) {
    console.error(`[${timestamp()}] ❌ Drive scan error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Process a transcript file with Claude — extract tasks
app.post('/api/meetings/process', async (req, res) => {
  const { fileId, fileName } = req.body;
  if (!fileId) return res.status(400).json({ ok: false, error: 'fileId required' });

  const tokens = loadGoogleTokens();
  if (!tokens) return res.status(401).json({ ok: false, error: 'Google não conectado' });

  if (!anthropic) return res.status(503).json({ ok: false, error: 'ANTHROPIC_API_KEY não configurada' });

  oauth2Client.setCredentials(tokens);
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  try {
    // Export Google Doc as plain text
    const exportRes = await drive.files.export(
      { fileId, mimeType: 'text/plain' },
      { responseType: 'text' }
    );
    const transcript = String(exportRes.data).substring(0, 20000);

    if (!transcript.trim()) {
      return res.status(400).json({ ok: false, error: 'Documento vazio ou sem texto legível' });
    }

    // Extract tasks with Claude
    const teamNames = team.map(m => m.name).join(', ');
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5',
      max_tokens: 2048,
      messages: [{
        role: 'user',
        content: `Você é um assistente que analisa transcrições de reuniões corporativas em português e extrai tarefas e demandas.

Time disponível para atribuição: ${teamNames}

Analise a transcrição abaixo e extraia TODAS as tarefas, demandas, próximos passos e compromissos mencionados.

Para cada tarefa identifique:
- título: descrição curta e clara da tarefa (máx 60 chars)
- assignee: nome EXATO de um membro do time acima, ou null se não mencionado
- dueDate: data no formato YYYY-MM-DD se mencionada, ou null
- department: área/departamento se inferível, ou null
- notes: contexto relevante (máx 100 chars)

Responda SOMENTE com JSON válido, sem markdown, sem explicações:
{
  "meetingTitle": "título da reunião inferido do conteúdo",
  "summary": "resumo de 2-3 linhas do que foi discutido",
  "tasks": [
    {
      "title": "...",
      "assignee": "...",
      "dueDate": "...",
      "department": "...",
      "notes": "..."
    }
  ]
}

Transcrição:
${transcript}`,
      }],
    });

    let extracted;
    try {
      extracted = JSON.parse(message.content[0].text);
    } catch {
      // Try to find JSON in the response
      const match = message.content[0].text.match(/\{[\s\S]*\}/);
      extracted = match ? JSON.parse(match[0]) : { meetingTitle: fileName, tasks: [] };
    }

    console.log(`[${timestamp()}] ✅ Meeting processed: "${extracted.meetingTitle}" — ${extracted.tasks?.length || 0} tasks`);
    res.json({ ok: true, fileId, fileName, ...extracted });
  } catch (err) {
    console.error(`[${timestamp()}] ❌ Meeting process error:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Financial Move Kanban Server`);
  console.log(`   URL:    http://localhost:${PORT}`);
  console.log(`   API:    http://localhost:${PORT}/api/state`);
  console.log(`   Gmail:  ${gmailUser || '(not configured)'}`);
  console.log(`   Team:   ${team.length} members (${teamWithEmail().length} with email)`);
  console.log(`   State:  ${stateFile}\n`);
});
