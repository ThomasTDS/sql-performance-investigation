-- Ranking das consultas pelo tempo total gasto no banco (pg_stat_statements).
--
-- É o ponto de partida de uma triagem: total_exec_time = execuções × tempo
-- médio. Uma consulta de 30 ms executada milhares de vezes pesa mais que
-- uma de 1 s executada uma vez por dia. As colunas de blocos mostram quanto
-- cada consulta lê; ao contrário do tempo, esse número não depende da
-- máquina nem da carga do momento.
SELECT
    calls AS execucoes,
    round(total_exec_time::numeric, 1) AS tempo_total_ms,
    round(mean_exec_time::numeric, 3) AS tempo_medio_ms,
    shared_blks_hit + shared_blks_read AS blocos_lidos,
    (shared_blks_hit + shared_blks_read) / calls AS blocos_por_execucao,
    rows AS linhas_devolvidas,
    left(regexp_replace(query, '\s+', ' ', 'g'), 90) AS consulta
FROM pg_stat_statements
WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
  AND query NOT ILIKE '%pg_stat_statements%'
ORDER BY total_exec_time DESC
LIMIT 10;
