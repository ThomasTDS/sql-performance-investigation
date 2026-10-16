-- O índice que o time criou antes de abrir o chamado, com as mesmas colunas
-- da ordenação da listagem. As primeiras páginas ficaram instantâneas, mas
-- as últimas continuaram lentas (ver o README desta investigação).
CREATE INDEX idx_pedidos_data_id ON pedidos (data_pedido, id);
