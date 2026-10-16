-- Correção, parte 2 de 2: paginação por chave (keyset), em vez de OFFSET.
--
-- Em vez de "pule as primeiras 400.480 linhas", a consulta pede "as 20
-- linhas que vêm logo depois da última linha da página anterior". A
-- aplicação guarda a data_pedido e o id da última linha exibida (o
-- "cursor") e os envia ao pedir a próxima página.
--
-- O cursor abaixo é a última linha da página 20.024 (pedido 320010, de
-- 04/12/2023 11:43:35), então esta consulta devolve a mesma página 20.025
-- que a consulta.sql.
--
-- O id no cursor é obrigatório: o pedido 35150, primeiro desta página, tem
-- a mesma data_pedido do 320010. Um cursor só com a data
-- (data_pedido < '2023-12-04 11:43:35') pularia o 35150.
--
-- A comparação de linha (data_pedido, id) < (..., ...) equivale a
-- data_pedido < '...' OR (data_pedido = '...' AND id < 320010), e é escrita
-- assim para que o PostgreSQL a use inteira como condição do índice.
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
WHERE (data_pedido, id) < ('2023-12-04 11:43:35', 320010)
ORDER BY data_pedido DESC, id DESC
LIMIT 20;
