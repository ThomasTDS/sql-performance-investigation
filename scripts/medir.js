// Mede as investigações de plano (01 a 03) e grava investigacoes/MEDICOES.md:
// para cada cenário (antes, tentativa, depois), o plano, as linhas lidas, os
// buffers e o tempo de execução (mediana e faixa de várias execuções).
//
// Os tempos dependem da máquina e do momento, e por isso não são conferidos
// pela validação. Este script existe para que os números citados nos
// relatórios possam ser refeitos de forma padronizada, com o registro de
// onde e quando foram medidos.
//
// Uso:
//   npm run medir                     mede e grava investigacoes/MEDICOES.md
//   npm run medir -- --sem-arquivo    só mostra (usado na CI, que escreve a
//                                     tabela no resumo da execução)

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { lerSql, comPostgresEmbarcado, executar } = require('./postgres-embarcado');
const { INVESTIGACOES, lerInvestigacao, linhasLidas, acessoDaConsulta } = require('./investigacoes');

const EXECUCOES = 5;
const ARQUIVO = path.join(__dirname, '..', 'investigacoes', 'MEDICOES.md');

const numero = (n, casas = 0) => n.toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
// Milissegundos com casas decimais suficientes para tempos abaixo de 1 ms.
const ms = (t) => `${numero(t, t < 1 ? 3 : t < 10 ? 2 : 1)} ms`;

// Uma execução descartada (aquece o cache) e depois EXECUCOES medidas.
async function medirConsulta(client, consulta, tabela) {
  const acesso = await acessoDaConsulta(client, consulta, tabela);
  await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${consulta}`);
  const tempos = [];
  let plano;
  for (let i = 0; i < EXECUCOES; i++) {
    const r = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${consulta}`);
    plano = r.rows[0]['QUERY PLAN'][0];
    tempos.push(plano['Execution Time']);
  }
  tempos.sort((a, b) => a - b);
  return {
    acesso,
    linhas: linhasLidas(plano.Plan, tabela),
    buffers: plano.Plan['Shared Hit Blocks'] + plano.Plan['Shared Read Blocks'],
    mediana: tempos[Math.floor(tempos.length / 2)],
    minimo: tempos[0],
    maximo: tempos[tempos.length - 1],
  };
}

async function medirInvestigacao(client, inv) {
  const consulta = lerInvestigacao(inv.pasta, 'consulta.sql');
  const consultaDepois = inv.consultaCorrigida ? lerInvestigacao(inv.pasta, 'consulta-corrigida.sql') : consulta;
  const cenarios = [];
  await client.query('BEGIN');
  try {
    cenarios.push({ nome: 'antes', ...(await medirConsulta(client, consulta, inv.tabela)) });
    if (inv.acessoTentativa) {
      await client.query('SAVEPOINT tentativa');
      await client.query(lerInvestigacao(inv.pasta, 'tentativa.sql'));
      cenarios.push({ nome: 'tentativa', ...(await medirConsulta(client, consulta, inv.tabela)) });
      await client.query('ROLLBACK TO SAVEPOINT tentativa');
    }
    await client.query(lerInvestigacao(inv.pasta, 'correcao.sql'));
    cenarios.push({ nome: 'depois', ...(await medirConsulta(client, consultaDepois, inv.tabela)) });
  } finally {
    await client.query('ROLLBACK');
  }
  return cenarios;
}

function gerarMarkdown(ambiente, resultados) {
  const linhas = [
    '# Medições das investigações',
    '',
    '> Arquivo gerado por `npm run medir`. Não edite à mão: rode o script de novo para atualizar.',
    '',
    `- **Gerado em:** ${ambiente.data}`,
    `- **Sistema:** ${ambiente.sistema}`,
    `- **CPU:** ${ambiente.cpu}`,
    `- **PostgreSQL:** ${ambiente.postgres} (embarcado) · **Node.js:** ${ambiente.node}`,
    '',
    `Cada tempo é a mediana de ${EXECUCOES} execuções com \`EXPLAIN (ANALYZE, BUFFERS)\`, depois de uma execução descartada para aquecer o cache. A faixa mostra o menor e o maior tempo. Linhas lidas e buffers são da tabela investigada e da consulta inteira, respectivamente, e quase não variam entre máquinas. Os tempos variam: numa mesma máquina, já foram observadas diferenças de até 5 vezes entre sessões.`,
    '',
    '| Investigação | Cenário | Acesso à tabela | Linhas lidas | Buffers | Tempo (mediana) | Faixa |',
    '|---|---|---|---:|---:|---:|---|',
  ];
  for (const { inv, cenarios } of resultados) {
    for (const c of cenarios) {
      linhas.push(`| [${inv.pasta}](${inv.pasta}/README.md) | ${c.nome} | \`${c.acesso}\` | ${numero(c.linhas)} | ${numero(c.buffers)} | ${ms(c.mediana)} | ${ms(c.minimo)} a ${ms(c.maximo)} |`);
    }
  }
  linhas.push('');
  return linhas.join('\n');
}

async function main() {
  const semArquivo = process.argv.includes('--sem-arquivo');
  await comPostgresEmbarcado({ porta: 5435, pasta: path.join(__dirname, '..', '.pgdata-medir') }, async (client) => {
    console.log('Carregando o schema e gerando o volume de dados...');
    await client.query(lerSql('01_schema.sql'));
    await client.query(lerSql('02_volume.sql'));
    await client.query(lerSql('03_vacuum.sql'));

    const resultados = [];
    for (const inv of INVESTIGACOES) {
      console.log(`Medindo ${inv.pasta}...`);
      resultados.push({ inv, cenarios: await medirInvestigacao(client, inv) });
    }

    const ambiente = {
      data: new Date().toISOString().slice(0, 10),
      sistema: `${os.type()} ${os.release()} (${os.arch()})`,
      cpu: `${os.cpus()[0].model.trim()} · ${os.cpus().length} núcleos`,
      postgres: (await client.query('SHOW server_version')).rows[0].server_version,
      node: process.version,
    };
    const markdown = gerarMarkdown(ambiente, resultados);

    console.log(`\n${markdown}`);
    if (!semArquivo) {
      fs.writeFileSync(ARQUIVO, markdown);
      console.log(`Gravado em ${path.relative(process.cwd(), ARQUIVO)}`);
    }
    // No GitHub Actions, a tabela também vai para o resumo da execução.
    if (process.env.GITHUB_STEP_SUMMARY) {
      // Os links relativos não funcionam no resumo: lá, só o nome da pasta.
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}\n`);
    }
  });
}

executar(main);
