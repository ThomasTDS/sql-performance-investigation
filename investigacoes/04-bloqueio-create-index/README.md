# Investigação 04 — Bloqueio causado pelo CREATE INDEX

| | |
|---|---|
| **Sintoma** | Durante a aplicação de uma migração, a gravação de pedidos parou: as inserções em `itens_pedido` ficaram esperando até a migração terminar |
| **Causa raiz** | A migração criou um índice com `CREATE INDEX` comum. Ele segura um `ShareLock` na tabela, que bloqueia `INSERT`, `UPDATE` e `DELETE` enquanto o índice é construído |
| **Correção** | `CREATE INDEX CONCURRENTLY`: segura um `ShareUpdateExclusiveLock`, que não conflita com as escritas da aplicação |
| **Armadilhas da correção** | Não roda dentro de transação; espera as transações de escrita abertas antes de começar; se for cancelada, deixa um índice inválido para trás |
| **Status** | Diagnóstico concluído e comportamento verificado automaticamente com várias conexões simultâneas |

Arquivos desta investigação:

- [`migracao.sql`](migracao.sql): a migração que causou o incidente.
- [`migracao-corrigida.sql`](migracao-corrigida.sql): a migração corrigida.
- [`exploracao.sql`](exploracao.sql): as consultas de diagnóstico de bloqueio, para um terminal "observador".

> **Diferente das investigações 01 a 03:** aqui o problema não está no plano de uma consulta, e sim na **convivência entre sessões**. Por isso, não há `EXPLAIN`: a evidência vem de `pg_stat_activity`, `pg_locks` e `pg_stat_progress_create_index`, consultados enquanto outra sessão está bloqueada.

---

## 1. Sintoma relatado

> Incidente reportado pelo time de produto: "Durante a janela de manutenção, os pedidos pararam de ser gravados. A aplicação mostrava timeouts ao salvar os itens do pedido. Ao mesmo tempo, o time de dados estava aplicando a correção da investigação 01."

A migração aplicada ([`migracao.sql`](migracao.sql)) era exatamente a correção da [investigação 01](../01-fk-sem-indice/README.md), na forma comum:

```sql
CREATE INDEX idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);
```

Neste banco, com 1,5 milhão de itens, o índice fica pronto em menos de 1 segundo, e o bloqueio passaria despercebido. Numa tabela de produção dezenas de vezes maior, ou num servidor ocupado, a construção leva minutos, e as escritas ficam paradas por todo esse tempo. Para observar o bloqueio com calma, o roteiro abaixo mantém a transação da migração aberta, como se a construção ainda estivesse em andamento.

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | A aplicação ficou lenta por outro motivo (CPU, disco), e a coincidência com a migração é casual | Ver em `pg_stat_activity` se as sessões da aplicação estão trabalhando ou esperando |
| H2 | As escritas da aplicação estão esperando um bloqueio segurado pela migração | `wait_event_type`, `pg_blocking_pids()` e `pg_locks` |
| H3 | Se H2: as leituras também param | Fazer uma leitura em `itens_pedido` durante o bloqueio |

## 3. Investigação

O roteiro usa três terminais `psql` abertos lado a lado. Com o banco do Docker Compose no ar, abra cada um com:

```bash
docker compose exec postgres psql -U postgres -d performance_investigation
```

- **A (migração)**: roda a migração.
- **B (aplicação)**: faz o papel da aplicação, gravando um item de pedido. Cada escrita fica numa transação desfeita com `ROLLBACK`, para não alterar os dados.
- **C (observador)**: roda as consultas do [`exploracao.sql`](exploracao.sql).

As saídas abaixo vêm da execução desse roteiro neste banco (os números de processo, `pid`, mudam a cada execução). A sessão A era o processo 7016, e a B, o 29884.

### Passo 1: reproduzir o incidente

```sql
-- A: inicia a migração e não termina a transação ainda
BEGIN;
CREATE INDEX idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);

-- B: a aplicação tenta gravar um item. O comando fica parado, sem resposta.
BEGIN;
INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES (1, 1, 1, 84.19);
```

### Passo 2: o que cada sessão está fazendo? (terminal C)

```
  pid  |        state        | wait_event_type | wait_event | bloqueado_por | consulta
-------+---------------------+-----------------+------------+---------------+-------------------------------
  7016 | idle in transaction | Client          | ClientRead | {}            | CREATE INDEX idx_itens_pedido_...
 29884 | active              | Lock            | relation   | {7016}        | INSERT INTO itens_pedido ...
```

**Achado:** **H1 descartada, H2 confirmada.** A sessão da aplicação (29884) não está consumindo CPU nem lendo disco: ela está **parada esperando um bloqueio** (`wait_event_type = Lock`) sobre a tabela (`relation`), e `pg_blocking_pids()` aponta quem o segura, a sessão 7016, que é a da migração.

### Passo 3: que bloqueios existem em `itens_pedido`?

```
  pid  |       mode       | granted | consulta
-------+------------------+---------+-------------------------------
  7016 | ShareLock        | t       | CREATE INDEX idx_itens_pedido_...
 29884 | RowExclusiveLock | f       | INSERT INTO itens_pedido ...
```

O `CREATE INDEX` obteve um `ShareLock` (`granted = t`). O `INSERT` pediu um `RowExclusiveLock`, que é o bloqueio de qualquer escrita, e ainda não recebeu (`granted = f`): os dois modos são incompatíveis.

| Bloqueio pedido | Por quem | Conflita com `ShareLock`? | Conflita com `ShareUpdateExclusiveLock`? |
|---|---|---|---|
| `AccessShareLock` | `SELECT` | não | não |
| `RowExclusiveLock` | `INSERT`, `UPDATE`, `DELETE` | **sim** | não |
| `ShareUpdateExclusiveLock` | `CREATE INDEX CONCURRENTLY`, `VACUUM`, `ANALYZE` | sim | sim |

(Trecho da tabela de conflitos de bloqueio da documentação do PostgreSQL, em "Explicit Locking".)

### Passo 4: e as leituras?

Durante o bloqueio, um `SELECT count(*) FROM itens_pedido WHERE pedido_id = 1` em outra sessão respondeu normalmente (em 86 ms).

**Achado:** **H3 descartada.** O `ShareLock` só barra escritas. Por isso o incidente se manifestou como "não consigo salvar", e não como "o sistema todo parou".

Ao desfazer a migração (`ROLLBACK` em A), o `INSERT` de B foi concluído na hora: ele tinha ficado parado por cerca de 3 segundos, exatamente o tempo que a transação da migração ficou aberta.

## 4. Causa raiz

A migração usou `CREATE INDEX` sem `CONCURRENTLY`. Essa forma segura um `ShareLock` na tabela durante toda a construção do índice, e o `ShareLock` é incompatível com o `RowExclusiveLock` que qualquer `INSERT`, `UPDATE` ou `DELETE` precisa. Toda escrita em `itens_pedido` ficou na fila até a migração terminar.

## 5. Correção e verificação

[`migracao-corrigida.sql`](migracao-corrigida.sql):

```sql
CREATE INDEX CONCURRENTLY idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);
```

Com `CONCURRENTLY`, o PostgreSQL constrói o índice em etapas, sem impedir as escritas: ele segura um `ShareUpdateExclusiveLock`, que não conflita com o `RowExclusiveLock` (tabela acima). A construção leva mais tempo e lê a tabela mais de uma vez, mas a aplicação continua gravando.

### A armadilha: o `CONCURRENTLY` espera as transações abertas

Antes de construir, o `CONCURRENTLY` espera terminarem todas as transações que estão escrevendo na tabela. Para ver isso, o roteiro deixa uma escrita "esquecida" aberta em B:

```sql
-- B: uma transação de escrita que ficou aberta (por exemplo, uma tela parada no meio de um processo)
BEGIN;
INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES (1, 1, 1, 84.19);

-- A: a migração corrigida (fora de transação). Fica parada.
CREATE INDEX CONCURRENTLY idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);

-- C: a aplicação continua gravando normalmente (resposta em 3 ms)
BEGIN;
INSERT INTO itens_pedido (pedido_id, produto_id, quantidade, preco_unitario) VALUES (1, 1, 1, 84.19);
ROLLBACK;
```

O que o observador mostra nesse momento (trechos; a sessão com a escrita esquecida era o processo 19804, e a migração, o 7016):

```
-- pg_stat_activity: a migração espera a transação de B (virtualxid), e não a tabela
  pid  |        state        | wait_event_type | wait_event | bloqueado_por
-------+---------------------+-----------------+------------+---------------
 19804 | idle in transaction | Client          | ClientRead | {}
  7016 | active              | Lock            | virtualxid | {19804}

-- pg_stat_progress_create_index
  pid  |              phase               | lockers_total | lockers_done | current_locker_pid
-------+----------------------------------+---------------+--------------+--------------------
  7016 | waiting for writers before build |             1 |            0 |              19804

-- pg_index: durante a construção, o índice existe, mas ainda é inválido
          indice           |    tabela
---------------------------+--------------
 idx_itens_pedido_pedido_id | itens_pedido
```

A migração fica na fase `waiting for writers before build`, esperando a sessão 19804. Quando a transação esquecida terminou (`ROLLBACK`), a migração foi concluída, e o índice ficou válido.

Uma transação esquecida aberta (por exemplo, uma conexão de um *pool* com `BEGIN` sem `COMMIT`) **segura a migração indefinidamente**. Antes de rodar a migração, vale conferir em `pg_stat_activity` se há sessões `idle in transaction` antigas.

### Outras duas armadilhas

**Não pode rodar dentro de uma transação.** Com `BEGIN` antes, o PostgreSQL recusa:

```
ERROR:  CREATE INDEX CONCURRENTLY cannot run inside a transaction block
```

Isso inclui situações menos óbvias. Muitas ferramentas de migração abrem uma transação por migração, por padrão. E, ao enviar vários comandos numa única mensagem (por exemplo, `SET lock_timeout = '1s'; CREATE INDEX CONCURRENTLY ...` numa só chamada do driver), o PostgreSQL os executa numa transação implícita, com o mesmo erro.

**Se for cancelada, deixa um índice inválido.** Com um `lock_timeout` de 1 segundo e a transação esquecida aberta, a migração foi cancelada:

```
ERROR:  canceling statement due to lock timeout
```

O índice, porém, ficou no catálogo, marcado como inválido (`indisvalid = false`). Ele não é usado por nenhuma consulta, mas ocupa espaço e é atualizado a cada escrita. Uma nova tentativa falha com `relation "idx_itens_pedido_pedido_id" already exists`. É preciso removê-lo antes (`DROP INDEX`) e criar de novo. O passo 4 do [`exploracao.sql`](exploracao.sql) lista os índices inválidos.

### Bônus: a fila de bloqueios

Ao testar a validação com a migração **sem** `CONCURRENTLY` e uma escrita aberta, apareceu um efeito que costuma surpreender. A migração ainda **não tinha conseguido** o `ShareLock`, porque estava esperando a escrita aberta. Mesmo assim, a escrita seguinte da aplicação também ficou bloqueada.

O PostgreSQL atende os pedidos de bloqueio por ordem de chegada. Um pedido incompatível na frente da fila faz quem chega depois esperar, mesmo que fosse compatível com quem já segura o bloqueio. Ou seja, uma migração esperando atrás de uma transação longa **bloqueia tudo que vem depois dela**. Por isso, migrações em produção costumam definir um `lock_timeout` curto: se não conseguirem o bloqueio rápido, desistem e tentam de novo mais tarde, em vez de formar uma fila.

### Verificação automatizada

O `npm run validate` (e a CI) repete o roteiro com conexões simultâneas, usando `lock_timeout` para que nada fique travado. As conferências comparam resultados discretos, nunca tempos:

| Cenário | Conferência | Esperado |
|---|---|---|
| Migração comum (transação aberta) | bloqueio da migração em `itens_pedido` | `ShareLock` |
| | escrita da aplicação | bloqueada |
| | leitura da aplicação | passa |
| Migração corrigida, com uma escrita aberta | fase da construção | `waiting for writers before build` |
| | bloqueio da migração | `ShareUpdateExclusiveLock` |
| | escrita da aplicação | passa |
| | índice no fim | válido |
| Armadilhas | migração corrigida dentro de `BEGIN` | recusada |
| | migração corrigida com `lock_timeout` e escrita aberta | cancelada |
| | índice deixado pela migração cancelada | inválido |
| Limpeza | índices do schema base no fim | só os automáticos |

Trocando `CONCURRENTLY` pela forma comum em [`migracao-corrigida.sql`](migracao-corrigida.sql), 5 dessas conferências falham. Isso foi testado.

## 6. Recomendações

- **Toda criação de índice em tabela com escrita em produção usa `CONCURRENTLY`.** Vale também para `DROP INDEX CONCURRENTLY` e `REINDEX ... CONCURRENTLY`.
- **Configurar a ferramenta de migração** para rodar essas migrações fora de transação (a maioria tem uma opção para isso por migração).
- **Antes de rodar,** procurar sessões `idle in transaction` antigas em `pg_stat_activity`.
- **Definir `lock_timeout`** nas migrações (por exemplo, alguns segundos), para não formar fila de bloqueios atrás de uma transação longa. Se der timeout, tentar de novo mais tarde.
- **Depois de rodar,** conferir se o índice ficou válido (passo 4 do [`exploracao.sql`](exploracao.sql)) e, se não ficou, removê-lo com `DROP INDEX CONCURRENTLY` antes de tentar de novo.
