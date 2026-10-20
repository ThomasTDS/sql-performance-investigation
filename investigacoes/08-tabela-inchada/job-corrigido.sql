-- Correção, parte 1 de 2: o job só grava os pedidos cujo total realmente
-- mudou. IS DISTINCT FROM (e não <>) para que um total nulo também conte
-- como diferente.
--
-- Com estes dados, nenhum total está errado, e o job passa a atualizar 0
-- linhas, sem criar nenhuma versão nova.
UPDATE pedidos AS p
SET valor_total = t.total
FROM (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM itens_pedido
    GROUP BY pedido_id
) AS t
WHERE t.pedido_id = p.id
  AND p.valor_total IS DISTINCT FROM t.total;
