-- Correção: índice na coluna da chave estrangeira itens_pedido.pedido_id.
--
-- Em produção, use CREATE INDEX CONCURRENTLY: ele não bloqueia as escritas
-- na tabela durante a criação (o CREATE INDEX comum bloqueia INSERT, UPDATE
-- e DELETE em itens_pedido até terminar). O CONCURRENTLY não pode rodar
-- dentro de uma transação, e a validação deste projeto aplica a correção
-- dentro de uma transação para desfazê-la depois; por isso, aqui está a
-- forma comum. O índice resultante é o mesmo.
CREATE INDEX idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);
