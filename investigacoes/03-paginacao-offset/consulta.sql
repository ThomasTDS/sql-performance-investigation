-- Listagem de pedidos do backoffice: mais recentes primeiro, 20 por página.
-- O id desempata pedidos com a mesma data_pedido, para a ordem ser estável.
-- Exemplo do chamado: página 20.025 (OFFSET = 20.024 páginas × 20 linhas).
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
ORDER BY data_pedido DESC, id DESC
LIMIT 20 OFFSET 400480;
