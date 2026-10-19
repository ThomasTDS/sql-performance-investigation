-- Investigação 06: NOT IN com subconsulta.
-- Queries na ordem em que foram usadas, numeradas conforme os passos do
-- README. Tudo roda numa única transação desfeita no fim (ROLLBACK): os
-- índices criados ou removidos aqui não ficam assim no banco.
--
-- Atenção: as consultas com NOT IN levam cerca de 10 segundos cada.

BEGIN;

-- Preparação: reproduzir o estado do banco no momento do chamado, com o
-- índice que o time já tinha criado (tentativa.sql).
CREATE INDEX idx_pagamentos_pedido_id ON pagamentos (pedido_id);

-- Passo 1: o plano real do painel.
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.cliente_id, p.status, p.valor_total
FROM pedidos p
WHERE p.data_pedido >= '2025-12-31'
  AND p.data_pedido < '2026-01-01'
  AND p.id NOT IN (SELECT pedido_id FROM pagamentos)
ORDER BY p.id;

-- Passo 2: o índice existe e é válido?
SELECT i.indexrelid::regclass AS indice, i.indisvalid AS valido,
       pg_size_pretty(pg_relation_size(i.indexrelid)) AS tamanho
FROM pg_index AS i
WHERE i.indrelid = 'pagamentos'::regclass;

-- Passo 3: e com mais memória? Com work_mem maior, a lista inteira de
-- pagamentos cabe numa tabela hash (hashed SubPlan). SET LOCAL vale só até
-- o fim desta transação.
SET LOCAL work_mem = '64MB';

EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.cliente_id, p.status, p.valor_total
FROM pedidos p
WHERE p.data_pedido >= '2025-12-31'
  AND p.data_pedido < '2026-01-01'
  AND p.id NOT IN (SELECT pedido_id FROM pagamentos)
ORDER BY p.id;

RESET work_mem;

-- Passo 4: a reescrita com NOT EXISTS (consulta-corrigida.sql).
-- 4a. Com o índice da tentativa.
EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.cliente_id, p.status, p.valor_total
FROM pedidos p
WHERE p.data_pedido >= '2025-12-31'
  AND p.data_pedido < '2026-01-01'
  AND NOT EXISTS (SELECT 1 FROM pagamentos pg WHERE pg.pedido_id = p.id)
ORDER BY p.id;

-- 4b. Sem o índice (só dentro de um savepoint, desfeito logo em seguida).
SAVEPOINT sem_indice;
DROP INDEX idx_pagamentos_pedido_id;

EXPLAIN (ANALYZE, BUFFERS)
SELECT p.id, p.cliente_id, p.status, p.valor_total
FROM pedidos p
WHERE p.data_pedido >= '2025-12-31'
  AND p.data_pedido < '2026-01-01'
  AND NOT EXISTS (SELECT 1 FROM pagamentos pg WHERE pg.pedido_id = p.id)
ORDER BY p.id;

ROLLBACK TO SAVEPOINT sem_indice;

-- Passo 5: NOT IN e NOT EXISTS são sempre equivalentes? Uma pergunta
-- parecida, sobre outra coluna: quais vendedores não venderam nada desde as
-- 18h? pedidos.vendedor_id aceita nulos (pedidos sem vendedor).
SELECT
    (SELECT count(*) FROM vendedores v
     WHERE v.id NOT IN (SELECT vendedor_id FROM pedidos
                        WHERE data_pedido >= '2025-12-31 18:00')) AS com_not_in,
    (SELECT count(*) FROM vendedores v
     WHERE NOT EXISTS (SELECT 1 FROM pedidos p
                       WHERE p.vendedor_id = v.id
                         AND p.data_pedido >= '2025-12-31 18:00')) AS com_not_exists,
    (SELECT count(*) FROM pedidos
     WHERE data_pedido >= '2025-12-31 18:00' AND vendedor_id IS NULL) AS pedidos_sem_vendedor;

-- Passo 6: e no painel? A coluna da subconsulta aceita nulos?
SELECT table_name, column_name, is_nullable
FROM information_schema.columns
WHERE (table_name, column_name) IN (('pagamentos', 'pedido_id'), ('pedidos', 'vendedor_id'));

-- O resultado das duas versões do painel, comparado por md5.
SELECT
    (SELECT md5(string_agg(t::text, '|' ORDER BY t.id))
     FROM (SELECT p.id, p.cliente_id, p.status, p.valor_total
           FROM pedidos p
           WHERE p.data_pedido >= '2025-12-31'
             AND p.data_pedido < '2026-01-01'
             AND p.id NOT IN (SELECT pedido_id FROM pagamentos)) AS t)
    =
    (SELECT md5(string_agg(t::text, '|' ORDER BY t.id))
     FROM (SELECT p.id, p.cliente_id, p.status, p.valor_total
           FROM pedidos p
           WHERE p.data_pedido >= '2025-12-31'
             AND p.data_pedido < '2026-01-01'
             AND NOT EXISTS (SELECT 1 FROM pagamentos pg WHERE pg.pedido_id = p.id)) AS t)
    AS resultados_iguais;

ROLLBACK;
