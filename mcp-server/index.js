#!/usr/bin/env node
// MCP server — Kanban Financial Move
// Permite a um agente (Claude) consultar, criar e editar cards sem abrir o site.
//
// Configuração (variáveis de ambiente):
//   KANBAN_URL      (default: https://kanban.financialmove.com.br)
//   KANBAN_API_KEY  (obrigatória) — chave de API do agente
//   KANBAN_USER     (opcional) — seu nome, gravado no histórico das ações

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const BASE = (process.env.KANBAN_URL || 'https://kanban.financialmove.com.br').replace(/\/$/, '');
const KEY  = process.env.KANBAN_API_KEY || '';
const USER = process.env.KANBAN_USER || 'Agente (MCP)';

if (!KEY) {
  console.error('ERRO: defina KANBAN_API_KEY no ambiente.');
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'x-api-key': KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify({ ...body, by: USER }) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}
const text = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

const server = new McpServer({ name: 'fm-kanban', version: '1.0.0' });

// ── Consultas ───────────────────────────────────────────────────────────────────
server.tool('kanban_meta',
  'Lista os setores, colunas (etapas), prioridades e funis disponíveis no Kanban.',
  {},
  async () => text(await api('GET', '/api/agent/meta')));

server.tool('kanban_team',
  'Lista os membros do time (nome, email, setor, cargo) para atribuir cards.',
  {},
  async () => text(await api('GET', '/api/agent/team')));

server.tool('kanban_list_cards',
  'Lista cards com filtros opcionais. Use para consultar o que existe antes de editar.',
  {
    dept:     z.string().optional().describe('Setor (ex: Marketing, Operações)'),
    assignee: z.string().optional().describe('Nome (ou parte) do responsável'),
    funnel:   z.string().optional().describe('Funil exato'),
    status:   z.string().optional().describe('Coluna/etapa (ex: Briefing, Criação, Revisão, Aprovação, Publicado)'),
    search:   z.string().optional().describe('Texto no título ou descrição'),
    overdue:  z.boolean().optional().describe('true = só cards atrasados'),
  },
  async (args) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== '') qs.set(k, String(v));
    return text(await api('GET', '/api/agent/cards?' + qs.toString()));
  });

server.tool('kanban_get_card',
  'Detalhe completo de um card (inclui comentários e histórico).',
  { id: z.number().describe('ID do card') },
  async ({ id }) => text(await api('GET', `/api/agent/cards/${id}`)));

// ── Edição ──────────────────────────────────────────────────────────────────────
server.tool('kanban_create_card',
  'Cria um novo card. title e dueDate são obrigatórios. dueDate no formato YYYY-MM-DD.',
  {
    title:       z.string().describe('Título do card'),
    dueDate:     z.string().describe('Prazo YYYY-MM-DD (obrigatório)'),
    dept:        z.string().optional().describe('Setor (default: Dados)'),
    assignee:    z.string().optional().describe('Nome do responsável (use kanban_team)'),
    priority:    z.enum(['Alta','Média','Baixa']).optional(),
    funnel:      z.string().optional().describe('Funil (opcional)'),
    status:      z.string().optional().describe('Coluna inicial (default: Briefing)'),
    description: z.string().optional(),
  },
  async (args) => text(await api('POST', '/api/agent/cards', args)));

server.tool('kanban_update_card',
  'Atualiza campos de um card (parcial). Para mover de etapa use o campo status. Mudanças de status e prazo entram no histórico.',
  {
    id:          z.number().describe('ID do card'),
    title:       z.string().optional(),
    status:      z.string().optional().describe('Nova coluna/etapa'),
    assignee:    z.string().optional(),
    priority:    z.enum(['Alta','Média','Baixa']).optional(),
    dueDate:     z.string().optional().describe('Novo prazo YYYY-MM-DD'),
    funnel:      z.string().optional(),
    description: z.string().optional(),
    dept:        z.string().optional(),
  },
  async ({ id, ...rest }) => text(await api('PATCH', `/api/agent/cards/${id}`, rest)));

server.tool('kanban_move_card',
  'Move um card para outra etapa (coluna). Atalho de kanban_update_card.',
  { id: z.number(), status: z.string().describe('Etapa destino (ex: Em Revisão, Publicado)') },
  async ({ id, status }) => text(await api('PATCH', `/api/agent/cards/${id}`, { status })));

server.tool('kanban_comment',
  'Adiciona um comentário a um card.',
  { id: z.number(), text: z.string().describe('Comentário') },
  async ({ id, text: t }) => text(await api('POST', `/api/agent/cards/${id}/comment`, { text: t })));

server.tool('kanban_delete_card',
  'Exclui um card. Use com cautela.',
  { id: z.number() },
  async ({ id }) => text(await api('DELETE', `/api/agent/cards/${id}`)));

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('FM Kanban MCP rodando (stdio) →', BASE);
