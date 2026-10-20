-- O índice que o time criou antes de abrir o chamado, na tentativa de
-- acelerar a busca por telefone. É um índice B-tree comum: ele atende
-- buscas pelo começo do texto (LIKE '(11) 9%'), mas não pelo meio ou pelo
-- fim (ver o README desta investigação).
CREATE INDEX idx_clientes_telefone ON clientes (telefone);
