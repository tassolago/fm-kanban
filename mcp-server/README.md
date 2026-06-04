# FM Kanban — MCP Server

Permite consultar, criar e editar cards do Kanban da Financial Move **direto pelo Claude** (Claude Desktop ou Claude Code), sem abrir o site.

## O que dá pra fazer
- `kanban_list_cards` — listar cards (filtros: setor, responsável, funil, status, busca, atrasados)
- `kanban_get_card` — ver um card (com comentários e histórico)
- `kanban_create_card` — criar card (título + prazo obrigatórios)
- `kanban_update_card` / `kanban_move_card` — editar/mover de etapa
- `kanban_comment` — comentar
- `kanban_delete_card` — excluir
- `kanban_team` / `kanban_meta` — time, setores, etapas, funis

## Instalação

1. Tenha o **Node 18+** instalado.
2. Baixe esta pasta `mcp-server` (ou clone o repositório `fm-kanban`).
3. Dentro dela: `npm install`
4. Configure no seu cliente do Claude (abaixo). **Peça a chave de API ao Tasso.**

### Claude Desktop
Edite o arquivo de config:
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "fm-kanban": {
      "command": "node",
      "args": ["/CAMINHO/ABSOLUTO/para/mcp-server/index.js"],
      "env": {
        "KANBAN_URL": "https://kanban.financialmove.com.br",
        "KANBAN_API_KEY": "PEÇA_A_CHAVE_AO_TASSO",
        "KANBAN_USER": "Seu Nome"
      }
    }
  }
}
```
Reinicie o Claude Desktop. Pronto — peça "liste meus cards atrasados em Marketing".

### Claude Code
```bash
claude mcp add fm-kanban \
  -e KANBAN_URL=https://kanban.financialmove.com.br \
  -e KANBAN_API_KEY=PEÇA_A_CHAVE_AO_TASSO \
  -e KANBAN_USER="Seu Nome" \
  -- node /CAMINHO/ABSOLUTO/para/mcp-server/index.js
```

## Exemplos de uso (no chat)
- "Liste os cards atrasados de Operações"
- "Crie um card 'Revisar copy da LP' em Marketing pro Christopher, prazo dia 12, funil TPW R$97"
- "Mova o card 42 para Aprovação"
- "Adicione um comentário no card 17: aguardando aprovação do jurídico"

## Segurança
- A `KANBAN_API_KEY` dá acesso total de leitura/escrita aos cards. Não compartilhe publicamente.
- Toda ação feita via MCP fica gravada no **histórico do card** e no **feed de atividades** com o `KANBAN_USER`.
