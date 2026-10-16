// Carga simulada da aplicação, usada na triagem (investigacoes/00-triagem):
// as consultas que a aplicação faz, cada uma executada algumas vezes com
// parâmetros diferentes, como aconteceria num dia de uso. Três delas são as
// consultas das investigações 01 a 03, na forma parametrizada que a
// aplicação usaria; as demais são consultas rápidas do dia a dia.
//
// As quantidades de execuções são pequenas para a validação rodar rápido,
// mas mantêm uma proporção plausível: consultas pela chave primária são as
// mais frequentes, e a busca por email (login) é mais frequente que a
// listagem e os detalhes do pedido. Os parâmetros saem de fórmulas fixas,
// então a carga é sempre a mesma.

const CARGA = [
  {
    nome: 'Pedido pela chave primária',
    sql: 'SELECT id, cliente_id, data_pedido, status, valor_total FROM pedidos WHERE id = $1',
    execucoes: 200,
    parametros: (i) => [((i * 7919) % 500000) + 1],
  },
  {
    nome: 'Cliente pela chave primária',
    sql: 'SELECT id, nome, email, status FROM clientes WHERE id = $1',
    execucoes: 100,
    parametros: (i) => [((i * 104729) % 50000) + 1],
  },
  {
    nome: 'Produtos de uma categoria',
    sql: 'SELECT id, nome, preco FROM produtos WHERE categoria = $1 ORDER BY nome',
    execucoes: 100,
    parametros: (i) => [['Eletrônicos', 'Informática', 'Casa', 'Escritório', 'Esporte',
      'Livros', 'Brinquedos', 'Beleza', 'Ferramentas', 'Alimentos'][i % 10]],
  },
  {
    nome: 'Busca de cliente por email (login)',
    investigacao: '02-indice-ignorado',
    sql: 'SELECT id, nome, email, status FROM clientes WHERE lower(email) = lower($1)',
    execucoes: 60,
    parametros: (i) => [`Cliente${String(((i * 7907) % 50000) + 1).padStart(5, '0')}@Exemplo.com`],
  },
  {
    nome: 'Itens do pedido (tela "Detalhes do pedido")',
    investigacao: '01-fk-sem-indice',
    sql: 'SELECT i.id, i.produto_id, p.nome AS produto, i.quantidade, i.preco_unitario, '
      + 'i.quantidade * i.preco_unitario AS subtotal FROM itens_pedido i '
      + 'JOIN produtos p ON p.id = i.produto_id WHERE i.pedido_id = $1 ORDER BY i.id',
    execucoes: 20,
    parametros: (i) => [((i * 4993) % 500000) + 1],
  },
  {
    // A maioria dos acessos é nas primeiras páginas; alguns vêm da
    // exportação, que passa pelas páginas finais.
    nome: 'Listagem de pedidos (backoffice)',
    investigacao: '03-paginacao-offset',
    sql: 'SELECT id, cliente_id, data_pedido, status, valor_total FROM pedidos '
      + 'ORDER BY data_pedido DESC, id DESC LIMIT $1 OFFSET $2',
    execucoes: 20,
    parametros: (i) => [20, i <= 16 ? (i % 5) * 20 : 400000 + i * 20],
  },
];

// Executa a carga com consultas parametrizadas, como um driver de aplicação
// faria. É isso que permite à pg_stat_statements agrupar todas as execuções
// de uma consulta numa única linha, independentemente do parâmetro.
async function executarCarga(client) {
  for (const consulta of CARGA) {
    for (let i = 1; i <= consulta.execucoes; i++) {
      await client.query(consulta.sql, consulta.parametros(i));
    }
  }
}

module.exports = { CARGA, executarCarga };
