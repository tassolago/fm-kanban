// server.js — Financial Move Kanban Server (with JSON file state)
'use strict';

const express    = require('express');
const cors       = require('cors');
const nodemailer = require('nodemailer');
const path       = require('path');
const fs         = require('fs');

// ── Config (fallback for local dev) ──────────────────────────────────────────
let config;
try { config = require('./config'); } catch { config = {}; }

const gmailUser     = process.env.GMAIL_USER        || (config.gmail && config.gmail.user)        || '';
const gmailPassword = process.env.GMAIL_APP_PASSWORD || (config.gmail && config.gmail.appPassword) || '';
const appUrl        = process.env.APP_URL            || (config.appUrl) || 'http://localhost:3000';
const team          = (config.team) || [];

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
    <div class="logo-mark">FM</div>
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

// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🚀 Financial Move Kanban Server`);
  console.log(`   URL:    http://localhost:${PORT}`);
  console.log(`   API:    http://localhost:${PORT}/api/state`);
  console.log(`   Gmail:  ${gmailUser || '(not configured)'}`);
  console.log(`   Team:   ${team.length} members (${teamWithEmail().length} with email)`);
  console.log(`   State:  ${stateFile}\n`);
});
