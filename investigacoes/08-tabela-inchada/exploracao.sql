-- Investigação 08: tabela inchada depois de um UPDATE em massa.
-- Queries na ordem em que foram usadas, numeradas conforme os passos do
-- README.
--
-- Atenção: diferente das outras investigações, este arquivo NÃO roda numa
-- transação desfeita no fim, porque o VACUUM não roda dentro de uma
-- transação. As mudanças são gravadas de verdade. No fim, o VACUUM FULL
-- devolve a tabela ao tamanho original, com exatamente os mesmos dados
-- (o md5 do passo 8 é o mesmo da validação do volume), e a extensão
-- pgstattuple é removida.

-- Preparação: reproduzir o estado do banco no momento do chamado, com o
-- job antigo (job.sql) já executado uma vez.
UPDATE pedidos AS p
SET valor_total = t.total
FROM (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM itens_pedido
    GROUP BY pedido_id
) AS t
WHERE t.pedido_id = p.id;

-- Passo 1: o tamanho da tabela.
SELECT
    pg_relation_size('pedidos') / 8192 AS paginas,
    pg_size_pretty(pg_relation_size('pedidos')) AS tabela,
    pg_size_pretty(pg_indexes_size('pedidos')) AS indices;

-- Passo 2: o que dentro da tabela ocupa espaço? A extensão pgstattuple lê
-- a tabela inteira e separa linhas vivas, linhas mortas e espaço livre.
-- Ela vem antes de qualquer outra leitura de pedidos: uma leitura comum já
-- "poda" as páginas, e as linhas mortas viram espaço livre.
CREATE EXTENSION IF NOT EXISTS pgstattuple;

SELECT tuple_count AS linhas_vivas, tuple_percent AS pct_vivas,
       dead_tuple_count AS linhas_mortas, dead_tuple_percent AS pct_mortas,
       free_percent AS pct_livre
FROM pgstattuple('pedidos');

-- Passo 3: o job precisava gravar alguma coisa? Quantos pedidos existem, e
-- quantos tinham o total diferente da soma dos itens?
SELECT count(*) AS pedidos FROM pedidos;

SELECT count(*) AS totais_errados
FROM pedidos AS p
JOIN (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM itens_pedido
    GROUP BY pedido_id
) AS t ON t.pedido_id = p.id
WHERE p.valor_total IS DISTINCT FROM t.total;

-- Passo 4: o VACUUM resolve? Ele remove as linhas mortas, mas o arquivo
-- continua do mesmo tamanho.
VACUUM pedidos;

SELECT pg_relation_size('pedidos') / 8192 AS paginas,
       pg_size_pretty(pg_relation_size('pedidos')) AS tabela;

SELECT tuple_percent AS pct_vivas, dead_tuple_percent AS pct_mortas, free_percent AS pct_livre
FROM pgstattuple('pedidos');

-- Passo 5: e na noite seguinte? O job antigo roda de novo, agora com o
-- espaço livre deixado pelo VACUUM.
UPDATE pedidos AS p
SET valor_total = t.total
FROM (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM itens_pedido
    GROUP BY pedido_id
) AS t
WHERE t.pedido_id = p.id;

SELECT pg_relation_size('pedidos') / 8192 AS paginas,
       pg_size_pretty(pg_relation_size('pedidos')) AS tabela;

-- Passo 6: a correção, parte 1 (job-corrigido.sql): o job só grava o que
-- mudou. Repare na quantidade de linhas atualizadas (UPDATE 0).
UPDATE pedidos AS p
SET valor_total = t.total
FROM (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM itens_pedido
    GROUP BY pedido_id
) AS t
WHERE t.pedido_id = p.id
  AND p.valor_total IS DISTINCT FROM t.total;

-- Passo 7: a correção, parte 2 (manutencao.sql): devolver o espaço.
VACUUM FULL pedidos;

SELECT
    pg_relation_size('pedidos') / 8192 AS paginas,
    pg_size_pretty(pg_relation_size('pedidos')) AS tabela,
    pg_size_pretty(pg_indexes_size('pedidos')) AS indices;

-- Passo 8: os dados são os mesmos? O md5 é o mesmo conferido na validação
-- do volume (5a4f5e437c3a2c0df4554f59cdbaf071).
SELECT md5(string_agg(t::text, '|' ORDER BY id)) AS md5 FROM pedidos AS t;

-- Arrumação: o VACUUM FULL não preenche o mapa de visibilidade (ver o
-- sql/03_vacuum.sql). Um VACUUM comum deixa a tabela como depois da carga.
VACUUM pedidos;
DROP EXTENSION pgstattuple;
