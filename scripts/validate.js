// Valida o ambiente e o schema contra um Postgres real (binário baixado
// sob demanda, sem precisar de Docker) — usado tanto em desenvolvimento
// local quanto no CI.
//
// 1. Sobe um Postgres limpo e confere que a versão é a 16, a mesma do
//    postgres:16 do docker-compose.yml.
// 2. Carrega o schema e confere as tabelas e os índices.
// 3. Gera o volume de dados e confere que ele é reprodutível (mesma
//    quantidade de linhas e mesma impressão digital em qualquer máquina) e
//    correto (nenhuma inconsistência entre as tabelas).
//
// As verificações dos planos de execução das investigações entram aqui
// nas próximas etapas.

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

// Impressão digital de cada tabela: quantidade de linhas e md5 de todas as
// linhas, em ordem de id. Se a geração do volume deixar de ser
// reprodutível (ou alguém mudar o 02_volume.sql), o md5 muda e a
// validação acusa. Ao mudar o 02_volume.sql de propósito, atualize os
// valores aqui com os encontrados.
const VOLUME_ESPERADO = {
  vendedores: { linhas: 50, md5: 'beb38a7f6955962ac7810b4df2f808df' },
  produtos: { linhas: 2000, md5: '50b6935a38405c212096490b7f320a18' },
  clientes: { linhas: 50000, md5: 'a5c515d89f529176b6e4b7e8d10a5a36' },
  pedidos: { linhas: 500000, md5: '5a4f5e437c3a2c0df4554f59cdbaf071' },
  itens_pedido: { linhas: 1500939, md5: 'aac34c64ce985b0102f2b48907644e26' },
  pagamentos: { linhas: 487490, md5: 'ab485b579c31fce4c9cc0aded4e42619' },
};

// Os dados deste projeto estão corretos: cada consulta conta as linhas que
// quebram uma regra, e o esperado é sempre 0.
const COERENCIA = [
  {
    label: 'pedidos anteriores ao cadastro do cliente',
    sql: 'SELECT count(*) FROM pedidos p JOIN clientes c ON c.id = p.cliente_id WHERE p.data_pedido < c.data_cadastro',
  },
  {
    label: 'pagamentos anteriores ao pedido',
    sql: 'SELECT count(*) FROM pagamentos g JOIN pedidos p ON p.id = g.pedido_id WHERE g.data_pagamento < p.data_pedido',
  },
  {
    label: 'pedidos com total diferente da soma dos itens (ou sem itens)',
    sql: `SELECT count(*) FROM pedidos p
          LEFT JOIN (SELECT pedido_id, sum(quantidade * preco_unitario) AS soma FROM itens_pedido GROUP BY pedido_id) i
            ON i.pedido_id = p.id
          WHERE i.soma IS DISTINCT FROM p.valor_total`,
  },
  {
    label: 'itens com preço diferente do catálogo',
    sql: 'SELECT count(*) FROM itens_pedido i JOIN produtos p ON p.id = i.produto_id WHERE i.preco_unitario <> p.preco',
  },
  {
    label: 'pagamentos incoerentes com o status ou o total do pedido',
    sql: `SELECT count(*) FROM pagamentos g JOIN pedidos p ON p.id = g.pedido_id
          WHERE g.valor <> p.valor_total
             OR NOT ((p.status IN ('entregue', 'confirmado') AND g.status = 'aprovado')
                  OR (p.status = 'pendente' AND g.status = 'pendente')
                  OR (p.status = 'cancelado' AND g.status = 'estornado'))`,
  },
  {
    label: 'pedidos com mais de um pagamento',
    sql: 'SELECT count(*) FROM (SELECT pedido_id FROM pagamentos GROUP BY pedido_id HAVING count(*) > 1) AS x',
  },
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

    const banco = await client.query(
      'SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype FROM pg_database WHERE datname = current_database()',
    );
    const { encoding, datcollate, datctype } = banco.rows[0];
    conferir('codificação do banco', 'UTF8', encoding);
    conferir('locale de ordenação (LC_COLLATE)', 'C', datcollate);
    conferir('locale de caracteres (LC_CTYPE)', 'C', datctype);

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

    console.log('\n--- Etapa 3: volume de dados ---');
    const inicio = Date.now();
    await client.query(lerSql('02_volume.sql'));
    console.log(`  Volume gerado em ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
    for (const [tabela, esperado] of Object.entries(VOLUME_ESPERADO)) {
      const r = await client.query(
        `SELECT count(*) AS linhas, md5(string_agg(t::text, '|' ORDER BY id)) AS md5 FROM ${tabela} AS t`,
      );
      conferir(`${tabela}: linhas`, esperado.linhas, Number(r.rows[0].linhas));
      conferir(`${tabela}: impressão digital (md5)`, esperado.md5, r.rows[0].md5);
    }
    for (const regra of COERENCIA) {
      const r = await client.query(regra.sql);
      conferir(regra.label, 0, Number(r.rows[0].count));
    }
  });

  if (process.exitCode === 1) {
    console.log('\nValidação FALHOU — ver itens marcados com ✘ acima.');
  } else {
    console.log('\nValidação OK — ambiente, schema e volume de dados estão como esperado.');
  }
}

executar(main);
