# Investigação 05 — Estatísticas desatualizadas depois de uma importação

| | |
|---|---|
| **Sintoma** | O relatório de vendas por equipe de janeiro, rodado logo depois da importação do mês, leva quase 1 segundo. O de dezembro leva cerca de 70 ms |
| **Causa raiz** | A importação trouxe 40 mil pedidos de janeiro de 2026, mas as estatísticas do planejador ainda são as da carga anterior, que termina em 31/12/2025. O planejador estima **1** pedido de janeiro (são 38.003) e escolhe um `Nested Loop` que percorre a tabela `vendedores` uma vez para cada pedido. O autovacuum não atualizou as estatísticas porque 40 mil linhas ficam abaixo do gatilho dele para esta tabela (50.050) |
| **Correção** | `ANALYZE pedidos` e, para não voltar a acontecer, `ANALYZE` no fim do processo de importação |
| **Resultado** | De cerca de 960 ms para cerca de 67 ms (cerca de 14 vezes mais rápido), lendo 4.607 páginas em vez de 42.563, com o mesmo resultado |
| **Efeito colateral positivo** | Os outros relatórios do mês, que tinham a mesma estimativa errada, ficam cerca de 2,5 vezes mais rápidos |
| **Status** | Diagnóstico concluído, com correção verificada numa transação desfeita em seguida (`ROLLBACK`) |

Arquivos desta investigação:

- [`cenario.sql`](cenario.sql): a importação de janeiro de 2026, que reproduz o estado do banco no momento do chamado.
- [`consulta.sql`](consulta.sql): o relatório do chamado, exatamente como o time comercial o executa.
- [`exploracao.sql`](exploracao.sql): as queries na ordem em que foram usadas, numeradas conforme os passos abaixo. Ele inclui o `cenario.sql` no começo.
- [`correcao.sql`](correcao.sql): a correção proposta.

> **Sobre os tempos:** foram medidos num notebook com Windows e variam de máquina para máquina e entre execuções. O que não varia, e é o que a CI confere, é **o formato do plano** (o tipo de join), **se a estimativa de linhas está certa ou errada** e **o resultado** da consulta. Medições padronizadas de todos os cenários, com data e ambiente, ficam em [`MEDICOES.md`](../MEDICOES.md) (`npm run medir`).

---

## 1. Sintoma relatado

> Chamado do time comercial: "O relatório de vendas por equipe de janeiro está demorando quase 1 segundo. O de dezembro abre na hora. Ele foi rodado logo depois da importação dos pedidos de janeiro."

Este relatório não aparece na [triagem](../00-triagem/README.md): ela roda sobre o volume base, que termina em 2025, antes da importação. Em produção, a `pg_stat_statements` registraria a consulta depois da primeira execução lenta.

A consulta ([`consulta.sql`](consulta.sql)) soma os pedidos de janeiro por equipe de vendedores:

```sql
SELECT v.equipe, count(*) AS pedidos, sum(p.valor_total) AS total
FROM pedidos p
JOIN vendedores v ON v.id = p.vendedor_id
WHERE p.data_pedido >= '2026-01-01'
  AND p.data_pedido < '2026-02-01'
  AND p.status <> 'cancelado'
GROUP BY v.equipe
ORDER BY total DESC;
```

| equipe | pedidos | total |
|---|---:|---:|
| Oeste | 6417 | 27107930.40 |
| Leste | 6538 | 27080262.58 |
| Centro | 6550 | 26876432.38 |
| Sul | 6397 | 26612258.72 |
| Norte | 6393 | 26527213.40 |

São 5 linhas, que somam 32.295 pedidos (os pedidos sem vendedor ficam de fora do join).

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | Janeiro tem mais pedidos que dezembro, e o relatório só ficou proporcionalmente mais lento | Comparar o plano e o tempo dos dois meses |
| H2 | O plano de janeiro é diferente do de dezembro | Ler os dois planos (`EXPLAIN ANALYZE`) |
| H3 | Se H2: o planejador estimou mal as linhas de janeiro, porque as estatísticas não conhecem os dados importados | Comparar as linhas estimadas com as reais e consultar as estatísticas (`pg_stats`) |
| H4 | Se H3: o autovacuum, que deveria atualizar as estatísticas, não rodou | Calcular o gatilho do autovacuum para a tabela |

## 3. Investigação

O banco foi colocado no estado do chamado com o [`cenario.sql`](cenario.sql): 40 mil pedidos de janeiro de 2026, com itens e pagamentos, seguindo as mesmas regras do volume base, e **sem `ANALYZE` depois**.

### Passo 1: o plano de janeiro e o de dezembro

O plano real do relatório de janeiro (passo 1a do [`exploracao.sql`](exploracao.sql)):

```
Sort  (rows=1) (actual time=959.211..959.384 rows=5 loops=1)
  ->  GroupAggregate  (rows=1) (actual rows=5 loops=1)
        ->  Sort  (rows=1) (actual rows=32295 loops=1)
              ->  Nested Loop  (rows=1) (actual time=72.069..898.989 rows=32295 loops=1)
                    Join Filter: (v.id = p.vendedor_id)
                    Rows Removed by Join Filter: 1074034
                    ->  Gather  (rows=1) (actual time=72.019..89.107 rows=38003 loops=1)
                          ->  Parallel Seq Scan on pedidos p  (cost=0.00..8511.75 rows=1) (actual rows=12668 loops=3)
                                Rows Removed by Filter: 167332
                                Buffers: shared hit=4560
                    ->  Seq Scan on vendedores v  (rows=50) (actual rows=29 loops=38003)
                          Buffers: shared hit=38003
Execution Time: 960.616 ms
```

Como ler:

- **`rows=1` contra `actual ... rows=38003`** no `Gather`: o planejador esperava **1** pedido de janeiro. Vieram 38.003.
- **`Nested Loop`** com **`Seq Scan on vendedores ... loops=38003`**: para cada pedido, a tabela de vendedores é percorrida do início, até achar o vendedor do pedido. São 38.003 leituras da mesma tabela de 50 linhas, e **1.074.034 comparações descartadas** (`Rows Removed by Join Filter`).
- **A leitura de `pedidos` não é o problema:** ela leva cerca de 90 ms (o `Gather` termina em 89 ms). Os outros 870 ms estão no `Nested Loop`.

Para 1 pedido, o `Nested Loop` é a escolha certa: ler 50 vendedores uma vez é mais barato que montar uma tabela *hash* com eles. Para 38 mil pedidos, é a pior escolha possível.

O mesmo relatório para dezembro de 2025 (passo 1b):

```
->  Hash Join  (rows=8387) (actual time=0.102..25.100 rows=5157 loops=3)
      ->  Parallel Seq Scan on pedidos p  (rows=8387) (actual rows=6037 loops=3)
      ->  Hash
            ->  Seq Scan on vendedores v  (rows=50) (actual rows=50 loops=3)
Execution Time: 67.441 ms
```

| | Dezembro de 2025 | Janeiro de 2026 |
|---|---:|---:|
| Pedidos no relatório | 15.471 | 32.295 |
| Linhas de `pedidos` estimadas → reais (por processo) | 8.387 → 6.037 | 1 → 12.668 |
| Join | `Hash Join` | `Nested Loop` |
| Leituras de `vendedores` | 3 (uma por processo) | 38.003 |
| Tempo de execução | ~67 ms | ~960 ms |

**Achado:** **H1 descartada** e **H2 confirmada.** Janeiro tem cerca de 2 vezes mais pedidos, mas leva 14 vezes mais tempo. O plano é outro: em dezembro, a estimativa é razoável e o planejador usa um `Hash Join`, que lê os vendedores uma vez.

### Passo 2: o que o planejador sabe sobre `data_pedido`

As estatísticas de uma coluna guardam, entre outras coisas, um histograma: os valores divididos em 100 faixas com a mesma quantidade de linhas. A última fronteira é o maior valor que o planejador conhece:

| maior_data_nas_estatisticas | maior_data_real |
|---|---|
| 2025-12-31 23:23:00 | 2026-01-31 23:59:58 |

| pedidos_de_janeiro |
|---:|
| 40000 |

Para o planejador, não existe nenhum pedido depois de 31/12/2025. Uma condição como `data_pedido >= '2026-01-01'` cai fora do histograma, e a estimativa vai para o mínimo, 1 linha. Os 40 mil pedidos de janeiro existem na tabela, mas não existem nas estatísticas.

> A última fronteira do histograma muda um pouco a cada `ANALYZE`, porque ele lê uma amostra aleatória (em outra rodada, saiu 23:57:19). O que importa é que ela fica em dezembro de 2025.

**Achado:** **H3 confirmada.** As estatísticas são de antes da importação.

### Passo 3: por que o autovacuum não atualizou as estatísticas?

O autovacuum refaz o `ANALYZE` de uma tabela quando as linhas alteradas desde o último passam de `autovacuum_analyze_threshold` (50) + `autovacuum_analyze_scale_factor` (10%) × linhas da tabela:

| linhas_nas_estatisticas | gatilho_do_autovacuum | linhas_importadas |
|---:|---:|---:|
| 500000 | 50050 | 40000 |

**Achado:** **H4 confirmada, mas o autovacuum não falhou.** Ele está funcionando como configurado: com 500 mil linhas, só refaria as estatísticas depois de 50.050 linhas alteradas. A importação trouxe 40 mil. Até o mês seguinte, as estatísticas continuariam sem nenhum pedido de janeiro.

O gatilho em porcentagem é razoável para alterações espalhadas ao longo do tempo, mas não para uma carga concentrada num período novo: 8% de linhas novas é pouco para a tabela, e é 100% do mês que os relatórios consultam.

### Passo 4: outros relatórios do mês

A estimativa errada não é exclusiva deste relatório: toda consulta que filtra janeiro de 2026 parte de 1 linha estimada. Dois outros relatórios do mês (passo 4 do [`exploracao.sql`](exploracao.sql)), antes e depois da correção do passo 6:

| Relatório | Plano antes | Antes | Depois |
|---|---|---:|---:|
| 4a. Os 10 maiores clientes de janeiro | `Nested Loop` com 38.003 buscas na chave primária de `clientes` (118.569 páginas) | ~362 ms | ~143 ms, com `Hash Join` (6.769 páginas) |
| 4b. Resumo de janeiro por status (sem join) | agregação num único processo, depois do `Gather` | ~110 ms | ~46 ms, com agregação parcial em paralelo |

**Achado:** a mesma causa afeta todos os relatórios do mês, com gravidade diferente conforme o plano. O pior caso é o do chamado: um join com uma tabela pequena **sem índice útil** na coluna do join faz o `Nested Loop` percorrer a tabela inteira a cada linha. No relatório 4a, o `Nested Loop` usa a chave primária de `clientes`, e o estrago é menor.

### Passo 5: e se o time criasse um índice em `data_pedido`?

Um índice parece a resposta natural para "relatório por período lento". Dentro de um savepoint, desfeito em seguida:

```
Hash Join  (rows=4097) (actual time=5.473..27.193 rows=32295 loops=1)
  ->  Bitmap Heap Scan on pedidos p  (rows=4097) (actual rows=38003 loops=1)
        ->  Bitmap Index Scan on idx_pedidos_data_pedido  (rows=4313) (actual rows=40000 loops=1)
  ->  Hash
        ->  Seq Scan on vendedores v  (rows=50) (actual rows=50 loops=1)
Execution Time: 41.783 ms
```

O relatório fica rápido, mas **não pelo motivo que parece**. A estimativa passou de 1 para 4.097 linhas: quando uma condição cai depois do fim do histograma e existe um índice na coluna, o planejador consulta o índice para descobrir o maior valor real. A estimativa melhora, ainda que fique 9 vezes abaixo da real, e isso basta para o `Hash Join` ficar mais barato que o `Nested Loop`. O índice também lê menos páginas (467 em vez de 4.560), mas a leitura de `pedidos` nunca foi o gargalo (passo 1).

**Achado:** o índice resolveria o sintoma deste relatório sem corrigir a causa. As estatísticas continuariam sem janeiro, a estimativa continuaria errada (4.097 contra 38.003) e qualquer consulta que dependa de outra coluna dos pedidos importados (status, cliente, vendedor) continuaria com estimativas antigas. Ele é uma otimização à parte, para avaliar com seus próprios custos (seção 6).

## 4. Causa raiz

A importação de janeiro trouxe 40 mil pedidos num período que as estatísticas do planejador não conhecem, e ninguém atualizou as estatísticas depois dela. O autovacuum também não atualizou, porque a carga ficou abaixo do gatilho dele (50.050 linhas para uma tabela de 500 mil). Com o histograma terminando em 31/12/2025, o planejador estima 1 pedido para qualquer período de janeiro e escolhe um `Nested Loop`, ótimo para 1 linha e péssimo para 38 mil: a tabela de vendedores é percorrida 38.003 vezes.

## 5. Correção e verificação

[`correcao.sql`](correcao.sql):

```sql
ANALYZE pedidos;
```

O `ANALYZE` lê só uma amostra (30 mil linhas, com a configuração padrão), e não a tabela inteira, e não bloqueia leituras nem escritas.

Plano depois da correção (passo 6 do [`exploracao.sql`](exploracao.sql)):

```
Finalize GroupAggregate  (rows=5) (actual rows=5 loops=1)
  ->  Gather Merge  (actual rows=15 loops=1)
        ->  Partial HashAggregate  (rows=5) (actual rows=5 loops=3)
              ->  Hash Join  (rows=15701) (actual time=23.364..26.387 rows=10765 loops=3)
                    ->  Parallel Seq Scan on pedidos p  (rows=15701) (actual rows=12668 loops=3)
                    ->  Hash
                          ->  Seq Scan on vendedores v  (rows=50) (actual rows=50 loops=3)
Execution Time: 66.968 ms
```

| | Antes | Depois |
|---|---|---|
| Linhas de `pedidos` estimadas → reais (por processo) | 1 → 12.668 | 15.701 → 12.668 |
| Join | `Nested Loop` | `Hash Join` |
| Leituras de `vendedores` | 38.003 | 3 (uma por processo) |
| Comparações descartadas no join | 1.074.034 | nenhuma (o `Hash Join` busca direto pela chave) |
| Páginas lidas (total da consulta) | 42.563 | 4.607 |
| Tempo de execução | ~960 ms | ~67 ms |
| Resultado | 5 linhas | as mesmas 5 linhas |

Depois do `ANALYZE`, a última fronteira do histograma passa a ser 31/01/2026, e o relatório de janeiro volta a ter o mesmo plano e praticamente o mesmo tempo do de dezembro.

### Verificação automatizada

O `npm run validate` (e a CI) repete esta verificação a cada execução, numa transação desfeita no fim:

1. aplica o [`cenario.sql`](cenario.sql) (a importação, sem `ANALYZE`);
2. confere que, sem a correção, os pedidos são lidos com `Seq Scan`, que o join que os recebe é um `Nested Loop` e que a estimativa de linhas está **errada** (mais de 10 vezes de diferença para as linhas reais);
3. aplica o [`correcao.sql`](correcao.sql);
4. confere que o join passa a ser um `Hash Join` e que a estimativa fica **certa** (até 10 vezes de diferença; o `ANALYZE` lê uma amostra aleatória, e a estimativa varia um pouco a cada execução);
5. confere que o relatório devolve **exatamente o mesmo resultado** antes e depois (quantidade de linhas e `md5` do conteúdo).

## 6. Recomendações

- **Aplicar a correção agora:** `ANALYZE pedidos` (e também `ANALYZE itens_pedido` e `ANALYZE pagamentos`, que receberam as linhas da mesma importação).
- **Prevenção: `ANALYZE` no fim do processo de importação**, nas tabelas que ele alimenta. É a solução direta: a carga é previsível, e as estatísticas ficam certas antes do primeiro relatório.
- **Alternativa: um gatilho do autovacuum próprio para `pedidos`**, por exemplo `ALTER TABLE pedidos SET (autovacuum_analyze_scale_factor = 0.02)` (cerca de 10 mil linhas). Ajuda mesmo que alguém esqueça o `ANALYZE`, mas o autovacuum roda quando chega a vez dele, e o primeiro relatório depois da carga ainda pode pegar as estatísticas antigas.
- **Avaliar o índice em `data_pedido` separadamente** (passo 5). Os relatórios por período leriam menos páginas, mas cada importação passaria a atualizar também o índice, e ele não substitui o `ANALYZE`. Se for criado, que seja com `CONCURRENTLY` (ver a [investigação 04](../04-bloqueio-create-index/README.md)).
- **Monitoramento:** comparar as linhas estimadas com as reais (`EXPLAIN ANALYZE`) em todo relatório que ficar lento de repente. Uma diferença de milhares de vezes, como a deste chamado, aponta para as estatísticas antes de qualquer outra coisa.
