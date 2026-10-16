// Triagem (investigacoes/00-triagem): zera as estatísticas da
// pg_stat_statements, executa a carga simulada da aplicação e mostra o
// ranking das consultas que mais pesam no banco.
//
// Uso:
//   npm run triagem                  no banco do Docker Compose (localhost:5432)
//   npm run triagem -- --embarcado   num PostgreSQL embarcado temporário,
//                                    sem Docker (gera o volume antes, ~30 s)

const path = require('node:path');
const fs = require('node:fs');
const { Client } = require('pg');
const { lerSql, comPostgresEmbarcado, executar } = require('./postgres-embarcado');
const { executarCarga } = require('./carga');

const RANKING_SQL = fs.readFileSync(path.join(__dirname, '..', 'investigacoes', '00-triagem', 'ranking.sql'), 'utf-8');

async function triagem(client) {
  const libs = (await client.query('SHOW shared_preload_libraries')).rows[0].shared_preload_libraries;
  if (!libs.includes('pg_stat_statements')) {
    throw new Error(
      'O servidor não carregou a pg_stat_statements (shared_preload_libraries). '
      + 'Se o banco do Docker foi criado antes desta versão, recrie-o: docker compose down -v && docker compose up -d --wait',
    );
  }
  await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
  await client.query('SELECT pg_stat_statements_reset()');

  console.log('Executando a carga simulada...');
  const inicio = Date.now();
  await executarCarga(client);
  console.log(`Carga executada em ${((Date.now() - inicio) / 1000).toFixed(1)} s.\n`);

  // O driver devolve bigint e numeric como texto; para a tabela, números.
  const ranking = await client.query(RANKING_SQL);
  console.table(ranking.rows.map((linha) => Object.fromEntries(
    Object.entries(linha).map(([coluna, valor]) => [coluna, coluna === 'consulta' ? valor : Number(valor)]),
  )));
}

async function main() {
  if (process.argv.includes('--embarcado')) {
    await comPostgresEmbarcado({
      porta: 5434,
      pasta: path.join(__dirname, '..', '.pgdata-triagem'),
      postgresFlags: ['-c', 'shared_preload_libraries=pg_stat_statements'],
    }, async (client) => {
      console.log('Carregando o schema e gerando o volume de dados...');
      await client.query(lerSql('01_schema.sql'));
      await client.query(lerSql('02_volume.sql'));
      await triagem(client);
    });
    return;
  }

  const client = new Client({
    host: process.env.PGHOST || 'localhost',
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || 'postgres',
    database: process.env.PGDATABASE || 'performance_investigation',
  });
  try {
    await client.connect();
  } catch (err) {
    throw new Error(
      `Não foi possível conectar ao banco do Docker (${err.message}). `
      + 'Suba-o com "docker compose up -d --wait" ou use "npm run triagem -- --embarcado".',
    );
  }
  try {
    await triagem(client);
  } finally {
    await client.end();
  }
}

executar(main);
