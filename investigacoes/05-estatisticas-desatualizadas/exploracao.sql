-- Investigação 05: estatísticas desatualizadas depois de uma importação.
-- Queries na ordem em que foram usadas, numeradas conforme os passos do
-- README. Tudo roda numa única transação desfeita no fim (ROLLBACK): a
-- importação, o índice e as estatísticas novas não ficam no banco.

BEGIN;

-- Preparação: reproduzir o estado do banco no momento do chamado, com a
-- importação de janeiro de 2026 já feita e sem ANALYZE depois dela. O
-- docker-compose.yml monta a pasta investigacoes/ em /investigacoes.
\i /investigacoes/05-estatisticas-desatualizadas/cenario.sql

-- Passo 1: o plano real do relatório.
-- 1a. Janeiro de 2026, o mês do chamado.
EXPLAIN (ANALYZE, BUFFERS)
SELECT v.equipe, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN vendedores v ON v.id = p.vendedor_id
WHERE p.data_pedido >= '2026-01-01'
  AND p.data_pedido < '2026-02-01'
  AND p.status <> 'cancelado'
GROUP BY v.equipe
ORDER BY total DESC;

-- 1b. Dezembro de 2025, o mês anterior, para comparar.
EXPLAIN (ANALYZE, BUFFERS)
SELECT v.equipe, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN vendedores v ON v.id = p.vendedor_id
WHERE p.data_pedido >= '2025-12-01'
  AND p.data_pedido < '2026-01-01'
  AND p.status <> 'cancelado'
GROUP BY v.equipe
ORDER BY total DESC;

-- Passo 2: o que o planejador sabe sobre data_pedido. O histograma das
-- estatísticas divide os valores em 100 faixas; a última fronteira é a
-- maior data que ele conhece.
SELECT
    (histogram_bounds::text::timestamp[])[array_upper(histogram_bounds::text::timestamp[], 1)]
        AS maior_data_nas_estatisticas,
    (SELECT max(data_pedido) FROM pedidos) AS maior_data_real
FROM pg_stats
WHERE tablename = 'pedidos' AND attname = 'data_pedido';

SELECT count(*) AS pedidos_de_janeiro
FROM pedidos
WHERE data_pedido >= '2026-01-01' AND data_pedido < '2026-02-01';

-- Passo 3: por que o autovacuum não atualizou as estatísticas? Ele refaz
-- o ANALYZE de uma tabela quando as linhas alteradas desde o último passam
-- de autovacuum_analyze_threshold + autovacuum_analyze_scale_factor ×
-- linhas da tabela.
SELECT
    c.reltuples::bigint AS linhas_nas_estatisticas,
    current_setting('autovacuum_analyze_threshold')::int
        + current_setting('autovacuum_analyze_scale_factor')::float * c.reltuples AS gatilho_do_autovacuum,
    (SELECT count(*) FROM pedidos WHERE id > 500000) AS linhas_importadas
FROM pg_class AS c
WHERE c.relname = 'pedidos';

-- Passo 4: outros relatórios do mês, com a mesma estimativa errada.
-- 4a. Os 10 maiores clientes de janeiro.
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.id, c.nome, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN clientes c ON c.id = p.cliente_id
WHERE p.data_pedido >= '2026-01-01'
  AND p.data_pedido < '2026-02-01'
  AND p.status <> 'cancelado'
GROUP BY c.id, c.nome
ORDER BY total DESC, c.id
LIMIT 10;

-- 4b. O resumo de janeiro por status (sem join).
EXPLAIN (ANALYZE, BUFFERS)
SELECT status, count(*) AS pedidos, sum(valor_total) AS total
FROM pedidos
WHERE data_pedido >= '2026-01-01' AND data_pedido < '2026-02-01'
GROUP BY status
ORDER BY status;

-- Passo 5: e se o time criasse um índice em data_pedido? (Só dentro de um
-- savepoint, desfeito logo em seguida.)
SAVEPOINT com_indice;
CREATE INDEX idx_pedidos_data_pedido ON pedidos (data_pedido);

EXPLAIN (ANALYZE, BUFFERS)
SELECT v.equipe, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN vendedores v ON v.id = p.vendedor_id
WHERE p.data_pedido >= '2026-01-01'
  AND p.data_pedido < '2026-02-01'
  AND p.status <> 'cancelado'
GROUP BY v.equipe
ORDER BY total DESC;

ROLLBACK TO SAVEPOINT com_indice;

-- Passo 6: a correção (correcao.sql) e o plano depois dela.
ANALYZE pedidos;

EXPLAIN (ANALYZE, BUFFERS)
SELECT v.equipe, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN vendedores v ON v.id = p.vendedor_id
WHERE p.data_pedido >= '2026-01-01'
  AND p.data_pedido < '2026-02-01'
  AND p.status <> 'cancelado'
GROUP BY v.equipe
ORDER BY total DESC;

SELECT
    (histogram_bounds::text::timestamp[])[array_upper(histogram_bounds::text::timestamp[], 1)]
        AS maior_data_nas_estatisticas
FROM pg_stats
WHERE tablename = 'pedidos' AND attname = 'data_pedido';

-- Os relatórios do passo 4, depois da correção.
EXPLAIN (ANALYZE, BUFFERS)
SELECT c.id, c.nome, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN clientes c ON c.id = p.cliente_id
WHERE p.data_pedido >= '2026-01-01'
  AND p.data_pedido < '2026-02-01'
  AND p.status <> 'cancelado'
GROUP BY c.id, c.nome
ORDER BY total DESC, c.id
LIMIT 10;

EXPLAIN (ANALYZE, BUFFERS)
SELECT status, count(*) AS pedidos, sum(valor_total) AS total
FROM pedidos
WHERE data_pedido >= '2026-01-01' AND data_pedido < '2026-02-01'
GROUP BY status
ORDER BY status;

ROLLBACK;
