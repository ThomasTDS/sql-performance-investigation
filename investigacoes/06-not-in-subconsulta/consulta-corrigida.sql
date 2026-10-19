-- O mesmo painel, com NOT EXISTS no lugar de NOT IN. O PostgreSQL
-- transforma o NOT EXISTS num anti-join (devolve os pedidos que não têm par
-- em pagamentos), em vez de procurar cada pedido numa lista.
--
-- Devolve exatamente o mesmo resultado que o NOT IN só porque
-- pagamentos.pedido_id é NOT NULL. Com valores nulos na subconsulta, o
-- NOT IN não devolveria nenhuma linha (ver o passo 5 do README).
SELECT p.id, p.cliente_id, p.status, p.valor_total
FROM pedidos p
WHERE p.data_pedido >= '2025-12-31'
  AND p.data_pedido < '2026-01-01'
  AND NOT EXISTS (SELECT 1 FROM pagamentos pg WHERE pg.pedido_id = p.id)
ORDER BY p.id;
