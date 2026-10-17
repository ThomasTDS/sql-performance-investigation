-- Cenário da investigação 05: a importação de janeiro de 2026.
--
-- Reproduz o que aconteceu antes do chamado: a carga mensal trouxe 40 mil
-- pedidos de janeiro de 2026, com itens e pagamentos, e ninguém rodou
-- ANALYZE depois. As estatísticas do planejador continuam as da carga
-- original, que termina em 31/12/2025.
--
-- Os dados seguem as mesmas regras do sql/02_volume.sql (total do pedido
-- igual à soma dos itens, preço do catálogo, pagamento coerente com o
-- status) e são reprodutíveis (setseed). Todos os pedidos são de clientes
-- já cadastrados, ou seja, a data do pedido é sempre posterior ao cadastro.
--
-- 40 mil linhas é menos que o gatilho do autovacuum para refazer as
-- estatísticas de pedidos: 50 + 10% de 500 mil = 50.050 linhas alteradas.

SELECT setseed(0.05);

CREATE TEMP TABLE tmp_pedidos AS
SELECT
    500000 + g AS id,
    CASE
        WHEN random() < 0.8 THEN 1 + floor(random() * 10000)::int
        ELSE 10001 + floor(random() * 40000)::int
    END AS cliente_id,
    CASE WHEN random() < 0.85 THEN 1 + floor(random() * 50)::int END AS vendedor_id,
    date_trunc('second', timestamp '2026-01-01' + random() * interval '31 days') AS data_pedido,
    -- Pedidos recentes: ainda não deu tempo de entregar a maioria.
    CASE
        WHEN status_sorteio < 0.30 THEN 'entregue'
        WHEN status_sorteio < 0.85 THEN 'confirmado'
        WHEN status_sorteio < 0.95 THEN 'pendente'
        ELSE 'cancelado'
    END AS status,
    1 + floor(random() * 5)::int AS qtd_itens
FROM (SELECT g, random() AS status_sorteio FROM generate_series(1, 40000) AS g) AS sorteio;

CREATE TEMP TABLE tmp_itens AS
SELECT
    pedido_id,
    produto_id,
    quantidade,
    round(5 + ((produto_id * 7919) % 199500) / 100.0, 2) AS preco_unitario
FROM (
    SELECT
        p.id AS pedido_id,
        CASE
            WHEN random() < 0.8 THEN 1 + floor(random() * 400)::int
            ELSE 401 + floor(random() * 1600)::int
        END AS produto_id,
        CASE
            WHEN quantidade_sorteio < 0.7 THEN 1
            WHEN quantidade_sorteio < 0.9 THEN 2
            ELSE 3
        END AS quantidade
    FROM (SELECT *, random() AS quantidade_sorteio FROM tmp_pedidos ORDER BY id) AS p
    CROSS JOIN LATERAL generate_series(1, p.qtd_itens) AS n
) AS sorteio_item;

INSERT INTO pedidos (id, cliente_id, vendedor_id, data_pedido, status, valor_total)
SELECT p.id, p.cliente_id, p.vendedor_id, p.data_pedido, p.status, t.total
FROM tmp_pedidos AS p
JOIN (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM tmp_itens
    GROUP BY pedido_id
) AS t ON t.pedido_id = p.id
ORDER BY p.id;

SELECT setval('pedidos_id_seq', (SELECT max(id) FROM pedidos));

INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario)
SELECT pedido_id, produto_id, quantidade, preco_unitario
FROM tmp_itens
ORDER BY pedido_id, produto_id, quantidade;

INSERT INTO pagamentos (pedido_id, valor, data_pagamento, status)
SELECT
    id,
    valor_total,
    CASE WHEN status <> 'pendente'
        THEN date_trunc('second', data_pedido + random() * interval '2 days')
    END,
    CASE status
        WHEN 'pendente' THEN 'pendente'
        WHEN 'cancelado' THEN 'estornado'
        ELSE 'aprovado'
    END
FROM (
    SELECT *, random() AS estorno_sorteio
    FROM (SELECT * FROM pedidos WHERE id > 500000 ORDER BY id) AS ordenados
) AS p
WHERE status <> 'cancelado' OR estorno_sorteio < 0.5
ORDER BY id;

DROP TABLE tmp_pedidos, tmp_itens;
