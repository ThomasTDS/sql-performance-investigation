-- Job noturno "recalcular totais", como estava em produção: recalcula o
-- valor_total de todos os pedidos a partir dos itens, para corrigir
-- qualquer pedido cujo total tenha ficado diferente da soma dos itens.
--
-- O problema: ele grava as 500 mil linhas toda noite, mesmo quando o total
-- já está certo (e, com estes dados, está certo em todos os pedidos).
UPDATE pedidos AS p
SET valor_total = t.total
FROM (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM itens_pedido
    GROUP BY pedido_id
) AS t
WHERE t.pedido_id = p.id;
