-- Investigação 03: paginação com OFFSET alto.
-- Queries na ordem em que foram usadas, numeradas conforme os passos do
-- README. Tudo roda numa única transação desfeita no fim (ROLLBACK): os
-- índices criados ou removidos aqui não ficam assim no banco.

BEGIN;

-- Preparação: reproduzir o estado do banco no momento do chamado, com o
-- índice que o time já tinha criado (tentativa.sql).
CREATE INDEX idx_pedidos_data_id ON pedidos (data_pedido, id);

-- Passo 1: a mesma listagem em três páginas diferentes: 2, 2.001 e 20.025.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
ORDER BY data_pedido DESC, id DESC
LIMIT 20 OFFSET 20;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
ORDER BY data_pedido DESC, id DESC
LIMIT 20 OFFSET 40000;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
ORDER BY data_pedido DESC, id DESC
LIMIT 20 OFFSET 400480;

-- Passo 2: e sem o índice? A página 20.025 com o índice removido (só dentro
-- de um savepoint, desfeito logo em seguida).
SAVEPOINT sem_indice;
DROP INDEX idx_pedidos_data_id;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
ORDER BY data_pedido DESC, id DESC
LIMIT 20 OFFSET 400480;

ROLLBACK TO SAVEPOINT sem_indice;

-- Passo 3: o id é mesmo necessário na ordenação? Quantas linhas a mais do
-- que datas distintas a tabela tem (ou seja, quantas repetições de data)?
SELECT count(*) - count(DISTINCT data_pedido) AS pedidos_com_data_repetida
FROM pedidos;

-- Passo 4: o cursor da paginação por chave: a última linha da página
-- 20.024 (a linha de posição 400.480 na ordem da listagem) e, para
-- comparar, a primeira da página seguinte.
SELECT id, data_pedido
FROM pedidos
ORDER BY data_pedido DESC, id DESC
LIMIT 2 OFFSET 400479;

-- Passo 5: a página 20.025 com paginação por chave (consulta-corrigida.sql).
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
WHERE (data_pedido, id) < ('2023-12-04 11:43:35', 320010)
ORDER BY data_pedido DESC, id DESC
LIMIT 20;

-- Passo 6: as duas consultas devolvem exatamente as mesmas linhas, na mesma
-- ordem?
SELECT
    (SELECT md5(string_agg(t::text, '|' ORDER BY ordem))
     FROM (SELECT p.*, row_number() OVER () AS ordem
           FROM (SELECT id, cliente_id, data_pedido, status, valor_total
                 FROM pedidos
                 ORDER BY data_pedido DESC, id DESC
                 LIMIT 20 OFFSET 400480) AS p) AS t)
    =
    (SELECT md5(string_agg(t::text, '|' ORDER BY ordem))
     FROM (SELECT p.*, row_number() OVER () AS ordem
           FROM (SELECT id, cliente_id, data_pedido, status, valor_total
                 FROM pedidos
                 WHERE (data_pedido, id) < ('2023-12-04 11:43:35', 320010)
                 ORDER BY data_pedido DESC, id DESC
                 LIMIT 20) AS p) AS t)
    AS mesmo_resultado;

-- Passo 7: e se o cursor usasse só a data? Quais pedidos da página
-- verdadeira ficariam de fora?
SELECT id, data_pedido
FROM (SELECT id, data_pedido
      FROM pedidos
      ORDER BY data_pedido DESC, id DESC
      LIMIT 20 OFFSET 400480) AS pagina_verdadeira
EXCEPT
SELECT id, data_pedido
FROM (SELECT id, data_pedido
      FROM pedidos
      WHERE data_pedido < '2023-12-04 11:43:35'
      ORDER BY data_pedido DESC, id DESC
      LIMIT 20) AS pagina_so_com_data;

ROLLBACK;
