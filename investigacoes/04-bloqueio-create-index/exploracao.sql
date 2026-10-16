-- Investigação 04: bloqueio causado pelo CREATE INDEX.
-- Consultas de diagnóstico, para o terminal "observador" (C) do roteiro do
-- README, enquanto a migração (A) e a aplicação (B) rodam em outros
-- terminais. Todas são só leitura e podem ser executadas a qualquer
-- momento: sem nada acontecendo, simplesmente não devolvem linhas.

-- Passo 1: quem está esperando, esperando o quê e bloqueado por quem.
-- wait_event_type = 'Lock' indica uma sessão parada esperando um bloqueio;
-- pg_blocking_pids() diz quais sessões seguram esse bloqueio.
SELECT
    pid,
    state,
    wait_event_type,
    wait_event,
    pg_blocking_pids(pid) AS bloqueado_por,
    now() - query_start AS ha_quanto_tempo,
    left(query, 70) AS consulta
FROM pg_stat_activity
WHERE datname = current_database()
  AND pid <> pg_backend_pid()
  AND state <> 'idle'
ORDER BY query_start;

-- Passo 2: os bloqueios em itens_pedido, concedidos (granted = true) e
-- pedidos (granted = false), com a consulta de cada sessão.
SELECT
    l.pid,
    l.mode,
    l.granted,
    left(a.query, 70) AS consulta
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'itens_pedido'::regclass
ORDER BY l.granted DESC, l.pid;

-- Passo 3: o andamento de uma criação de índice. Com CONCURRENTLY, a fase
-- "waiting for writers before build" indica que ela está esperando
-- transações que escrevem na tabela; current_locker_pid é a que está
-- segurando agora.
SELECT
    pid,
    phase,
    lockers_total,
    lockers_done,
    current_locker_pid,
    blocks_total,
    blocks_done
FROM pg_stat_progress_create_index;

-- Passo 4: índices inválidos, deixados por um CREATE INDEX CONCURRENTLY que
-- falhou ou foi cancelado. Ocupam espaço, são atualizados a cada escrita e
-- não são usados por nenhuma consulta.
SELECT
    indexrelid::regclass AS indice,
    indrelid::regclass AS tabela
FROM pg_index
WHERE NOT indisvalid;
