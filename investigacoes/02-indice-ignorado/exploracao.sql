-- Investigação 02: índice ignorado por causa de uma função na coluna.
-- Queries na ordem em que foram usadas, numeradas conforme os passos do
-- README. Tudo roda numa única transação desfeita no fim (ROLLBACK): os
-- índices criados aqui não permanecem no banco.

BEGIN;

-- Preparação: reproduzir o estado do banco no momento do chamado, com o
-- índice que o time já tinha criado (tentativa.sql).
CREATE INDEX idx_clientes_email ON clientes (email);

-- Passo 1: o plano de execução real da busca.
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, status
FROM clientes
WHERE lower(email) = lower('Cliente04217@Exemplo.com');

-- Passo 2: o índice está válido?
SELECT
    indexrelid::regclass AS indice,
    indisvalid AS valido,
    indisready AS pronto,
    pg_get_indexdef(indexrelid) AS definicao
FROM pg_index
WHERE indrelid = 'clientes'::regclass;

-- Passo 3: o planejador está preferindo o Seq Scan, ou não consegue usar o
-- índice? Com enable_seqscan = off, o Seq Scan recebe um custo proibitivo:
-- se ainda assim ele aparecer, não existe outro caminho.
SET LOCAL enable_seqscan = off;
EXPLAIN
SELECT id, nome, email, status
FROM clientes
WHERE lower(email) = lower('Cliente04217@Exemplo.com');
RESET enable_seqscan;

-- Passo 4: a mesma busca comparando a coluna diretamente, sem lower().
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, status
FROM clientes
WHERE email = 'cliente04217@exemplo.com';

-- ... e por que a aplicação usa lower(): a comparação direta diferencia
-- maiúsculas de minúsculas, e o email digitado não é encontrado.
SELECT count(*) AS encontrados
FROM clientes
WHERE email = 'Cliente04217@Exemplo.com';

-- Passo 5: aplicar a correção (correcao.sql) e medir antes e depois do
-- ANALYZE.
CREATE INDEX idx_clientes_lower_email ON clientes (lower(email));

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, status
FROM clientes
WHERE lower(email) = lower('Cliente04217@Exemplo.com');

ANALYZE clientes;

EXPLAIN (ANALYZE, BUFFERS)
SELECT id, nome, email, status
FROM clientes
WHERE lower(email) = lower('Cliente04217@Exemplo.com');

SELECT
    pg_size_pretty(pg_relation_size('idx_clientes_email')) AS indice_comum,
    pg_size_pretty(pg_relation_size('idx_clientes_lower_email')) AS indice_expressao;

-- Passo 6: a correção também atende busca por prefixo? (com locale C, sim)
EXPLAIN
SELECT id, email
FROM clientes
WHERE lower(email) LIKE 'cliente042%';

-- Passo 7: alternativa de correção. Há emails gravados com maiúsculas?
SELECT count(*) AS emails_com_maiuscula
FROM clientes
WHERE email <> lower(email);

ROLLBACK;
