-- A migração que causou o incidente: a correção da investigação 01 aplicada
-- em produção na forma comum, sem CONCURRENTLY. Enquanto o índice é
-- construído, ela segura um ShareLock em itens_pedido, que bloqueia
-- INSERT, UPDATE e DELETE na tabela (leituras continuam funcionando).
CREATE INDEX idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);
