-- O índice que o time criou antes de abrir o chamado, na tentativa de
-- acelerar a busca por email. Ele existe e é válido, mas a consulta não
-- consegue usá-lo (ver o README desta investigação).
CREATE INDEX idx_clientes_email ON clientes (email);
