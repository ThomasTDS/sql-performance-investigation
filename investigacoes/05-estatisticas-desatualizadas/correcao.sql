-- Correção: atualizar as estatísticas de pedidos depois da importação.
--
-- O ANALYZE lê uma amostra da tabela (30 mil linhas, com o
-- default_statistics_target padrão) e não bloqueia leituras nem escritas.
-- Em produção, o lugar dele é o fim do próprio processo de importação (ver
-- as recomendações do relatório).
ANALYZE pedidos;
