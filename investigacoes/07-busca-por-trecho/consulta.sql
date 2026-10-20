-- Busca de cliente pelo final do telefone, usada no atendimento: o cliente
-- liga e informa só os últimos dígitos. O atendente digita "4217", e a tela
-- procura qualquer telefone que termine com "-4217".
SELECT id, nome, email, telefone
FROM clientes
WHERE telefone LIKE '%-4217'
ORDER BY id;
