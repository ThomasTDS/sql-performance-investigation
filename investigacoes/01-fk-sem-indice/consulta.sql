-- Consulta da tela "Detalhes do pedido": os itens de um pedido, com o nome
-- do produto e o subtotal de cada linha. É a consulta do chamado, com o
-- pedido 428117 como exemplo.
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
