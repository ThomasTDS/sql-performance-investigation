// Valida o ambiente e o schema contra um Postgres real (binário baixado
// sob demanda, sem precisar de Docker) — usado tanto em desenvolvimento
// local quanto no CI.
//
// 1. Sobe um Postgres limpo e confere que a versão é a 16, a mesma do
//    postgres:16 do docker-compose.yml.
// 2. Carrega o schema e confere as tabelas e os índices. As verificações
//    dos planos de execução das investigações entram aqui nas próximas
//    etapas.

const path = require('node:path');
const { lerSql, comPostgresEmbarcado, executar } = require('./postgres-embarcado');

const PORT = 5433;
const DATA_DIR = path.join(__dirname, '..', '.pgdata-validate');
const VERSAO_MAJOR_ESPERADA = 16;

const TABELAS_ESPERADAS = ['clientes', 'itens_pedido', 'pagamentos', 'pedidos', 'produtos', 'vendedores'];

// Só os índices que o PostgreSQL cria sozinho: um por chave primária e o
// do UNIQUE de vendedores.email. Qualquer outro índice tem que nascer
// numa investigação — se aparecer aqui, alguém mudou o schema base e os
// planos "antes" das investigações deixam de valer.
const INDICES_ESPERADOS = [
  'clientes_pkey',
  'itens_pedido_pkey',
  'pagamentos_pkey',
  'pedidos_pkey',
  'produtos_pkey',
  'vendedores_email_key',
  'vendedores_pkey',
];

function conferir(label, esperado, encontrado) {
  const ok = esperado === encontrado;
  console.log(`  ${ok ? '✔' : '✘'} ${label}: esperado ${esperado}, encontrado ${encontrado}`);
  if (!ok) process.exitCode = 1;
}

async function listar(client, sql) {
  const result = await client.query(sql);
  return result.rows.map((r) => r.nome).join(', ');
}

async function main() {
  await comPostgresEmbarcado({ porta: PORT, pasta: DATA_DIR }, async (client) => {
    console.log('\n--- Etapa 1: ambiente ---');
    const result = await client.query('SHOW server_version_num');
    // server_version_num tem o formato MMmmmm (ex.: 160014 = 16.14).
    const major = Math.floor(Number(result.rows[0].server_version_num) / 10000);
    conferir('versão major do PostgreSQL', VERSAO_MAJOR_ESPERADA, major);

    console.log('\n--- Etapa 2: schema ---');
    await client.query(lerSql('01_schema.sql'));
    conferir(
      'tabelas',
      TABELAS_ESPERADAS.join(', '),
      await listar(client, "SELECT tablename AS nome FROM pg_tables WHERE schemaname = 'public' ORDER BY 1"),
    );
    conferir(
      'índices',
      INDICES_ESPERADOS.join(', '),
      await listar(client, "SELECT indexname AS nome FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1"),
    );
  });

  if (process.exitCode === 1) {
    console.log('\nValidação FALHOU — ver itens marcados com ✘ acima.');
  } else {
    console.log('\nValidação OK — ambiente e schema estão como esperado.');
  }
}

executar(main);
