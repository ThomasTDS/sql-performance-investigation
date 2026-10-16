-- Correção: índice sobre a expressão que a consulta usa, lower(email).
--
-- Em produção, use CREATE INDEX CONCURRENTLY (ver a investigação 01). Aqui
-- está a forma comum porque a validação aplica a correção dentro de uma
-- transação para desfazê-la depois.
CREATE INDEX idx_clientes_lower_email ON clientes (lower(email));

-- Um índice de expressão faz o ANALYZE passar a coletar estatísticas sobre
-- a expressão. Até o próximo ANALYZE (manual ou do autovacuum), o
-- planejador estima as linhas de lower(email) = '...' com um valor
-- genérico (0,5% da tabela) e escolhe um plano pior que o ideal.
ANALYZE clientes;
