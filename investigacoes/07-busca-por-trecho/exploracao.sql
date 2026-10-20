-- Investigação 07: busca por trecho do texto (LIKE com curinga no começo).
-- Queries na ordem em que foram usadas, numeradas conforme os passos do
-- README. Tudo roda numa única transação desfeita no fim (ROLLBACK): a
-- extensão e os índices criados aqui não ficam no banco.

BEGIN;

-- Preparação: reproduzir o estado do banco no momento do chamado, com o
-- índice que o time já tinha criado (tentativa.sql).
CREATE INDEX idx_clientes_telefone ON clientes (telefone);

-- Passo 1: o plano real da busca.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, telefone
FROM clientes
WHERE telefone LIKE '%-4217'
ORDER BY id;

-- Passo 2: o índice B-tree serve para quê? A mesma coluna, buscando pelo
-- começo do telefone em vez do fim.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, telefone
FROM clientes
WHERE telefone LIKE '(11) 90421%'
ORDER BY id;

-- Passo 3: como o pg_trgm enxerga o texto: os trigramas de um telefone e
-- os do trecho buscado.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

SELECT show_trgm('(11) 94217-4217') AS trigramas_do_telefone;
SELECT show_trgm('-4217') AS trigramas_do_trecho;

-- Passo 4: a correção (correcao.sql) e o plano depois dela.
CREATE INDEX idx_clientes_telefone_trgm ON clientes USING gin (telefone gin_trgm_ops);

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, telefone
FROM clientes
WHERE telefone LIKE '%-4217'
ORDER BY id;

-- Passo 5: o custo do índice. Tamanho da tabela e de cada índice.
SELECT c.relname AS objeto, pg_size_pretty(pg_relation_size(c.oid)) AS tamanho
FROM pg_class AS c
WHERE c.relname IN ('clientes', 'clientes_pkey', 'idx_clientes_telefone', 'idx_clientes_telefone_trgm')
ORDER BY pg_relation_size(c.oid) DESC;

-- Passo 6: o limite dos trigramas. Com menos de 3 caracteres fora dos
-- curingas, não há trigrama completo para procurar.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, telefone
FROM clientes
WHERE telefone LIKE '%17%'
ORDER BY id;

ROLLBACK;
