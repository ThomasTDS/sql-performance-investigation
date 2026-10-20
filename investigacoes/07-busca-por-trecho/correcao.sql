-- Correção: um índice de trigramas em telefone.
--
-- A extensão pg_trgm (que vem com o PostgreSQL, no pacote contrib) quebra
-- cada texto em trigramas, sequências de 3 caracteres, e um índice GIN
-- guarda em quais linhas aparece cada trigrama. Uma busca LIKE '%-4217'
-- vira "linhas que têm os trigramas de '-4217'", e o índice responde sem
-- ler a tabela inteira, mesmo com o curinga no começo.
--
-- Em produção, use CREATE INDEX CONCURRENTLY (ver a investigação 04). Aqui
-- está a forma comum porque a validação aplica a correção dentro de uma
-- transação para desfazê-la depois. O CREATE EXTENSION também é desfeito
-- pelo ROLLBACK.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_clientes_telefone_trgm ON clientes USING gin (telefone gin_trgm_ops);
