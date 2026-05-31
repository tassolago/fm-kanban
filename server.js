// server.js — Financial Move Kanban Server (with JSON file state + Google Meet AI)
'use strict';

const express    = require('express');
const cors       = require('cors');
const session    = require('express-session');
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
const teamFile  = path.join(dataDir, 'team.json');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(stateFile)) {
  fs.writeFileSync(stateFile, JSON.stringify({ state: { cards: [], nextId: 1 }, updated_at: Date.now() }), 'utf-8');
}

// ── Dynamic team management ───────────────────────────────────────────────────
function loadDynamicTeam() {
  try { return JSON.parse(fs.readFileSync(teamFile, 'utf-8')); } catch { return []; }
}

function saveDynamicTeam(members) {
  fs.writeFileSync(teamFile, JSON.stringify(members, null, 2), 'utf-8');
}

// Returns merged team: dynamic (auto-registered) + config.js (manual)
function getFullTeam() {
  const dynamic = loadDynamicTeam();
  const dynamicEmails = new Set(dynamic.map(m => m.email));
  // Add config.js members that aren't already registered dynamically
  const fromConfig = team.filter(m => m.email && !dynamicEmails.has(m.email));
  return [...dynamic, ...fromConfig];
}

// Register or update a user on login
function registerUserOnLogin({ email, name, picture }) {
  const members = loadDynamicTeam();
  const existing = members.find(m => m.email === email);
  if (!existing) {
    members.push({
      name:     name || email.split('@')[0],
      email,
      picture:  picture || '',
      area:     '',
      role:     '',
      joinedAt: new Date().toISOString(),
    });
    saveDynamicTeam(members);
    console.log(`[${timestamp()}] 👤 Novo usuário registrado: ${name} (${email})`);
  } else if (existing.picture !== picture || existing.name !== name) {
    // Update name/picture if changed
    existing.name    = name || existing.name;
    existing.picture = picture || existing.picture;
    saveDynamicTeam(members);
  }
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

const SESSION_SECRET = process.env.SESSION_SECRET || 'fm-kanban-secret-2026';
const ALLOWED_DOMAIN = 'financialmove.com.br';
const ADMIN_EMAILS   = (process.env.ADMIN_EMAILS || 'tassolago@financialmove.com.br').split(',').map(s => s.trim());

app.use(cors());
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }, // 7 days
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
const PUBLIC_PATHS = ['/login', '/auth/login', '/auth/callback', '/health'];

function requireAuth(req, res, next) {
  if (PUBLIC_PATHS.some(p => req.path.startsWith(p))) return next();
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ ok: false, error: 'Não autenticado' });
  res.redirect('/login');
}

function requireAdmin(req, res, next) {
  const email = req.session?.user?.email || '';
  if (ADMIN_EMAILS.includes(email)) return next();
  if (req.path.startsWith('/api/')) return res.status(403).json({ ok: false, error: 'Acesso restrito a admins' });
  res.status(403).send('<h2 style="font-family:sans-serif;color:#ef4444;padding:40px;">Acesso restrito.</h2>');
}

app.use(requireAuth);

// ── Login page ────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  const error = req.query.error === 'domain'
    ? '<p style="color:#ef4444;margin-bottom:20px;">Acesso restrito a emails <strong>@financialmove.com.br</strong>. Tente com sua conta corporativa.</p>'
    : '';
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Financial Move — Login</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#e0e0e0;font-family:'Inter',sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:16px;padding:48px 40px;width:380px;text-align:center;box-shadow:0 24px 64px rgba(0,0,0,.6);}
.logo{display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:32px;}
.logo-text{font-family:'Space Grotesk',sans-serif;font-size:20px;font-weight:700;color:#fff;}
.logo-sub{font-size:11px;color:#555;letter-spacing:.5px;margin-top:2px;}
h2{font-size:22px;font-weight:700;color:#fff;margin-bottom:8px;}
p.sub{color:#666;font-size:14px;margin-bottom:32px;line-height:1.6;}
.btn{display:inline-flex;align-items:center;gap:12px;background:#fff;color:#000;font-weight:600;font-size:15px;padding:14px 28px;border-radius:10px;text-decoration:none;width:100%;justify-content:center;transition:opacity .2s;}
.btn:hover{opacity:.9}
.footer{margin-top:24px;font-size:12px;color:#444;}
</style>
</head>
<body>
<div class="card">
  <div class="logo">
    <svg width="38" height="38" viewBox="0 0 36 36" fill="none"><rect width="36" height="36" rx="7" fill="#000"/><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFDD00"/><stop offset="100%" stop-color="#FF8C00"/></linearGradient></defs><rect x="5" y="24" width="5" height="8" rx="1.5" fill="url(#g)"/><rect x="12" y="18" width="5" height="14" rx="1.5" fill="url(#g)"/><rect x="19" y="11" width="5" height="21" rx="1.5" fill="url(#g)"/><rect x="26" y="16" width="5" height="16" rx="1.5" fill="url(#g)"/></svg>
    <div><div class="logo-text">Financial Move</div><div class="logo-sub">GESTÃO DE PROJETOS</div></div>
  </div>
  ${error}
  <h2>Bem-vindo</h2>
  <p class="sub">Acesse com sua conta corporativa<br/><strong style="color:#FF9800;">@financialmove.com.br</strong></p>
  <a href="/auth/login" class="btn">
    <svg width="20" height="20" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
    Entrar com Google
  </a>
  <div class="footer">Apenas membros da Financial Move</div>
</div>
</body></html>`);
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/login');
});

// Endpoint para o frontend saber quem está logado
app.get('/api/me', (req, res) => {
  res.json({ user: req.session.user || null });
});

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
  const full = getFullTeam();
  const safeTeam = full.map(({ name, area, role, email, picture }) => ({
    name, area, role, picture: picture || '',
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

// LOGIN via Google (email scope only)
app.get('/auth/login', (req, res) => {
  if (!googleClientId) return res.status(503).send('GOOGLE_CLIENT_ID not configured');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'select_account',
    scope: [
      'openid',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
    state: 'login',
  });
  res.redirect(url);
});

// DRIVE connection (broader scope)
app.get('/auth/google', (req, res) => {
  if (!googleClientId) return res.status(503).send('GOOGLE_CLIENT_ID not configured');
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ],
    state: 'drive',
  });
  res.redirect(url);
});

// OAuth callback — handles both login and drive connection
app.get('/auth/callback', async (req, res) => {
  const { code, state } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    if (state === 'login') {
      // Fetch user info to verify domain
      const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
      const { data: userInfo } = await oauth2.userinfo.get();
      const email = userInfo.email || '';

      if (!email.endsWith('@' + ALLOWED_DOMAIN)) {
        console.warn(`[${timestamp()}] ⛔ Login blocked: ${email}`);
        req.session.destroy();
        return res.redirect('/login?error=domain');
      }

      req.session.user = { email, name: userInfo.name, picture: userInfo.picture };
      registerUserOnLogin({ email, name: userInfo.name, picture: userInfo.picture });
      console.log(`[${timestamp()}] ✅ Login: ${email}`);
      res.redirect('/');
    } else {
      // Drive connection
      saveGoogleTokens(tokens);
      console.log(`[${timestamp()}] ✅ Google Drive connected`);
      res.redirect('/?google=connected');
    }
  } catch (err) {
    console.error(`[${timestamp()}] ❌ OAuth error:`, err.message);
    res.redirect(state === 'login' ? '/login?error=auth' : '/?google=error');
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
- department: área/departamento se inferível (Dados, Financeiro, Marketing, CS, Comercial, Tech, Operações, Infra, Jurídico, Imprensa), ou null
- priority: "Alta" se urgente/crítico/bloqueante/ASAP/prazo próximo, "Baixa" se pode esperar/não prioritário/longo prazo, "Média" nos demais casos
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
      "priority": "Alta|Média|Baixa",
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

// ── Admin routes ─────────────────────────────────────────────────────────────

// Admin page
app.get('/admin', requireAdmin, (req, res) => {
  const depts = ['Dados','Financeiro','Marketing','CS','Comercial','Tech','Operações','Infra','Jurídico','Imprensa','CEO'];
  res.send(`<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>FM Kanban — Admin</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet"/>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f0f0f;color:#e0e0e0;font-family:'Inter',sans-serif;min-height:100vh;}
.topbar{display:flex;align-items:center;gap:16px;padding:0 28px;height:60px;background:#161616;border-bottom:1px solid #2a2a2a;}
.logo{display:flex;align-items:center;gap:10px;text-decoration:none;}
.logo-text{font-family:'Space Grotesk',sans-serif;font-size:15px;font-weight:700;color:#fff;}
.badge{background:#FF9800;color:#000;font-size:10px;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:.5px;}
.back{margin-left:auto;font-size:13px;color:#666;text-decoration:none;padding:6px 14px;border:1px solid #333;border-radius:6px;}
.back:hover{color:#FF9800;border-color:#FF9800;}
.container{max-width:1000px;margin:36px auto;padding:0 24px;}
h1{font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:700;margin-bottom:6px;}
.sub{color:#666;font-size:14px;margin-bottom:28px;}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;}
table{width:100%;border-collapse:collapse;}
th{padding:12px 16px;text-align:left;font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.8px;border-bottom:1px solid #222;font-weight:500;}
td{padding:12px 16px;border-bottom:1px solid #1e1e1e;font-size:14px;vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr:hover td{background:#1a1a1a;}
.avatar{width:34px;height:34px;border-radius:50%;object-fit:cover;background:#252525;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;color:#888;flex-shrink:0;}
.user-cell{display:flex;align-items:center;gap:10px;}
.user-name{font-weight:500;color:#e0e0e0;}
.user-email{font-size:12px;color:#555;margin-top:1px;}
.joined{font-size:12px;color:#555;}
select,input[type=text]{background:#1e1e1e;border:1px solid #2a2a2a;border-radius:6px;color:#e0e0e0;font-size:13px;padding:6px 10px;font-family:inherit;outline:none;transition:border .2s;}
select:focus,input[type=text]:focus{border-color:#FF9800;}
select{cursor:pointer;}
.btn-save{padding:6px 14px;background:#FF9800;border:none;border-radius:6px;color:#000;font-size:12px;font-weight:700;cursor:pointer;opacity:0;transition:opacity .2s;}
.btn-save.visible{opacity:1;}
.saved{font-size:12px;color:#22c55e;opacity:0;transition:opacity .5s;}
.tag-admin{font-size:10px;background:#FF980020;color:#FF9800;border:1px solid #FF980040;padding:2px 7px;border-radius:4px;margin-left:6px;}
</style>
</head>
<body>
<div class="topbar">
  <a href="/" class="logo">
    <svg width="30" height="30" viewBox="0 0 36 36" fill="none"><rect width="36" height="36" rx="7" fill="#000"/><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#FFDD00"/><stop offset="100%" stop-color="#FF8C00"/></linearGradient></defs><rect x="5" y="24" width="5" height="8" rx="1.5" fill="url(#g)"/><rect x="12" y="18" width="5" height="14" rx="1.5" fill="url(#g)"/><rect x="19" y="11" width="5" height="21" rx="1.5" fill="url(#g)"/><rect x="26" y="16" width="5" height="16" rx="1.5" fill="url(#g)"/></svg>
    <span class="logo-text">Financial Move</span>
  </a>
  <span class="badge">ADMIN</span>
  <a href="/" class="back">← Voltar ao Kanban</a>
</div>

<div class="container">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
    <h1>Gerenciamento de Usuários</h1>
    <button onclick="openAdd()" style="display:flex;align-items:center;gap:6px;padding:9px 16px;background:#FF9800;border:none;border-radius:8px;color:#000;font-size:13px;font-weight:700;cursor:pointer;">+ Adicionar usuário</button>
  </div>
  <p class="sub">Usuários registrados ao fazer login. Adicione manualmente quem ainda não logou.</p>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Usuário</th>
          <th>Setor</th>
          <th>Cargo</th>
          <th>Desde</th>
          <th></th>
        </tr>
      </thead>
      <tbody id="tbody">
        <tr><td colspan="5" style="text-align:center;color:#555;padding:32px;">Carregando…</td></tr>
      </tbody>
    </table>
  </div>
</div>

<script>
const DEPTS = ${JSON.stringify(depts)};

async function load() {
  const r = await fetch('/api/admin/team');
  const { team } = await r.json();
  const tbody = document.getElementById('tbody');
  if (!team.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#555;padding:32px;">Nenhum usuário registrado ainda.</td></tr>';
    return;
  }
  tbody.innerHTML = team.map((m, i) => {
    const isAdmin = ${JSON.stringify(ADMIN_EMAILS)}.includes(m.email);
    const joined = m.joinedAt ? new Date(m.joinedAt).toLocaleDateString('pt-BR') : '—';
    const avatar = m.picture
      ? \`<img src="\${m.picture}" class="avatar" referrerpolicy="no-referrer"/>\`
      : \`<div class="avatar">\${(m.name||'?')[0].toUpperCase()}</div>\`;
    return \`<tr id="row-\${i}">
      <td>
        <div class="user-cell">
          \${avatar}
          <div>
            <div class="user-name">\${m.name || '—'}\${isAdmin ? '<span class="tag-admin">ADMIN</span>' : ''}</div>
            <div class="user-email">\${m.email}</div>
          </div>
        </div>
      </td>
      <td>
        <select id="area-\${i}" onchange="markDirty(\${i})">
          <option value="">— Sem setor —</option>
          \${DEPTS.map(d => \`<option value="\${d}" \${d === m.area ? 'selected' : ''}>\${d}</option>\`).join('')}
        </select>
      </td>
      <td>
        <input type="text" id="role-\${i}" value="\${m.role || ''}" placeholder="Ex: Analista" style="width:160px;" oninput="markDirty(\${i})"/>
      </td>
      <td class="joined">\${joined}</td>
      <td>
        <button class="btn-save" id="save-\${i}" onclick="save(\${i}, '\${m.email}')">Salvar</button>
        <span class="saved" id="saved-\${i}">✓ Salvo</span>
      </td>
    </tr>\`;
  }).join('');
}

function markDirty(i) {
  document.getElementById('save-' + i).classList.add('visible');
  document.getElementById('saved-' + i).style.opacity = 0;
}

async function save(i, email) {
  const area = document.getElementById('area-' + i).value;
  const role = document.getElementById('role-' + i).value.trim();
  const btn  = document.getElementById('save-' + i);
  btn.textContent = '…';
  btn.disabled = true;
  await fetch('/api/admin/team/' + encodeURIComponent(email), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ area, role }),
  });
  btn.textContent = 'Salvar';
  btn.disabled = false;
  btn.classList.remove('visible');
  const saved = document.getElementById('saved-' + i);
  saved.style.opacity = 1;
  setTimeout(() => { saved.style.opacity = 0; }, 2000);
}

load();

function openAdd() { document.getElementById('add-modal').style.display='flex'; document.getElementById('add-email').focus(); }
function closeAdd() { document.getElementById('add-modal').style.display='none'; document.getElementById('add-form').reset(); document.getElementById('add-error').textContent=''; }

document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('add-email').value.trim().toLowerCase();
  const name  = document.getElementById('add-name').value.trim();
  const area  = document.getElementById('add-area').value;
  const role  = document.getElementById('add-role').value.trim();
  const errEl = document.getElementById('add-error');
  if (!email.endsWith('@financialmove.com.br')) { errEl.textContent='Email deve ser @financialmove.com.br'; return; }
  const btn = e.target.querySelector('button[type=submit]');
  btn.textContent='Salvando…'; btn.disabled=true;
  const r = await fetch('/api/admin/team/add', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({email,name,area,role}) });
  const data = await r.json();
  btn.textContent='Adicionar'; btn.disabled=false;
  if (!data.ok) { errEl.textContent = data.error||'Erro ao adicionar.'; return; }
  closeAdd(); load();
});
</script>

<div id="add-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:center;justify-content:center;">
  <div style="background:#161616;border:1px solid #2a2a2a;border-radius:14px;padding:32px;width:420px;max-width:95vw;">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">
      <span style="font-family:'Space Grotesk',sans-serif;font-weight:600;font-size:16px;">Adicionar usuário</span>
      <button onclick="closeAdd()" style="background:none;border:none;color:#666;font-size:22px;cursor:pointer;line-height:1;">×</button>
    </div>
    <form id="add-form" style="display:flex;flex-direction:column;gap:14px;">
      <div>
        <label style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:5px;">Email corporativo *</label>
        <input id="add-email" type="email" placeholder="nome@financialmove.com.br" required style="width:100%;"/>
      </div>
      <div>
        <label style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:5px;">Nome completo *</label>
        <input id="add-name" type="text" placeholder="Ex: João Silva" required style="width:100%;"/>
      </div>
      <div style="display:flex;gap:12px;">
        <div style="flex:1;">
          <label style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:5px;">Setor</label>
          <select id="add-area" style="width:100%;"><option value="">— Sem setor —</option>${depts.map(d=>`<option value="${d}">${d}</option>`).join('')}</select>
        </div>
        <div style="flex:1;">
          <label style="font-size:11px;color:#555;text-transform:uppercase;letter-spacing:.6px;display:block;margin-bottom:5px;">Cargo</label>
          <input id="add-role" type="text" placeholder="Ex: Analista" style="width:100%;"/>
        </div>
      </div>
      <p id="add-error" style="color:#ef4444;font-size:13px;min-height:18px;margin:0;"></p>
      <button type="submit" style="padding:11px;background:#FF9800;border:none;border-radius:8px;color:#000;font-size:14px;font-weight:700;cursor:pointer;">Adicionar</button>
    </form>
  </div>
</div>
</body></html>`);
});

// API: list all team members with full details (admin only)
app.get('/api/admin/team', requireAdmin, (req, res) => {
  const dynamic = loadDynamicTeam();
  const dynamicEmails = new Set(dynamic.map(m => m.email));
  // Include config.js members not yet in dynamic team
  const fromConfig = team.filter(m => m.email && !dynamicEmails.has(m.email)).map(m => ({
    ...m, joinedAt: null, picture: '',
  }));
  res.json({ ok: true, team: [...dynamic, ...fromConfig] });
});

// API: manually add a member (admin only)
app.post('/api/admin/team/add', requireAdmin, (req, res) => {
  const { email, name, area, role } = req.body;
  if (!email || !name) return res.status(400).json({ ok: false, error: 'Email e nome são obrigatórios' });
  if (!email.endsWith('@' + ALLOWED_DOMAIN)) return res.status(400).json({ ok: false, error: 'Email deve ser @' + ALLOWED_DOMAIN });
  const members = loadDynamicTeam();
  if (members.find(m => m.email === email)) return res.status(409).json({ ok: false, error: 'Usuário já cadastrado' });
  members.push({ name, email, area: area || '', role: role || '', picture: '', joinedAt: null });
  saveDynamicTeam(members);
  console.log(`[${timestamp()}] ➕ Admin adicionou: ${name} (${email})`);
  res.json({ ok: true });
});

// API: update a member's area and role (admin only)
app.post('/api/admin/team/:email', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { area, role } = req.body;
  const members = loadDynamicTeam();
  const member = members.find(m => m.email === email);
  if (!member) {
    // Add from config.js if not yet in dynamic team
    const fromConfig = team.find(m => m.email === email);
    if (fromConfig) {
      members.push({ ...fromConfig, area: area ?? fromConfig.area, role: role ?? fromConfig.role, joinedAt: null, picture: '' });
    } else {
      return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });
    }
  } else {
    if (area !== undefined) member.area = area;
    if (role !== undefined) member.role = role;
  }
  saveDynamicTeam(members);
  console.log(`[${timestamp()}] ✏️  Admin update: ${email} → setor=${area} cargo=${role}`);
  res.json({ ok: true });
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
