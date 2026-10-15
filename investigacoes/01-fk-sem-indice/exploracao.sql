-- Investigação 01: chave estrangeira sem índice.
-- Queries na ordem em que foram usadas, numeradas conforme os passos do
-- README. Os passos 6 e 7 abrem uma transação e terminam com ROLLBACK:
-- nada do que eles criam ou apagam permanece no banco.

-- Passo 1: reproduzir a lentidão e ver o plano de execução.
EXPLAIN (ANALYZE, BUFFERS)
SELECT
    i.id,
    i.produto_id,
    p.nome AS produto,
    i.quantidade,
    i.preco_unitario,
    i.quantidade * i.preco_unitario AS subtotal
FROM itens_pedido i
JOIN produtos p ON p.id = i.produto_id
WHERE i.pedido_id = 428117
ORDER BY i.id;

-- Passo 2: o banco está lento em geral? Busca do mesmo pedido pela chave
-- primária, na mesma tabela de pedidos que a tela também consulta.
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM pedidos WHERE id = 428117;

-- Passo 3: quais índices existem em itens_pedido?
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'itens_pedido';

-- Passo 4: as estimativas do planejador estão certas? Linhas da tabela,
-- valores distintos de pedido_id segundo as estatísticas (negativo =
-- fração do total de linhas) e a distribuição real de itens por pedido.
SELECT
    c.reltuples::bigint AS linhas_estimadas,
    s.n_distinct
FROM pg_class c
JOIN pg_stats s ON s.tablename = c.relname AND s.attname = 'pedido_id'
WHERE c.relname = 'itens_pedido';

SELECT count(*) AS pedidos, round(avg(qtd), 2) AS media_itens, max(qtd) AS max_itens
FROM (SELECT pedido_id, count(*) AS qtd FROM itens_pedido GROUP BY pedido_id) AS x;

-- Passo 5: o problema é só desta coluna? Todas as chaves estrangeiras do
-- schema e se existe algum índice começando pela coluna delas.
SELECT
    c.conrelid::regclass AS tabela,
    a.attname AS coluna,
    c.confrelid::regclass AS referencia,
    EXISTS (
        SELECT 1 FROM pg_index i
        WHERE i.indrelid = c.conrelid AND i.indkey[0] = c.conkey[1]
    ) AS tem_indice
FROM pg_constraint c
JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
WHERE c.contype = 'f'
ORDER BY 1, 2;

-- Passo 6: aplicar a correção numa transação e medir de novo.
BEGIN;

CREATE INDEX idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);

EXPLAIN (ANALYZE, BUFFERS)
SELECT
    i.id,
    i.produto_id,
    p.nome AS produto,
    i.quantidade,
    i.preco_unitario,
    i.quantidade * i.preco_unitario AS subtotal
FROM itens_pedido i
JOIN produtos p ON p.id = i.produto_id
WHERE i.pedido_id = 428117
ORDER BY i.id;

SELECT pg_size_pretty(pg_relation_size('idx_itens_pedido_pedido_id')) AS tamanho_indice;

ROLLBACK;

-- Passo 7: efeito da falta de índice na remoção de um pedido. Para apagar
-- um pedido, o banco precisa confirmar que nenhum item e nenhum pagamento
-- aponta para ele (as linhas "Trigger for constraint" do plano). Primeiro
-- sem o índice e depois com ele, cada um na sua transação.
BEGIN;
DELETE FROM pagamentos WHERE pedido_id = 428117;
DELETE FROM itens_pedido WHERE pedido_id = 428117;
EXPLAIN (ANALYZE) DELETE FROM pedidos WHERE id = 428117;
ROLLBACK;

BEGIN;
CREATE INDEX idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);
DELETE FROM pagamentos WHERE pedido_id = 428117;
DELETE FROM itens_pedido WHERE pedido_id = 428117;
EXPLAIN (ANALYZE) DELETE FROM pedidos WHERE id = 428117;
ROLLBACK;
