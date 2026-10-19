-- O índice que o time criou antes de abrir o chamado, seguindo a
-- recomendação da investigação 01 ("avaliar pagamentos.pedido_id"). Ele
-- existe e é válido, mas o NOT IN não consegue usá-lo (ver o README desta
-- investigação).
CREATE INDEX idx_pagamentos_pedido_id ON pagamentos (pedido_id);
