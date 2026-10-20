-- Painel da operação "pedidos de hoje sem pagamento": os pedidos do dia
-- que ainda não têm nenhum registro em pagamentos, para o time conferir
-- falhas na integração com o meio de pagamento. "Hoje" é 31/12/2025, o
-- último dia do volume de dados.
SELECT p.id, p.cliente_id, p.status, p.valor_total
FROM pedidos p
WHERE p.data_pedido >= '2025-12-31'
  AND p.data_pedido < '2026-01-01'
  AND p.id NOT IN (SELECT pedido_id FROM pagamentos)
ORDER BY p.id;
