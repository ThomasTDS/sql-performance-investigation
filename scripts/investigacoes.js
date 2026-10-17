// Investigações de plano (01 a 03 e 05): a configuração que diz o que esperar
// de cada uma e as funções que leem os planos de execução. Usado pela
// validação (validate.js) e pelas medições (medir.js).

const path = require('node:path');
const fs = require('node:fs');

const INVESTIGACOES_DIR = path.join(__dirname, '..', 'investigacoes');

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
//   - cenario.sql + cenario: true: dados que precisam existir antes do
//     "antes" (ex.: uma importação sem ANALYZE). É aplicado logo depois do
//     BEGIN, e o ROLLBACK do fim também o desfaz.
//   - juncaoAntes/juncaoTentativa/juncaoDepois: o tipo do join que recebe
//     as linhas da tabela (ver juncaoDaTabela). Para quando a correção muda
//     o join, e não o acesso à tabela.
//   - estimativaAntes/estimativaTentativa/estimativaDepois: 'certa' ou
//     'errada' (ver estimativaDaTabela).
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
  {
    pasta: '05-estatisticas-desatualizadas',
    tabela: 'pedidos',
    cenario: true,
    acessoAntes: 'Seq Scan',
    juncaoAntes: 'Nested Loop',
    estimativaAntes: 'errada',
    acessoDepois: 'Seq Scan',
    juncaoDepois: 'Hash Join',
    estimativaDepois: 'certa',
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

// O join mais próximo acima da leitura da tabela, ou seja, o que recebe as
// linhas dela: 'Nested Loop', 'Hash Join' ou 'Merge Join'. Nós no caminho
// que não são join (Gather, Hash, Sort...) são ignorados.
const JUNCOES = ['Nested Loop', 'Hash Join', 'Merge Join'];

function juncaoDaTabela(plano, tabela) {
  const juncoes = [];
  const visitar = (no, juncaoAcima) => {
    if (no['Relation Name'] === tabela) juncoes.push(juncaoAcima || '(sem join)');
    const juncao = JUNCOES.includes(no['Node Type']) ? no['Node Type'] : juncaoAcima;
    (no.Plans || []).forEach((filho) => visitar(filho, juncao));
  };
  visitar(plano, null);
  return juncoes.join(' + ') || '(tabela não aparece no plano)';
}

// Compara, no nó que lê a tabela (EXPLAIN ANALYZE), as linhas estimadas
// com as reais. As duas são por execução do nó (em nós paralelos, por
// processo), então a proporção vale nos dois casos. Até 10 vezes de
// diferença é 'certa': o ANALYZE lê uma amostra aleatória, e a estimativa
// varia um pouco a cada execução.
function estimativaDaTabela(plano, tabela) {
  const avaliacoes = [];
  const visitar = (no) => {
    if (no['Relation Name'] === tabela) {
      const estimadas = Math.max(no['Plan Rows'], 1);
      const reais = Math.max(no['Actual Rows'], 1);
      avaliacoes.push(Math.max(estimadas / reais, reais / estimadas) <= 10 ? 'certa' : 'errada');
    }
    (no.Plans || []).forEach(visitar);
  };
  visitar(plano);
  return avaliacoes.join(' + ') || '(tabela não aparece no plano)';
}

async function acessoDaConsulta(client, consulta, tabela) {
  const r = await client.query(`EXPLAIN (FORMAT JSON) ${consulta}`);
  return descreverAcesso(r.rows[0]['QUERY PLAN'][0].Plan, tabela);
}

module.exports = {
  INVESTIGACOES, lerInvestigacao, descreverAcesso, linhasLidas, juncaoDaTabela, estimativaDaTabela, acessoDaConsulta,
};
