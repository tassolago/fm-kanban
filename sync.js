// sync.js — Importa time do CSV exportado do Google Sheets e atualiza config.js
// Uso: node sync.js [caminho-do-csv]
// Exemplo: node sync.js ~/Downloads/time.csv

const fs = require('fs');
const path = require('path');

const csvPath = process.argv[2] || path.join(__dirname, 'time.csv');
const configPath = path.join(__dirname, 'config.js');

if (!fs.existsSync(csvPath)) {
  console.error(`\n❌ Arquivo CSV não encontrado: ${csvPath}`);
  console.error('   Exporte a planilha no Google Sheets: Arquivo → Fazer download → CSV');
  console.error('   Depois rode: node sync.js ~/Downloads/nome-do-arquivo.csv\n');
  process.exit(1);
}

// Lê config atual para preservar gmail credentials
let currentConfig = { gmail: { user: '', appPassword: '' }, appUrl: 'http://localhost:3000' };
try {
  currentConfig = require(configPath);
} catch (e) {}

// Parse CSV simples (suporta campos com vírgula dentro de aspas)
function parseCSV(content) {
  const lines = content.trim().split('\n');
  const headers = splitLine(lines[0]);
  return lines.slice(1).map(line => {
    const values = splitLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (values[i] || '').trim(); });
    return row;
  });
}

function splitLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') { inQuotes = !inQuotes; continue; }
    if (line[i] === ',' && !inQuotes) { result.push(current); current = ''; continue; }
    current += line[i];
  }
  result.push(current);
  return result;
}

const raw = fs.readFileSync(csvPath, 'utf-8');
const rows = parseCSV(raw);

// Colunas esperadas: Nome Completo, Área de Trabalho, Cargo, Email, Status
// A coluna Email deve ser adicionada manualmente na planilha
const team = rows
  .filter(r => r['Nome Completo'] && r['Nome Completo'] !== 'Tasso Lago') // CEO separado
  .map(r => ({
    name: r['Nome Completo'] || '',
    area: r['Área de Trabalho'] || r['Area de Trabalho'] || '',
    role: r['Cargo'] || '',
    email: r['Email'] || r['E-mail'] || '',
  }));

// Garante Tasso sempre no topo
const tasso = rows.find(r => r['Nome Completo'] === 'Tasso Lago');
if (tasso) {
  team.unshift({
    name: 'Tasso Lago',
    area: 'CEO',
    role: 'CEO',
    email: tasso['Email'] || tasso['E-mail'] || '',
  });
}

// Gera config.js
const teamLines = team.map(m => {
  const namePad = m.name.padEnd(35);
  const areaPad = m.area.padEnd(16);
  const rolePad = m.role.padEnd(26);
  return `    { name: '${namePad}', area: '${areaPad}', role: '${rolePad}', email: '${m.email}' },`;
});

const configContent = `// config.js — Financial Move Kanban Configuration
// Gerado automaticamente por sync.js em ${new Date().toLocaleString('pt-BR')}
// Para atualizar: adicione/edite emails na planilha e rode: node sync.js time.csv

module.exports = {
  gmail: {
    user: '${currentConfig.gmail?.user || ''}',        // Seu Gmail (ex: seunome@gmail.com)
    appPassword: '${currentConfig.gmail?.appPassword || ''}', // Senha de App do Google
                     // Gerar em: https://myaccount.google.com/apppasswords
  },

  appUrl: '${currentConfig.appUrl || 'http://localhost:3000'}',

  team: [
${teamLines.join('\n')}
  ],
};
`;

fs.writeFileSync(configPath, configContent, 'utf-8');

const withEmail = team.filter(m => m.email).length;
const withoutEmail = team.filter(m => !m.email).length;

console.log(`\n✅ config.js atualizado com sucesso!`);
console.log(`   ${team.length} membros importados`);
console.log(`   ${withEmail} com email ✓`);
if (withoutEmail > 0) {
  console.log(`   ${withoutEmail} sem email (notificações serão ignoradas para eles):`);
  team.filter(m => !m.email).forEach(m => console.log(`     - ${m.name} (${m.role})`));
}
console.log('');
