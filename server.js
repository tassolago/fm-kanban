// server.js — Financial Move Kanban Server (with JSON file state + Google Meet AI)
'use strict';

const express    = require('express');
const cors       = require('cors');
const session    = require('express-session');
const FileStore  = require('session-file-store')(session);
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
const dataDir   = path.join(__dirname, 'data');
const stateFile = path.join(dataDir, 'kanban.json');
const backupFile = path.join(dataDir, 'kanban.backup.json');
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
    const raw = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    // Valida que o arquivo não está corrompido/vazio
    if (raw && raw.state && Array.isArray(raw.state.cards)) return raw;
    throw new Error('invalid state format');
  } catch {
    // Tenta recuperar do backup
    try {
      const backup = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
      if (backup && backup.state && Array.isArray(backup.state.cards) && backup.state.cards.length > 0) {
        console.warn(`[${timestamp()}] ⚠️  Estado principal inválido — recuperando do backup (${backup.state.cards.length} cards)`);
        return backup;
      }
    } catch {}
    return { state: { cards: [], nextId: 1 }, updated_at: Date.now() };
  }
}

function writeState(state) {
  const updated_at = Date.now();
  const payload = JSON.stringify({ state, updated_at });
  // Só sobrescreve se o novo estado tiver cards OU se o estado atual também já está vazio
  const current = readStateRaw();
  if (current && current.state && current.state.cards && current.state.cards.length > 0 && state.cards.length === 0) {
    console.warn(`[${timestamp()}] ⚠️  Bloqueado: tentativa de salvar estado vazio sobre ${current.state.cards.length} cards existentes`);
    return current.updated_at;
  }
  // Salva backup antes de sobrescrever (se há dados reais)
  if (state.cards && state.cards.length > 0) {
    try { fs.writeFileSync(backupFile, payload, 'utf-8'); } catch {}
  }
  fs.writeFileSync(stateFile, payload, 'utf-8');
  return updated_at;
}

function readStateRaw() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf-8')); } catch { return null; }
}

// ── Solicitações de mudança de prazo ────────────────────────────────────────────
const dateReqFile = path.join(dataDir, 'date-requests.json');
function loadDateRequests() {
  try { return JSON.parse(fs.readFileSync(dateReqFile, 'utf-8')); } catch { return []; }
}
function saveDateRequests(reqs) {
  try { fs.writeFileSync(dateReqFile, JSON.stringify(reqs, null, 2), 'utf-8'); } catch {}
}
// Normaliza headOf (legado string OU array) → array de setores
function headDepts(member) {
  if (!member) return [];
  const h = member.headOf;
  if (Array.isArray(h)) return h.filter(Boolean);
  return h ? [h] : [];
}
function isHeadOf(member, dept) {
  return headDepts(member).includes(dept);
}

// Contexto/papel do usuário no fluxo de aprovação
function userContext(email) {
  const e = (email || '').toLowerCase();
  const m = getFullTeam().find(x => (x.email || '').toLowerCase() === e);
  return {
    email:   e,
    name:    m?.name || e,
    area:    m?.area || '',
    headDepts: headDepts(m),                  // setores que chefia (array)
    isFinal: e === FINAL_APPROVER,            // aprovador final (COO)
    isAdmin: ADMIN_EMAILS.map(a=>a.toLowerCase()).includes(e),
  };
}

// ── Express app ───────────────────────────────────────────────────────────────
const app  = express();
const PORT = process.env.PORT || 3000;

const SESSION_SECRET = process.env.SESSION_SECRET || 'fm-kanban-secret-2026';
const ALLOWED_DOMAIN = 'financialmove.com.br';
const ADMIN_EMAILS   = (process.env.ADMIN_EMAILS || 'tassolago@financialmove.com.br').split(',').map(s => s.trim());
// Aprovador final do fluxo de prazo (após o chefe do setor). Default: COO Victor Lago.
const FINAL_APPROVER = (process.env.FINAL_APPROVER_EMAIL || 'financeiro@financialmove.com.br').toLowerCase().trim();

app.use(cors());
app.use(express.json());
app.use(session({
  // Sessões gravadas no volume persistente — sobrevivem a redeploys (login dura 7 dias de verdade)
  store: new FileStore({
    path:    path.join(dataDir, 'sessions'),
    ttl:     7 * 24 * 60 * 60,   // 7 dias (segundos)
    retries: 1,
    reapInterval: 24 * 60 * 60,  // limpa sessões expiradas 1x/dia
    logFn:   () => {},           // silencia logs internos
  }),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,                 // renova o prazo a cada acesso
  cookie: { secure: false, httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
}));

// ── Auth middleware ───────────────────────────────────────────────────────────
const PUBLIC_PATHS = ['/login', '/auth/login', '/auth/callback', '/health', '/api/admin/import-cards'];

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
  if (!req.session.user) return res.json({ user: null });
  const { email, name, picture } = req.session.user;
  const member = getFullTeam().find(m => m.email === email);
  const area = member?.area || '';
  const meHeads = headDepts(member);
  const isAdmin = ADMIN_EMAILS.includes(email);
  const ehChefeDeSetor = meHeads.length > 0;

  // "Chefe de todos" = primeiro admin (topo da hierarquia)
  const topChief = getFullTeam().find(m => ADMIN_EMAILS.includes(m.email));
  const topChiefName = topChief?.name || ADMIN_EMAILS[0];

  // Cadeia: subordinado → chefe do setor → chefe de todos (admin)
  let chefe = '';
  if (!isAdmin) {
    if (area && !meHeads.includes(area)) {
      // subordinado: chefe é o chefe do setor (se houver); senão, o chefe de todos
      const head = getFullTeam().find(m => headDepts(m).includes(area) && m.email !== email);
      chefe = head ? head.name : topChiefName;
    } else {
      // chefe de setor (ou sem setor): responde ao chefe de todos
      chefe = topChiefName;
    }
  }

  res.json({ user: {
    email, name, picture,
    area,
    role:   member?.role || '',
    headOf: meHeads,                                    // setores que ele chefia (array)
    isHead: ehChefeDeSetor,                             // é chefe de algum setor
    chefe,                                              // nome do chefe dele na hierarquia ('' se for o topo)
    isAdmin,
    isFinal: (email || '').toLowerCase() === FINAL_APPROVER, // aprovador final (COO)
  }});
});

// ── Nodemailer transporter ────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   'smtp.gmail.com',
  port:   465,
  secure: true,
  auth:   { user: gmailUser, pass: gmailPassword },
});

// ── Helpers ───────────────────────────────────────────────────────────────────
// IMPORTANTE: usa getFullTeam() (usuários registrados no login + config.js),
// NÃO a lista estática `team` que fica vazia no Railway.
const teamWithEmail = () => getFullTeam().filter(m => m.email && m.email.trim() !== '');

function memberByName(name) {
  return getFullTeam().find(m => m.name === name) || null;
}

function adminEmailsWithName() {
  return ADMIN_EMAILS;
}

// Colunas por setor no servidor (espelha o frontend) — usado para detectar card "concluído"
const SRV_DEFAULT_COLUMNS = [
  { id:'backlog',   label:'Backlog' },
  { id:'andamento', label:'Em andamento' },
  { id:'revisao',   label:'Revisão' },
  { id:'concluido', label:'Concluído' },
];
function getServerColumns(dept) {
  const raw = readState();
  const dc = raw.state && raw.state.deptColumns;
  if (dc && dc[dept]) return dc[dept];
  return SRV_DEFAULT_COLUMNS;
}
function isCardDone(card) {
  const cols = getServerColumns(card.dept);
  const lastId = cols[cols.length - 1]?.id;
  return card.column === lastId;
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
    <img src="https://res.cloudinary.com/dsir40des/image/upload/v1780237002/fm_logo_b6rej0.png" width="42" height="42" alt="Financial Move" style="display:block;width:42px;height:42px;object-fit:contain;flex-shrink:0;"/>
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
  const dept     = card.dept || card.department || '—';
  const due      = card.dueDate ? new Date(card.dueDate + 'T00:00').toLocaleDateString('pt-BR') : '—';
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

function buildDeadlineEmail({ card, type, diffDays }) {
  const isOverdue = type === 'overdue';
  const accent = isOverdue ? '#ef4444' : '#FF9800';
  let prazoTexto;
  if (isOverdue) {
    const dias = Math.abs(diffDays);
    prazoTexto = `Este card está <strong style="color:${accent};">VENCIDO há ${dias} dia${dias!==1?'s':''}</strong>.`;
  } else if (diffDays === 0) {
    prazoTexto = `O prazo deste card é <strong style="color:${accent};">HOJE</strong>.`;
  } else {
    prazoTexto = `O prazo deste card vence em <strong style="color:${accent};">${diffDays} dia${diffDays!==1?'s':''}</strong>.`;
  }
  const body = `
    <div class="message">
      Olá <strong style="color:${accent};">${card.assignee || 'time'}</strong>, ${prazoTexto}
      ${isOverdue ? 'Atualize o status ou solicite ajuste de prazo ao seu gestor.' : 'Garanta a entrega no prazo ou avise antecipadamente se precisar de mais tempo.'}
    </div>
    ${cardMetaHtml(card)}`;
  return buildEmailHtml({
    subject:  isOverdue ? `⚠️ [Kanban FM] Prazo VENCIDO: ${card.title}` : `⏰ [Kanban FM] Prazo se aproximando: ${card.title}`,
    headline: isOverdue ? `⚠️ Prazo vencido` : `⏰ Prazo se aproximando`,
    body,
    ctaLabel: 'Abrir no Kanban →',
    ctaUrl:   appUrl,
  });
}

function fmtDate(d) {
  return d ? new Date(d + 'T00:00').toLocaleDateString('pt-BR') : '—';
}

// Email: solicitação chegou para o aprovador (chefe ou COO)
function buildDateReqToApprover({ reqObj, card, approverRole }) {
  const quem = approverRole === 'final' ? 'aprovação final' : 'sua aprovação';
  const body = `
    <div class="message">
      <strong style="color:#FF9800;">${reqObj.requestedByName}</strong> solicitou mudança de prazo de um card
      ${approverRole === 'final' ? 'e o chefe do setor já aprovou. Falta a ' + quem + '.' : 'e aguarda ' + quem + '.'}
    </div>
    ${cardMetaHtml({ ...card, status: card.status || card.column })}
    <div class="card-box" style="border-left-color:#FF9800;">
      <div class="meta-row">
        <div class="meta-item"><div class="label">Prazo atual</div><div class="value" style="color:#f87171;">${fmtDate(reqObj.oldDate)}</div></div>
        <div class="meta-item"><div class="label">Novo prazo pedido</div><div class="value" style="color:#4ade80;">${fmtDate(reqObj.newDate)}</div></div>
      </div>
      ${reqObj.reason ? `<div style="margin-top:12px;"><div class="label">Justificativa</div><div class="value" style="font-weight:400;color:#ccc;font-size:14px;">${reqObj.reason}</div></div>` : ''}
    </div>
    <div class="message">Abra o Kanban e clique no sininho 🔔 para aprovar ou rejeitar.</div>`;
  return buildEmailHtml({
    subject:  `[Kanban FM] Aprovação de prazo: ${card.title}`,
    headline: `🔔 Solicitação de mudança de prazo`,
    body, ctaLabel: 'Abrir no Kanban →', ctaUrl: appUrl,
  });
}

// Email: resultado para quem solicitou (aprovado/rejeitado)
function buildDateReqOutcome({ reqObj, card, outcome, by }) {
  const ok = outcome === 'approved';
  const accent = ok ? '#22c55e' : '#ef4444';
  const body = `
    <div class="message">
      Sua solicitação de mudança de prazo foi
      <strong style="color:${accent};">${ok ? 'APROVADA' : 'REJEITADA'}</strong> por <strong>${by}</strong>.
    </div>
    ${cardMetaHtml({ ...card, dueDate: ok ? reqObj.newDate : reqObj.oldDate, status: card.status || card.column })}
    <div class="card-box" style="border-left-color:${accent};">
      <div class="meta-row">
        <div class="meta-item"><div class="label">Prazo anterior</div><div class="value">${fmtDate(reqObj.oldDate)}</div></div>
        <div class="meta-item"><div class="label">${ok ? 'Novo prazo' : 'Prazo solicitado (negado)'}</div><div class="value" style="color:${accent};">${fmtDate(reqObj.newDate)}</div></div>
      </div>
      ${(!ok && reqObj.rejectionReason) ? `<div style="margin-top:12px;"><div class="label">Motivo</div><div class="value" style="font-weight:400;color:#ccc;font-size:14px;">${reqObj.rejectionReason}</div></div>` : ''}
    </div>`;
  return buildEmailHtml({
    subject:  `[Kanban FM] Prazo ${ok ? 'aprovado' : 'rejeitado'}: ${card.title}`,
    headline: ok ? `✅ Mudança de prazo aprovada` : `❌ Mudança de prazo rejeitada`,
    body, ctaLabel: 'Ver no Kanban →', ctaUrl: appUrl,
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

// Diagnóstico — mostra quantos cards estão salvos no servidor (admin only)
app.get('/api/debug/state', requireAdmin, (req, res) => {
  const { state, updated_at } = readState();
  const backupExists = fs.existsSync(backupFile);
  let backupCards = 0;
  try { backupCards = JSON.parse(fs.readFileSync(backupFile, 'utf-8')).state.cards.length; } catch {}
  res.json({
    cards: state.cards.length,
    nextId: state.nextId,
    deptColumns: Object.keys(state.deptColumns || {}),
    updated_at: new Date(updated_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }),
    backupExists,
    backupCards,
  });
});

// Recuperar backup (admin only)
app.post('/api/debug/restore-backup', requireAdmin, (req, res) => {
  try {
    const backup = JSON.parse(fs.readFileSync(backupFile, 'utf-8'));
    if (!backup || !backup.state || !Array.isArray(backup.state.cards)) {
      return res.status(400).json({ ok: false, error: 'Backup inválido ou vazio' });
    }
    fs.writeFileSync(stateFile, JSON.stringify(backup), 'utf-8');
    console.log(`[${timestamp()}] 🔄 Estado restaurado do backup: ${backup.state.cards.length} cards`);
    res.json({ ok: true, cards: backup.state.cards.length });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Get kanban state
app.get('/api/state', (req, res) => {
  const { state, updated_at } = readState();
  res.json({ state, updated_at });
});

// Save kanban state
// Importação de cards (ata de reunião) — admin (sessão) OU token via header.
// Pula cards cujo título já existe (evita duplicar com cards já criados).
app.post('/api/admin/import-cards', (req, res) => {
  const token = req.headers['x-import-token'];
  const sessionEmail = req.session?.user?.email || '';
  const isAdmin = ADMIN_EMAILS.includes(sessionEmail);
  const tokenOk = process.env.IMPORT_TOKEN && token === process.env.IMPORT_TOKEN;
  if (!isAdmin && !tokenOk) return res.status(403).json({ ok: false, error: 'Não autorizado' });

  const incoming = Array.isArray(req.body.cards) ? req.body.cards : [];
  if (!incoming.length) return res.status(400).json({ ok: false, error: 'Sem cards' });

  const { state } = readState();
  if (!state.cards) state.cards = [];
  if (!state.activity) state.activity = [];
  let nextId = Math.max(state.nextId || 1, state.cards.reduce((m,c)=>Math.max(m,c.id||0),0) + 1);

  const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
  const existing = new Set(state.cards.map(c => norm(c.title)));

  const firstCol = (dept) => {
    const dc = state.deptColumns && state.deptColumns[dept];
    return (dc && dc[0] && dc[0].id) || 'backlog';
  };

  const created = [], skipped = [];
  for (const c of incoming) {
    if (existing.has(norm(c.title))) { skipped.push(c.title); continue; }
    const card = {
      id: nextId++,
      dept: c.dept || '',
      title: c.title || 'Sem título',
      column: firstCol(c.dept),
      assignee: c.assignee || '',
      priority: c.priority || 'Média',
      dueDate: c.dueDate || '',
      description: c.description || '',
      comments: [], createdAt: new Date().toISOString(),
    };
    state.cards.push(card);
    existing.add(norm(card.title));
    state.activity.unshift({ id: Date.now() + Math.random(), ts: new Date().toISOString(),
      user: '🤖 Ata da reunião', text: `criou <b>${(card.title||'').replace(/</g,'&lt;')}</b> em ${card.dept}${card.assignee ? ' · resp. '+card.assignee : ''}` });
    created.push(card.title);
  }
  state.nextId = nextId;
  if (state.activity.length > 120) state.activity = state.activity.slice(0,120);
  const updated_at = writeState(state);
  console.log(`[${timestamp()}] 📥 Import: ${created.length} criado(s), ${skipped.length} pulado(s)`);
  res.json({ ok: true, created, skipped, updated_at });
});

app.post('/api/state', (req, res) => {
  const { state, baseUpdatedAt } = req.body;
  if (!state) return res.status(400).json({ ok: false, error: 'Missing state' });

  const prev = readState().state || { cards: [] };
  const baseTs = Number(baseUpdatedAt) || 0; // versão do servidor que o cliente tinha ao editar

  // ── MERGE anti-perda (resolve concorrência multiusuário) ──────────────────────
  // Preserva cards criados por OUTRA pessoa depois do snapshot deste cliente,
  // evitando que um "salvar com estado antigo" apague o trabalho recém-criado por outro.
  const incoming = Array.isArray(state.cards) ? state.cards : [];
  const incomingIds = new Set(incoming.map(c => c.id));
  const mergedCards = [...incoming];
  let preserved = 0;
  for (const pc of (prev.cards || [])) {
    if (!incomingIds.has(pc.id)) {
      const created = pc.createdAt ? new Date(pc.createdAt).getTime() : 0;
      // Se foi criado depois do snapshot do cliente → o cliente nunca viu, não pode "deletar" → preserva.
      // Se foi criado antes → o cliente realmente excluiu → respeita a exclusão.
      if (created > baseTs) { mergedCards.push(pc); preserved++; }
    }
  }
  state.cards = mergedCards;
  if (preserved) console.log(`[${timestamp()}] 🔀 merge: ${preserved} card(s) de outros preservado(s)`);

  // Merge do feed de atividades (união por id, mantém os 120 mais recentes)
  if ((prev.activity && prev.activity.length) || (state.activity && state.activity.length)) {
    const seen = new Set();
    const allAct = [...(state.activity || []), ...(prev.activity || [])];
    const mergedAct = [];
    for (const a of allAct) { if (a && !seen.has(a.id)) { seen.add(a.id); mergedAct.push(a); } }
    mergedAct.sort((a, b) => new Date(b.ts) - new Date(a.ts));
    state.activity = mergedAct.slice(0, 120);
  }

  // Proteção de prazo: só COO e admin alteram um prazo já definido.
  const u = userContext(req.session?.user?.email || '');
  if (!(u.isFinal || u.isAdmin)) {
    const prevById = new Map((prev.cards || []).map(c => [c.id, c]));
    let reverted = 0;
    (state.cards || []).forEach(c => {
      const old = prevById.get(c.id);
      if (old && old.dueDate && c.dueDate !== old.dueDate) {
        c.dueDate = old.dueDate; // reverte alteração não autorizada
        reverted++;
      }
    });
    if (reverted) console.log(`[${timestamp()}] 🔒 ${reverted} alteração(ões) de prazo bloqueada(s) p/ ${u.email}`);
  }

  const updated_at = writeState(state);
  // Devolve o estado mesclado para o cliente adotar imediatamente
  res.json({ ok: true, updated_at, state });
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

      // CC: admin (Tasso) + chefe do setor — não o time inteiro (evita spam)
      const full = getFullTeam();
      const ccSet = new Set();
      ADMIN_EMAILS.forEach(e => ccSet.add(e));
      const head = full.find(m => isHeadOf(m, card.dept) && m.email);
      if (head) ccSet.add(head.email);
      ccSet.delete(assigneeMember.email); // não duplica o destinatário
      const ccList = [...ccSet];

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

    // Search for Meet transcripts AND Gemini meeting notes Google Docs
    const r1 = await drive.files.list({
      q: `mimeType='application/vnd.google-apps.document' and modifiedTime > '${since}' and (` +
         `name contains 'Transcript' or name contains 'Transcrição' or name contains 'transcrição' or name contains 'Meet' ` +
         `or name contains 'Anotações' or name contains 'Anotações do Gemini' or name contains 'Notes by Gemini' ` +
         `or name contains 'Gemini' or name contains 'Notas' or name contains 'Alinhamento' or name contains 'Reunião' or name contains 'Reuniao')`,
      fields: 'files(id, name, createdTime, modifiedTime, webViewLink)',
      orderBy: 'modifiedTime desc',
      pageSize: 30,
    });

    // Also scan known folders Gemini/Meet usam ('Meet Recordings', 'Gemini')
    const folderR = await drive.files.list({
      q: `(name='Meet Recordings' or name='Gemini' or name contains 'Gemini') and mimeType='application/vnd.google-apps.folder'`,
      fields: 'files(id)',
    });

    let extraFiles = [];
    for (const folder of (folderR.data.files || [])) {
      const r2 = await drive.files.list({
        q: `'${folder.id}' in parents and modifiedTime > '${since}' and mimeType='application/vnd.google-apps.document'`,
        fields: 'files(id, name, createdTime, modifiedTime, webViewLink)',
        orderBy: 'modifiedTime desc',
        pageSize: 20,
      });
      extraFiles.push(...(r2.data.files || []));
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
.container{max-width:1100px;margin:36px auto;padding:0 24px;}
.table-scroll{overflow-x:auto;-webkit-overflow-scrolling:touch;}
.table-scroll::-webkit-scrollbar{height:10px;}
.table-scroll::-webkit-scrollbar-thumb{background:#333;border-radius:5px;}
.table-scroll::-webkit-scrollbar-track{background:#1a1a1a;}
h1{font-family:'Space Grotesk',sans-serif;font-size:22px;font-weight:700;margin-bottom:6px;}
.sub{color:#666;font-size:14px;margin-bottom:28px;}
.card{background:#161616;border:1px solid #2a2a2a;border-radius:12px;overflow:hidden;}
table{width:100%;min-width:860px;border-collapse:collapse;}
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
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Usuário</th>
            <th>Setor</th>
            <th>Cargo</th>
            <th>Chefe do setor</th>
            <th>Desde</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="tbody">
          <tr><td colspan="6" style="text-align:center;color:#555;padding:32px;">Carregando…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</div>

<script>
const DEPTS = ${JSON.stringify(depts)};

async function load() {
  const r = await fetch('/api/admin/team');
  const { team } = await r.json();
  const tbody = document.getElementById('tbody');
  if (!team.length) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#555;padding:32px;">Nenhum usuário registrado ainda.</td></tr>';
    return;
  }
  tbody.innerHTML = team.map((m, i) => {
    const isAdmin = ${JSON.stringify(ADMIN_EMAILS)}.includes(m.email);
    const headList = Array.isArray(m.headOf) ? m.headOf.filter(Boolean) : (m.headOf ? [m.headOf] : []);
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
      <td style="position:relative;">
        <button type="button" id="head-btn-\${i}" onclick="toggleHeadMenu(\${i})" style="display:flex;align-items:center;gap:6px;background:var(--surface2,#1e1e1e);border:1px solid #333;border-radius:6px;color:#aaa;font-size:12px;padding:6px 10px;cursor:pointer;min-width:140px;justify-content:space-between;">
          <span id="head-btn-label-\${i}">\${headList.length ? 'Chefe de '+headList.join(', ') : 'Não é chefe'}</span>
          <span style="color:#555;">▾</span>
        </button>
        <div id="head-menu-\${i}" style="display:none;position:absolute;z-index:20;top:100%;left:0;margin-top:4px;background:#1e1e1e;border:1px solid #333;border-radius:8px;padding:8px;min-width:180px;box-shadow:0 8px 24px rgba(0,0,0,.6);max-height:280px;overflow-y:auto;">
          \${DEPTS.map(d => \`<label style="display:flex;align-items:center;gap:8px;padding:5px 6px;cursor:pointer;font-size:13px;color:#ccc;border-radius:4px;">
            <input type="checkbox" class="head-chk-\${i}" value="\${d}" \${headList.includes(d) ? 'checked' : ''} onchange="onHeadChange(\${i})" style="width:15px;height:15px;accent-color:#FF9800;cursor:pointer;"/>\${d}
          </label>\`).join('')}
        </div>
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

function toggleHeadMenu(i) {
  const menu = document.getElementById('head-menu-' + i);
  const btn  = document.getElementById('head-btn-' + i);
  const open = menu.style.display === 'block';
  // fecha todos
  document.querySelectorAll('[id^="head-menu-"]').forEach(m => m.style.display = 'none');
  if (open) return;
  // posiciona como popup fixo (não é cortado pela rolagem horizontal da tabela)
  const r = btn.getBoundingClientRect();
  menu.style.position = 'fixed';
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = r.left + 'px';
  menu.style.display = 'block';
  // se passar do rodapé, abre pra cima
  const mh = menu.offsetHeight;
  if (r.bottom + 4 + mh > window.innerHeight) {
    menu.style.top = Math.max(8, r.top - mh - 4) + 'px';
  }
}

function headValues(i) {
  return Array.from(document.querySelectorAll('.head-chk-' + i + ':checked')).map(c => c.value);
}

function onHeadChange(i) {
  const heads = headValues(i);
  const lbl = document.getElementById('head-btn-label-' + i);
  if (lbl) {
    lbl.textContent = heads.length ? 'Chefe de ' + heads.join(', ') : 'Não é chefe';
    lbl.style.color = heads.length ? '#FF9800' : '#aaa';
  }
  markDirty(i);
}

// fecha menus ao clicar fora
document.addEventListener('click', (e) => {
  if (!e.target.closest || (!e.target.closest('[id^="head-menu-"]') && !e.target.closest('[id^="head-btn-"]'))) {
    document.querySelectorAll('[id^="head-menu-"]').forEach(m => m.style.display = 'none');
  }
});

async function save(i, email) {
  const area = document.getElementById('area-' + i).value;
  const role = document.getElementById('role-' + i).value.trim();
  const headOf = headValues(i); // array de setores que a pessoa chefia
  const btn  = document.getElementById('save-' + i);
  btn.textContent = '…';
  btn.disabled = true;
  await fetch('/api/admin/team/' + encodeURIComponent(email), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ area, role, headOf }),
  });
  btn.textContent = 'Salvar';
  btn.disabled = false;
  btn.classList.remove('visible');
  document.getElementById('head-menu-' + i).style.display = 'none';
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

// API: update a member's area, role and headOf (admin only)
app.post('/api/admin/team/:email', requireAdmin, (req, res) => {
  const email = decodeURIComponent(req.params.email);
  const { area, role, headOf } = req.body;
  const members = loadDynamicTeam();
  let member = members.find(m => m.email === email);
  if (!member) {
    // Add from config.js if not yet in dynamic team
    const fromConfig = team.find(m => m.email === email);
    if (fromConfig) {
      member = { ...fromConfig, area: area ?? fromConfig.area, role: role ?? fromConfig.role, joinedAt: null, picture: '' };
      members.push(member);
    } else {
      return res.status(404).json({ ok: false, error: 'Usuário não encontrado' });
    }
  } else {
    if (area !== undefined) member.area = area;
    if (role !== undefined) member.role = role;
  }

  if (headOf !== undefined) {
    // headOf agora é uma LISTA de setores que a pessoa chefia
    const heads = Array.isArray(headOf) ? headOf.filter(Boolean) : (headOf ? [headOf] : []);
    member.headOf = heads;
    // Garante UM ÚNICO chefe por setor: remove esses setores do headOf de qualquer outro
    if (heads.length) {
      members.forEach(m => {
        if (m.email !== email) {
          const mh = Array.isArray(m.headOf) ? m.headOf : (m.headOf ? [m.headOf] : []);
          const filtered = mh.filter(d => !heads.includes(d));
          if (filtered.length !== mh.length) m.headOf = filtered;
        }
      });
    }
  }

  saveDynamicTeam(members);
  console.log(`[${timestamp()}] ✏️  Admin update: ${email} → setor=${area} cargo=${role} chefe=${(member.headOf||[]).join(',') || '—'}`);
  res.json({ ok: true });
});

// ── Fluxo de aprovação de mudança de prazo ──────────────────────────────────────
async function safeSendMail(opts) {
  if (!gmailUser || !gmailPassword) return;
  try { await transporter.sendMail({ from: `"Financial Move Kanban" <${gmailUser}>`, ...opts }); }
  catch (e) { console.error(`[${timestamp()}] ❌ email:`, e.message); }
}
function deptHeadEmail(dept) {
  const h = getFullTeam().find(m => isHeadOf(m, dept) && m.email);
  return h ? h.email : null;
}

// Criar solicitação de mudança de prazo (subordinado)
app.post('/api/date-requests', requireAuth, async (req, res) => {
  const u = userContext(req.session.user.email);
  const { cardId, newDate, reason } = req.body;
  if (!cardId || !newDate) return res.status(400).json({ ok: false, error: 'cardId e newDate obrigatórios' });

  const { state } = readState();
  const card = (state.cards || []).find(c => c.id === cardId);
  if (!card) return res.status(404).json({ ok: false, error: 'Card não encontrado' });

  // Chefe do próprio setor, COO ou admin pulam a etapa do chefe → vão direto pra aprovação final
  const ehChefeDoCard = u.headDepts.includes(card.dept);
  const initialStatus = (ehChefeDoCard || u.isFinal || u.isAdmin) ? 'pending_final' : 'pending_head';

  const reqObj = {
    id: Date.now(),
    cardId, cardTitle: card.title, cardDept: card.dept || '',
    requestedByEmail: u.email, requestedByName: u.name,
    oldDate: card.dueDate || '', newDate, reason: (reason || '').trim(),
    status: initialStatus,
    headApprovedAt: null, headApprovedBy: null,
    finalApprovedAt: null, finalApprovedBy: null,
    rejectedAt: null, rejectedBy: null, rejectionReason: null,
    createdAt: new Date().toISOString(),
  };
  const reqs = loadDateRequests();
  reqs.push(reqObj);
  saveDateRequests(reqs);

  // Notifica o próximo aprovador
  if (initialStatus === 'pending_head') {
    const he = deptHeadEmail(card.dept);
    const to = he || FINAL_APPROVER; // se setor sem chefe, vai direto pro COO
    if (!he) reqObj.status = 'pending_final', saveDateRequests(reqs);
    await safeSendMail({ to, cc: ADMIN_EMAILS.join(', '),
      subject: `[Kanban FM] Aprovação de prazo: ${card.title}`,
      html: buildDateReqToApprover({ reqObj, card, approverRole: he ? 'head' : 'final' }) });
  } else {
    await safeSendMail({ to: FINAL_APPROVER, cc: ADMIN_EMAILS.join(', '),
      subject: `[Kanban FM] Aprovação de prazo: ${card.title}`,
      html: buildDateReqToApprover({ reqObj, card, approverRole: 'final' }) });
  }
  console.log(`[${timestamp()}] 📩 Solicitação de prazo: "${card.title}" por ${u.name} → ${reqObj.status}`);
  res.json({ ok: true, request: reqObj });
});

// Listar solicitações relevantes pro usuário
app.get('/api/date-requests', requireAuth, (req, res) => {
  const u = userContext(req.session.user.email);
  const reqs = loadDateRequests().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const toApprove = [];
  if (u.headDepts.length) toApprove.push(...reqs.filter(r => r.status === "pending_head" && u.headDepts.includes(r.cardDept)));
  if (u.isFinal || u.isAdmin) toApprove.push(...reqs.filter(r => r.status === 'pending_final'));
  const mine = reqs.filter(r => r.requestedByEmail === u.email);
  const history = (u.isAdmin || u.isFinal)
    ? reqs.filter(r => r.status === 'approved' || r.status === 'rejected').slice(0, 20)
    : [];
  res.json({ ok: true, toApprove, mine, history,
    role: { headOf: u.headDepts, isFinal: u.isFinal, isAdmin: u.isAdmin } });
});

// Contador pro sininho
app.get('/api/date-requests/count', requireAuth, (req, res) => {
  const u = userContext(req.session.user.email);
  const reqs = loadDateRequests();
  let count = 0;
  if (u.headDepts.length) count += reqs.filter(r => r.status === "pending_head" && u.headDepts.includes(r.cardDept)).length;
  if (u.isFinal || u.isAdmin) count += reqs.filter(r => r.status === 'pending_final').length;
  res.json({ ok: true, count });
});

// Aprovar
app.post('/api/date-requests/:id/approve', requireAuth, async (req, res) => {
  const u = userContext(req.session.user.email);
  const reqs = loadDateRequests();
  const r = reqs.find(x => String(x.id) === String(req.params.id));
  if (!r) return res.status(404).json({ ok: false, error: 'Solicitação não encontrada' });

  const { state } = readState();
  const card = (state.cards || []).find(c => c.id === r.cardId) || { title: r.cardTitle, dept: r.cardDept };

  if (r.status === 'pending_head') {
    if (!(u.headDepts.includes(r.cardDept) || u.isAdmin)) return res.status(403).json({ ok: false, error: 'Só o chefe do setor pode aprovar esta etapa' });
    r.status = 'pending_final'; r.headApprovedAt = new Date().toISOString(); r.headApprovedBy = u.name;
    saveDateRequests(reqs);
    await safeSendMail({ to: FINAL_APPROVER, cc: ADMIN_EMAILS.join(', '),
      subject: `[Kanban FM] Aprovação de prazo: ${r.cardTitle}`,
      html: buildDateReqToApprover({ reqObj: r, card, approverRole: 'final' }) });
    console.log(`[${timestamp()}] ✅ Chefe aprovou prazo "${r.cardTitle}" (${u.name}) → COO`);
    return res.json({ ok: true, status: r.status });
  }

  if (r.status === 'pending_final') {
    if (!(u.isFinal || u.isAdmin)) return res.status(403).json({ ok: false, error: 'Só o aprovador final (COO) pode concluir' });
    r.status = 'approved'; r.finalApprovedAt = new Date().toISOString(); r.finalApprovedBy = u.name;
    saveDateRequests(reqs);
    // Aplica o novo prazo no card
    const fresh = readState();
    const c = (fresh.state.cards || []).find(x => x.id === r.cardId);
    if (c) { c.dueDate = r.newDate; writeState(fresh.state); }
    await safeSendMail({ to: r.requestedByEmail, cc: ADMIN_EMAILS.join(', '),
      subject: `[Kanban FM] Prazo aprovado: ${r.cardTitle}`,
      html: buildDateReqOutcome({ reqObj: r, card, outcome: 'approved', by: u.name }) });
    console.log(`[${timestamp()}] ✅ COO aprovou prazo "${r.cardTitle}" → aplicado (${r.newDate})`);
    return res.json({ ok: true, status: r.status });
  }

  return res.status(400).json({ ok: false, error: 'Solicitação já resolvida' });
});

// Rejeitar
app.post('/api/date-requests/:id/reject', requireAuth, async (req, res) => {
  const u = userContext(req.session.user.email);
  const { reason } = req.body;
  const reqs = loadDateRequests();
  const r = reqs.find(x => String(x.id) === String(req.params.id));
  if (!r) return res.status(404).json({ ok: false, error: 'Solicitação não encontrada' });
  if (r.status !== 'pending_head' && r.status !== 'pending_final') return res.status(400).json({ ok: false, error: 'Solicitação já resolvida' });

  const podeRejeitar = (r.status === "pending_head" && (u.headDepts.includes(r.cardDept) || u.isAdmin))
                    || (r.status === 'pending_final' && (u.isFinal || u.isAdmin));
  if (!podeRejeitar) return res.status(403).json({ ok: false, error: 'Sem permissão para rejeitar' });

  r.status = 'rejected'; r.rejectedAt = new Date().toISOString(); r.rejectedBy = u.name; r.rejectionReason = (reason || '').trim();
  saveDateRequests(reqs);
  const { state } = readState();
  const card = (state.cards || []).find(c => c.id === r.cardId) || { title: r.cardTitle, dept: r.cardDept };
  await safeSendMail({ to: r.requestedByEmail, cc: ADMIN_EMAILS.join(', '),
    subject: `[Kanban FM] Prazo rejeitado: ${r.cardTitle}`,
    html: buildDateReqOutcome({ reqObj: r, card, outcome: 'rejected', by: u.name }) });
  console.log(`[${timestamp()}] ❌ Prazo rejeitado "${r.cardTitle}" por ${u.name}`);
  res.json({ ok: true, status: r.status });
});

// ── Robô de alertas de prazo (agendado) ────────────────────────────────────────
const lastScanFile = path.join(dataDir, 'last-deadline-scan.json');

function todayBRT() {
  // YYYY-MM-DD no fuso de São Paulo
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}
function hourBRT() {
  return parseInt(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hour12: false }), 10);
}
function getLastScanDate() {
  try { return JSON.parse(fs.readFileSync(lastScanFile, 'utf-8')).date; } catch { return null; }
}
function setLastScanDate(date) {
  try { fs.writeFileSync(lastScanFile, JSON.stringify({ date }), 'utf-8'); } catch {}
}

// Escaneia todos os cards e envia alertas de prazo vencendo / vencido
async function scanDeadlines() {
  if (!gmailUser || !gmailPassword) {
    console.warn(`[${timestamp()}] ⚠️  Scan de prazos pulado — Gmail não configurado.`);
    return;
  }
  const { state } = readState();
  const cards = (state && state.cards) || [];
  const full = getFullTeam();
  const today = new Date(); today.setHours(0, 0, 0, 0);

  let alerts = 0;
  const feedEntries = [];
  for (const card of cards) {
    if (!card.dueDate || !card.assignee) continue;
    if (isCardDone(card)) continue; // card concluído, não alerta

    const due = new Date(card.dueDate + 'T00:00');
    const diffDays = Math.round((due - today) / 86400000);

    let type = null;
    if (diffDays < 0) type = 'overdue';            // vencido
    else if (diffDays <= 2) type = 'approaching';  // vence hoje, amanhã ou em 2 dias
    if (!type) continue;

    // Destinatários: responsável + chefe do setor + admin (Tasso)
    const recipients = new Set();
    const assigneeMember = full.find(m => m.name === card.assignee && m.email);
    if (assigneeMember) recipients.add(assigneeMember.email);
    const head = full.find(m => isHeadOf(m, card.dept) && m.email);
    if (head) recipients.add(head.email);
    ADMIN_EMAILS.forEach(e => recipients.add(e));
    if (!recipients.size) continue;

    try {
      const html = buildDeadlineEmail({ card, type, diffDays });
      await transporter.sendMail({
        from:    `"Financial Move Kanban" <${gmailUser}>`,
        to:      [...recipients].join(', '),
        subject: type === 'overdue'
          ? `⚠️ [Kanban FM] Prazo VENCIDO: ${card.title}`
          : `⏰ [Kanban FM] Prazo se aproximando: ${card.title}`,
        html,
      });
      alerts++;
      // Também registra no feed de atividades
      const titleEsc = String(card.title || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const respEsc  = String(card.assignee || '').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const txt = type === 'overdue'
        ? `⚠️ Prazo vencido: <b>${titleEsc}</b> (há ${Math.abs(diffDays)}d) — resp. ${respEsc}`
        : `⏰ Prazo se aproximando: <b>${titleEsc}</b> (${diffDays===0?'vence hoje':'em '+diffDays+'d'}) — resp. ${respEsc}`;
      feedEntries.push({ id: Date.now() + Math.random(), ts: new Date().toISOString(), user: '🤖 Robô de prazos', text: txt });
      console.log(`[${timestamp()}] ${type==='overdue'?'⚠️':'⏰'} alerta de prazo → ${[...recipients].join(', ')} | card: "${card.title}" (${diffDays}d)`);
    } catch (err) {
      console.error(`[${timestamp()}] ❌ Falha ao enviar alerta de prazo "${card.title}":`, err.message);
    }
  }

  // Grava os alertas no feed de atividades (lê estado fresco p/ não sobrescrever)
  if (feedEntries.length) {
    const fresh = readState();
    if (!fresh.state.activity) fresh.state.activity = [];
    fresh.state.activity.unshift(...feedEntries);
    if (fresh.state.activity.length > 120) fresh.state.activity = fresh.state.activity.slice(0, 120);
    writeState(fresh.state);
  }
  console.log(`[${timestamp()}] 📬 Scan de prazos concluído — ${alerts} alerta(s) enviado(s).`);
}

// Roda 1x por dia, a partir das 8h BRT. Checa a cada 30 min.
function maybeRunDeadlineScan() {
  if (hourBRT() < 8) return;
  if (getLastScanDate() === todayBRT()) return; // já rodou hoje
  setLastScanDate(todayBRT());
  scanDeadlines();
}
// Endpoint manual para testar o scan agora (admin only)
app.post('/api/debug/scan-deadlines', requireAdmin, async (req, res) => {
  await scanDeadlines();
  res.json({ ok: true, message: 'Scan executado — veja os logs.' });
});

// Exporta builders para scripts de teste (sem subir o servidor)
module.exports = { buildAssignedEmail, buildStatusChangedEmail, buildCommentEmail, buildDeadlineEmail };

// ── Start (só quando executado direto, não quando importado) ────────────────────
if (require.main === module) {
  setInterval(maybeRunDeadlineScan, 30 * 60 * 1000); // a cada 30 min
  app.listen(PORT, () => {
    console.log(`\n🚀 Financial Move Kanban Server`);
    console.log(`   URL:    http://localhost:${PORT}`);
    console.log(`   API:    http://localhost:${PORT}/api/state`);
    console.log(`   Gmail:  ${gmailUser || '(not configured)'}`);
    console.log(`   Team:   ${getFullTeam().length} membros (${teamWithEmail().length} com email)`);
    console.log(`   State:  ${stateFile}\n`);
    // Checa prazos logo após subir (se já passou das 8h e ainda não rodou hoje)
    setTimeout(maybeRunDeadlineScan, 10000);
  });
}
