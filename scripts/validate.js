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
// 4. Triagem: executa a carga simulada da aplicação e confere que as três
//    consultas que mais leem blocos, segundo a pg_stat_statements, são as
//    das investigações, na ordem esperada.
// 5. Para cada investigação de plano, numa transação desfeita no fim (ROLLBACK):
//    confere como a consulta acessa a tabela investigada antes da correção,
//    aplica a correção, confere o acesso de novo e confere que o resultado
//    da consulta não mudou. Tempos não são conferidos: variam de máquina
//    para máquina e deixariam a CI instável. Na investigação de bloqueio
//    (04), confere com várias conexões o que acontece com as escritas da
//    aplicação durante a migração (ver verificarBloqueio).

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { Client } = require('pg');
const { lerSql, comPostgresEmbarcado, executar } = require('./postgres-embarcado');
const { CARGA, executarCarga } = require('./carga');

// Triagem: as três consultas que mais leem blocos durante a carga simulada,
// em ordem. Blocos lidos (shared_blks_hit + shared_blks_read) dependem dos
// planos, não da velocidade da máquina; em planos paralelos oscilam algumas
// unidades entre execuções, mas a distância entre as posições do ranking é
// de dezenas de milhares de blocos. O tempo total, usado no dia a dia, muda
// de ordem entre execuções (ver investigacoes/00-triagem).
const TOP_TRIAGEM_ESPERADO = ['01-fk-sem-indice', '03-paginacao-offset', '02-indice-ignorado'];

const INVESTIGACOES_DIR = path.join(__dirname, '..', 'investigacoes');
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

// Cada investigação tem consulta.sql (a consulta lenta) e correcao.sql. O
// "acesso" é como o plano lê a tabela investigada: o tipo do nó e, se
// houver, o índice usado (ver descreverAcesso). Opcionais:
//   - tentativa.sql + acessoTentativa: uma correção tentada antes do
//     chamado, que não resolveu. É aplicada num savepoint, conferida e
//     desfeita antes da correção, para cada uma ser avaliada sozinha.
//   - consulta-corrigida.sql + consultaCorrigida: true: quando a correção
//     inclui reescrever a consulta. Depois da correção, o plano conferido é
//     o dela, e o resultado dela tem que ser igual ao da consulta original.
//   - linhasAntes/linhasTentativa/linhasDepois: quantas linhas da tabela o
//     plano lê (ver linhasLidas). Necessário quando o tipo de acesso não
//     basta para diferenciar os cenários (ex.: dois Index Scan no mesmo
//     índice, um lendo 400 mil linhas e outro 20).
const INVESTIGACOES = [
  {
    pasta: '01-fk-sem-indice',
    tabela: 'itens_pedido',
    acessoAntes: 'Seq Scan',
    acessoDepois: 'Index Scan usando idx_itens_pedido_pedido_id',
  },
  {
    pasta: '02-indice-ignorado',
    tabela: 'clientes',
    acessoAntes: 'Seq Scan',
    acessoTentativa: 'Seq Scan',
    acessoDepois: 'Index Scan usando idx_clientes_lower_email',
  },
  {
    pasta: '03-paginacao-offset',
    tabela: 'pedidos',
    consultaCorrigida: true,
    acessoAntes: 'Seq Scan',
    linhasAntes: 500000,
    acessoTentativa: 'Index Scan usando idx_pedidos_data_id',
    linhasTentativa: 400500,
    acessoDepois: 'Index Scan usando idx_pedidos_data_id',
    linhasDepois: 20,
  },
];

function lerInvestigacao(pasta, arquivo) {
  return fs.readFileSync(path.join(INVESTIGACOES_DIR, pasta, arquivo), 'utf-8');
}

// Percorre o plano (EXPLAIN FORMAT JSON) e descreve como a tabela é lida,
// por exemplo "Seq Scan" ou "Index Scan usando idx_x". Um Parallel Seq
// Scan também é "Seq Scan": o que importa é ler a tabela inteira. Num
// Bitmap Heap Scan, o índice fica no nó filho (Bitmap Index Scan).
function descreverAcesso(plano, tabela) {
  const acessos = [];
  const visitar = (no) => {
    if (no['Relation Name'] === tabela) {
      const indice = no['Index Name'] || (no.Plans || []).map((f) => f['Index Name']).find(Boolean);
      acessos.push(indice ? `${no['Node Type']} usando ${indice}` : no['Node Type']);
    }
    (no.Plans || []).forEach(visitar);
  };
  visitar(plano);
  return acessos.join(' + ') || '(tabela não aparece no plano)';
}

// Linhas da tabela que o plano realmente leu (EXPLAIN ANALYZE): as que o nó
// devolveu mais as que ele descartou no filtro, vezes o número de execuções
// do nó. Ao contrário do tempo, é determinístico. Em nós paralelos, o
// PostgreSQL mostra médias por processo, arredondadas; por isso, esta
// conferência só é usada em investigações com planos sem paralelismo.
function linhasLidas(plano, tabela) {
  let total = 0;
  const visitar = (no) => {
    if (no['Relation Name'] === tabela) {
      total += ((no['Actual Rows'] || 0) + (no['Rows Removed by Filter'] || 0)) * (no['Actual Loops'] || 1);
    }
    (no.Plans || []).forEach(visitar);
  };
  visitar(plano);
  return total;
}

// Confere o acesso à tabela e, se houver valor esperado, as linhas lidas
// (este último executa a consulta, com EXPLAIN ANALYZE).
async function conferirPlano(client, rotulo, consulta, tabela, acessoEsperado, linhasEsperadas) {
  conferir(`${rotulo}: acesso a ${tabela}`, acessoEsperado, await acessoDaConsulta(client, consulta, tabela));
  if (linhasEsperadas !== undefined) {
    const r = await client.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${consulta}`);
    conferir(`${rotulo}: linhas lidas de ${tabela}`, linhasEsperadas, linhasLidas(r.rows[0]['QUERY PLAN'][0].Plan, tabela));
  }
}

async function acessoDaConsulta(client, consulta, tabela) {
  const r = await client.query(`EXPLAIN (FORMAT JSON) ${consulta}`);
  return descreverAcesso(r.rows[0]['QUERY PLAN'][0].Plan, tabela);
}

// Resultado de cada conferência, usado no resumo da CI.
const resultados = [];
let etapaAtual = '';

function iniciarEtapa(numero, nome) {
  etapaAtual = nome;
  console.log(`\n--- Etapa ${numero}: ${nome} ---`);
}

function conferir(label, esperado, encontrado) {
  const ok = esperado === encontrado;
  console.log(`  ${ok ? '✔' : '✘'} ${label}: esperado ${esperado}, encontrado ${encontrado}`);
  resultados.push({ etapa: etapaAtual, label, esperado, encontrado, ok });
  if (!ok) process.exitCode = 1;
}

// No GitHub Actions, GITHUB_STEP_SUMMARY aponta para um arquivo cujo
// conteúdo (Markdown) aparece na página da execução. Fora do Actions a
// variável não existe e nada é escrito.
function escreverResumoCi() {
  const arquivo = process.env.GITHUB_STEP_SUMMARY;
  if (!arquivo) return;

  const okCount = resultados.filter((r) => r.ok).length;
  const linhas = [
    '## Validação (Postgres embarcado)',
    '',
    `**${okCount}/${resultados.length} conferências OK**${okCount === resultados.length ? '' : ' — ver os itens marcados com ❌'}`,
    '',
    '| Etapa | Conferência | Esperado | Encontrado | |',
    '|---|---|---|---|---|',
    ...resultados.map((r) => `| ${r.etapa} | ${r.label} | ${r.esperado} | ${r.encontrado} | ${r.ok ? '✅' : '❌'} |`),
    '',
  ];
  fs.appendFileSync(arquivo, linhas.join('\n') + '\n');
}

async function listar(client, sql) {
  const result = await client.query(sql);
  return result.rows.map((r) => r.nome).join(', ');
}

// Investigação 04 (bloqueio): não compara planos, e sim o que acontece com
// outras sessões enquanto a migração roda. Usa conexões extras: A roda a
// migração, B faz o papel da aplicação e C segura uma transação de escrita
// aberta. As esperas usam lock_timeout, e cada conferência compara um
// resultado discreto (modo de bloqueio, "bloqueado"/"passou", válido ou não),
// nunca um tempo.
const BLOQUEIO_PASTA = '04-bloqueio-create-index';
const BLOQUEIO_INDICE = 'idx_itens_pedido_pedido_id';
const INSERT_APLICACAO =
  'INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES (1, 1, 1, 84.19)';

async function novaConexao() {
  const c = new Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'postgres', database: 'postgres' });
  await c.connect();
  return c;
}

async function modoDoBloqueio(observador, pid) {
  const r = await observador.query(
    "SELECT mode FROM pg_locks WHERE relation = 'itens_pedido'::regclass AND pid = $1 AND granted", [pid]);
  return r.rows.map((l) => l.mode).join(', ') || '(nenhum)';
}

// Tenta a escrita da aplicação numa transação desfeita em seguida. Com
// lock_timeout, uma espera por bloqueio vira o erro 55P03 em vez de travar.
async function tentarEscrita(sessao) {
  await sessao.query('BEGIN');
  try {
    await sessao.query(INSERT_APLICACAO);
    return 'passou';
  } catch (err) {
    if (err.code === '55P03') return 'bloqueado';
    throw err;
  } finally {
    await sessao.query('ROLLBACK');
  }
}

async function esperarFase(observador, pid, fase) {
  for (let i = 0; i < 100; i++) {
    const r = await observador.query('SELECT phase FROM pg_stat_progress_create_index WHERE pid = $1', [pid]);
    if (r.rows[0] && r.rows[0].phase === fase) return fase;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return '(fase não atingida em 10 s)';
}

async function indiceValido(observador) {
  const r = await observador.query(
    'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [BLOQUEIO_INDICE]);
  return r.rows[0] ? r.rows[0].indisvalid : '(não existe)';
}

async function verificarBloqueio(observador) {
  const migracao = lerInvestigacao(BLOQUEIO_PASTA, 'migracao.sql');
  const migracaoCorrigida = lerInvestigacao(BLOQUEIO_PASTA, 'migracao-corrigida.sql');
  const [a, b, c] = [await novaConexao(), await novaConexao(), await novaConexao()];
  const rotulo = (texto) => `${BLOQUEIO_PASTA}: ${texto}`;
  try {
    await b.query("SET lock_timeout = '1s'");

    // Parte 1: a migração comum, com a transação aberta (como se a
    // construção do índice ainda estivesse em andamento).
    await a.query('BEGIN');
    await a.query(migracao);
    conferir(rotulo('migração comum: bloqueio em itens_pedido'), 'ShareLock', await modoDoBloqueio(observador, a.processID));
    conferir(rotulo('migração comum: escrita da aplicação'), 'bloqueado', await tentarEscrita(b));
    const leitura = await b.query('SELECT count(*) FROM itens_pedido WHERE pedido_id = 1');
    conferir(rotulo('migração comum: leitura da aplicação'), 'passou', leitura.rows.length === 1 ? 'passou' : 'falhou');
    await a.query('ROLLBACK');

    // Parte 2: a migração corrigida, com C segurando uma escrita aberta. A
    // migração espera C antes de construir, mas a aplicação continua
    // escrevendo.
    await c.query('BEGIN');
    await c.query(INSERT_APLICACAO);
    const construcao = a.query(migracaoCorrigida);
    conferir(rotulo('migração corrigida: fase com uma escrita aberta'), 'waiting for writers before build',
      await esperarFase(observador, a.processID, 'waiting for writers before build'));
    conferir(rotulo('migração corrigida: bloqueio em itens_pedido'), 'ShareUpdateExclusiveLock',
      await modoDoBloqueio(observador, a.processID));
    conferir(rotulo('migração corrigida: escrita da aplicação'), 'passou', await tentarEscrita(b));
    await c.query('ROLLBACK');
    await construcao;
    conferir(rotulo('migração corrigida: índice válido no fim'), true, await indiceValido(observador));
    await observador.query(`DROP INDEX ${BLOQUEIO_INDICE}`);

    // Parte 3: as armadilhas da migração corrigida.
    let resultado;
    await a.query('BEGIN');
    try {
      await a.query(migracaoCorrigida);
      resultado = 'aceita';
    } catch (err) {
      resultado = err.code === '25001' ? 'recusada' : `erro ${err.code}`;
    }
    await a.query('ROLLBACK');
    conferir(rotulo('migração corrigida dentro de uma transação'), 'recusada', resultado);

    await c.query('BEGIN');
    await c.query(INSERT_APLICACAO);
    await a.query("SET lock_timeout = '1s'");
    try {
      await a.query(migracaoCorrigida);
      resultado = 'concluída';
    } catch (err) {
      resultado = err.code === '55P03' ? 'cancelada' : `erro ${err.code}`;
    }
    await c.query('ROLLBACK');
    conferir(rotulo('migração corrigida cancelada (lock_timeout)'), 'cancelada', resultado);
    conferir(rotulo('índice deixado pela migração cancelada é válido?'), false, await indiceValido(observador));
  } finally {
    // Volta ao schema base, sem o índice, aconteça o que acontecer acima.
    await observador.query(`DROP INDEX IF EXISTS ${BLOQUEIO_INDICE}`);
    for (const sessao of [a, b, c]) await sessao.end();
  }
  conferir(rotulo('schema base intacto no fim'), INDICES_ESPERADOS.join(', '),
    await listar(observador, "SELECT indexname AS nome FROM pg_indexes WHERE schemaname = 'public' ORDER BY 1"));
}

async function main() {
  await comPostgresEmbarcado({
    porta: PORT,
    pasta: DATA_DIR,
    postgresFlags: ['-c', 'shared_preload_libraries=pg_stat_statements'],
  }, async (client) => {
    iniciarEtapa(1, 'ambiente');
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

    iniciarEtapa(2, 'schema');
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

    iniciarEtapa(3, 'volume de dados');
    const inicio = Date.now();
    await client.query(lerSql('02_volume.sql'));
    console.log(`  Volume gerado em ${((Date.now() - inicio) / 1000).toFixed(1)} s`);
    // Numa chamada própria: o VACUUM não roda dentro de uma transação.
    await client.query(lerSql('03_vacuum.sql'));
    // Depois do VACUUM, todas as páginas ficam marcadas no mapa de
    // visibilidade (relallvisible = relpages). Sem ele, a primeira leitura de
    // cada página ainda grava as hint bits, e as investigações que citam
    // tempos e buffers teriam números diferentes na primeira execução.
    const naoVisiveis = await client.query(`
      SELECT string_agg(relname, ', ' ORDER BY relname) AS tabelas
      FROM pg_class
      WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relallvisible < relpages`);
    conferir('tabelas com páginas fora do mapa de visibilidade (VACUUM)', '(nenhuma)',
      naoVisiveis.rows[0].tabelas || '(nenhuma)');
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

    iniciarEtapa(4, 'triagem');
    await client.query('CREATE EXTENSION pg_stat_statements');
    await client.query('SELECT pg_stat_statements_reset()');
    await executarCarga(client);
    const estatisticas = await client.query(`
      SELECT query, calls, shared_blks_hit + shared_blks_read AS blocos
      FROM pg_stat_statements
      WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())`);
    // As consultas parametrizadas ficam registradas com o texto exato
    // enviado; é por ele que cada linha é ligada à consulta da carga. Por
    // isso, a carga não usa constantes no SQL: a pg_stat_statements as
    // troca por $n no texto registrado (ex.: LIMIT 20 vira LIMIT $2).
    const daCarga = CARGA.map((consulta) => {
      const linha = estatisticas.rows.find((r) => r.query === consulta.sql);
      return { ...consulta, calls: linha ? Number(linha.calls) : 0, blocos: linha ? Number(linha.blocos) : 0 };
    });
    conferir('consultas da carga registradas, com todas as execuções',
      CARGA.map((c) => c.execucoes).join(', '), daCarga.map((c) => c.calls).join(', '));
    const top = [...daCarga].sort((a, b) => b.blocos - a.blocos).slice(0, 3);
    conferir('top 3 por blocos lidos', TOP_TRIAGEM_ESPERADO.join(', '),
      top.map((c) => c.investigacao || c.nome).join(', '));

    iniciarEtapa(5, 'investigações');
    for (const inv of INVESTIGACOES) {
      const consulta = lerInvestigacao(inv.pasta, 'consulta.sql');
      const consultaDepois = inv.consultaCorrigida ? lerInvestigacao(inv.pasta, 'consulta-corrigida.sql') : consulta;
      await client.query('BEGIN');
      try {
        await conferirPlano(client, `${inv.pasta}: antes da correção`, consulta, inv.tabela,
          inv.acessoAntes, inv.linhasAntes);
        const antes = await client.query(consulta);

        if (inv.acessoTentativa) {
          await client.query('SAVEPOINT tentativa');
          await client.query(lerInvestigacao(inv.pasta, 'tentativa.sql'));
          await conferirPlano(client, `${inv.pasta}: com a tentativa anterior ao chamado`, consulta, inv.tabela,
            inv.acessoTentativa, inv.linhasTentativa);
          await client.query('ROLLBACK TO SAVEPOINT tentativa');
        }

        await client.query(lerInvestigacao(inv.pasta, 'correcao.sql'));

        await conferirPlano(client, `${inv.pasta}: depois da correção${inv.consultaCorrigida ? ' (consulta corrigida)' : ''}`,
          consultaDepois, inv.tabela, inv.acessoDepois, inv.linhasDepois);
        const depois = await client.query(consultaDepois);

        // A correção não pode mudar o que a consulta devolve. O número de
        // linhas entra no texto para que "0 linhas = 0 linhas" não passe
        // despercebido como sucesso.
        const resumo = (r) => `${r.rows.length} ${r.rows.length === 1 ? 'linha' : 'linhas'}, md5 ${crypto.createHash('md5').update(JSON.stringify(r.rows)).digest('hex')}`;
        conferir(`${inv.pasta}: resultado igual antes e depois`, resumo(antes), resumo(depois));
        if (antes.rows.length === 0) conferir(`${inv.pasta}: consulta devolve linhas`, true, false);
      } finally {
        await client.query('ROLLBACK');
      }
    }

    await verificarBloqueio(client);
  });

  escreverResumoCi();

  if (process.exitCode === 1) {
    console.log('\nValidação FALHOU — ver itens marcados com ✘ acima.');
  } else {
    console.log('\nValidação OK — ambiente, schema, volume de dados, triagem e investigações estão como esperado.');
  }
}

executar(main);
