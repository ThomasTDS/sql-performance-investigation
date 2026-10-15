-- Gera o volume de dados das investigações: 50 vendedores, 2 mil produtos,
-- 50 mil clientes, 500 mil pedidos, cerca de 1,5 milhão de itens e cerca
-- de 490 mil pagamentos.
--
-- Os dados estão CORRETOS (neste projeto o problema é a consulta lenta, não
-- o dado errado): datas em ordem (cadastro → pedido → pagamento), total do
-- pedido igual à soma dos itens, preço do item igual ao do catálogo e
-- pagamento coerente com o status do pedido.
--
-- Reprodutível: setseed fixa a sequência do random(), e cada INSERT lê as
-- linhas numa ordem determinística. Rodar este script de novo, em qualquer
-- máquina com PostgreSQL 16, gera exatamente os mesmos dados. As datas
-- usam um período fixo (2023 a 2025), nunca now().
--
-- Distribuição propositalmente desigual, como num sistema real:
--   - 80% dos pedidos vêm de 20% dos clientes (ids 1 a 10.000, os mais
--     antigos) e 80% dos itens são de 20% dos produtos (ids 1 a 400);
--   - status dos pedidos: 80% entregue, 10% confirmado, 5% pendente e
--     5% cancelado;
--   - os clientes se cadastram ao longo do tempo, então o número de pedidos
--     por mês cresce de 2023 a 2025.

SELECT setseed(0.42);

-- Vendedores: 5 equipes.
INSERT INTO vendedores (nome, email, equipe)
SELECT
    'Vendedor ' || lpad(v::text, 2, '0'),
    'vendedor' || lpad(v::text, 2, '0') || '@empresa.exemplo',
    (ARRAY['Norte', 'Sul', 'Leste', 'Oeste', 'Centro'])[1 + (v - 1) % 5]
FROM generate_series(1, 50) AS v;

-- Produtos: 10 categorias. O preço é uma fórmula do id (entre 5,00 e
-- 2.000,00), e não random(), para que os itens possam calcular o mesmo
-- preço sem consultar o catálogo.
INSERT INTO produtos (nome, preco, categoria)
SELECT
    'Produto ' || lpad(p::text, 4, '0'),
    round(5 + ((p * 7919) % 199500) / 100.0, 2),
    (ARRAY['Eletrônicos', 'Informática', 'Casa', 'Escritório', 'Esporte',
           'Livros', 'Brinquedos', 'Beleza', 'Ferramentas', 'Alimentos'])[1 + (p - 1) % 10]
FROM generate_series(1, 2000) AS p;

-- Clientes: um cadastro a cada 26 minutos a partir de 01/01/2023, ou seja,
-- o último se cadastra em junho de 2025. A mesma fórmula da data de
-- cadastro é usada nos pedidos, para garantir pedido depois do cadastro.
INSERT INTO clientes (nome, email, documento, telefone, data_cadastro, status)
SELECT
    'Cliente ' || lpad(c::text, 5, '0'),
    'cliente' || lpad(c::text, 5, '0') || '@exemplo.com',
    lpad(c::text, 11, '0'),
    CASE WHEN random() < 0.9 THEN '(11) 9' || lpad(c::text, 4, '0') || '-' || lpad((c % 10000)::text, 4, '0') END,
    timestamp '2023-01-01 08:00' + (c - 1) * interval '26 minutes',
    CASE WHEN random() < 0.9 THEN 'ativo' ELSE 'inativo' END
FROM generate_series(1, 50000) AS c;

-- Pedidos: primeiro numa tabela temporária, porque o valor_total depende
-- dos itens, que ainda vão ser sorteados. Assim cada pedido é inserido uma
-- única vez, já com o total certo (um UPDATE de 500 mil linhas depois
-- deixaria a tabela com metade das páginas ocupadas por versões mortas, e
-- isso distorceria os planos).
CREATE TEMP TABLE tmp_pedidos AS
SELECT
    g AS id,
    cliente_id,
    CASE WHEN random() < 0.85 THEN 1 + floor(random() * 50)::int END AS vendedor_id,
    -- Data uniforme entre o cadastro do cliente e o fim de 2025.
    date_trunc('second',
        cadastro + random() * (timestamp '2025-12-31 23:59:59' - cadastro)) AS data_pedido,
    CASE
        WHEN status_sorteio < 0.80 THEN 'entregue'
        WHEN status_sorteio < 0.90 THEN 'confirmado'
        WHEN status_sorteio < 0.95 THEN 'pendente'
        ELSE 'cancelado'
    END AS status,
    1 + floor(random() * 5)::int AS qtd_itens
FROM (
    SELECT
        g,
        cliente_id,
        timestamp '2023-01-01 08:00' + (cliente_id - 1) * interval '26 minutes' AS cadastro,
        random() AS status_sorteio
    FROM (
        SELECT
            g,
            CASE
                WHEN random() < 0.8 THEN 1 + floor(random() * 10000)::int
                ELSE 10001 + floor(random() * 40000)::int
            END AS cliente_id
        FROM generate_series(1, 500000) AS g
    ) AS sorteio_cliente
) AS sorteio_status;

-- Itens: de 1 a 5 por pedido (média 3). Quantidade: 70% com 1 unidade, 20%
-- com 2 e 10% com 3. Preço unitário = preço do catálogo (mesma fórmula).
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
    FROM (SELECT *, random() AS quantidade_sorteio FROM tmp_pedidos) AS p
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

-- Os ids dos pedidos foram informados explicitamente: a sequência precisa
-- continuar de onde eles pararam.
SELECT setval('pedidos_id_seq', (SELECT max(id) FROM pedidos));

INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario)
SELECT pedido_id, produto_id, quantidade, preco_unitario
FROM tmp_itens
ORDER BY pedido_id, produto_id, quantidade;

-- Pagamentos, coerentes com o status do pedido:
--   - entregue/confirmado: 1 pagamento aprovado, até 2 dias após o pedido;
--   - pendente: 1 pagamento pendente, ainda sem data;
--   - cancelado: metade foi paga e estornada, metade nunca foi paga.
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
    FROM (SELECT * FROM pedidos ORDER BY id) AS ordenados
) AS p
WHERE status <> 'cancelado' OR estorno_sorteio < 0.5
ORDER BY id;

DROP TABLE tmp_pedidos, tmp_itens;

-- Estatísticas atualizadas para o planejador. Sem isso, os primeiros planos
-- dependeriam de quando o autovacuum resolvesse rodar.
ANALYZE;
