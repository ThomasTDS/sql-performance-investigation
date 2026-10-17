-- Relatório "vendas por equipe", usado pelo time comercial no fechamento
-- do mês: pedidos e valor vendido por equipe de vendedores em janeiro de
-- 2026, sem os pedidos cancelados. Roda depois da importação do mês
-- (cenario.sql).
SELECT v.equipe, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN vendedores v ON v.id = p.vendedor_id
WHERE p.data_pedido >= '2026-01-01'
  AND p.data_pedido < '2026-02-01'
  AND p.status <> 'cancelado'
GROUP BY v.equipe
ORDER BY total DESC;
