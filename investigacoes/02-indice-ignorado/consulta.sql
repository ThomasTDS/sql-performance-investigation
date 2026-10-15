-- Busca de cliente por email, usada no login e na tela de atendimento. A
-- aplicação aplica lower() dos dois lados para que a busca não diferencie
-- maiúsculas de minúsculas. O email do exemplo foi digitado com maiúsculas.
SELECT id, nome, email, status
FROM clientes
WHERE lower(email) = lower('Cliente04217@Exemplo.com');
