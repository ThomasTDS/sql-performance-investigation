# Investigação 06 — NOT IN com subconsulta

| | |
|---|---|
| **Sintoma** | O painel "pedidos de hoje sem pagamento" leva quase 10 segundos para devolver 20 pedidos, mesmo depois de o time criar um índice em `pagamentos.pedido_id` |
| **Causa raiz** | O painel usa `NOT IN (SELECT pedido_id FROM pagamentos)`. O PostgreSQL não transforma esse `NOT IN` num join, e a lista de 487 mil pagamentos não cabe na memória reservada para guardá-la numa tabela *hash*. Por isso, para cada um dos 576 pedidos do dia, ele percorre a lista do início até achar o pedido: são, em média, 250 mil linhas por pedido. O índice não ajuda, porque o `NOT IN` não consegue usá-lo |
| **Correção** | Reescrever com `NOT EXISTS`, que o PostgreSQL transforma num *anti-join*. A reescrita devolve o mesmo resultado só porque `pagamentos.pedido_id` é `NOT NULL` |
| **Resultado** | De cerca de 9,7 s para cerca de 80 ms (mais de 100 vezes mais rápido), lendo 8.431 páginas em vez de 1,2 milhão, com o mesmo resultado |
| **Achado extra** | Em colunas que aceitam nulos, `NOT IN` e `NOT EXISTS` **não são equivalentes**: numa pergunta parecida sobre vendedores, o `NOT IN` devolve 0 linhas e o `NOT EXISTS`, 8 |
| **Status** | Diagnóstico concluído, com correção verificada numa transação desfeita em seguida (`ROLLBACK`) |

Arquivos desta investigação:

- [`consulta.sql`](consulta.sql): o painel do chamado, exatamente como a tela o executa.
- [`tentativa.sql`](tentativa.sql): o índice que o time criou antes de abrir o chamado.
- [`exploracao.sql`](exploracao.sql): as queries na ordem em que foram usadas, numeradas conforme os passos abaixo. As consultas com `NOT IN` levam cerca de 10 segundos cada.
- [`consulta-corrigida.sql`](consulta-corrigida.sql): o painel reescrito com `NOT EXISTS`.
- [`correcao.sql`](correcao.sql): vazio de propósito (só comentários). A correção não muda o banco: é a reescrita da consulta.

> **Sobre os tempos:** foram medidos num notebook com Windows e variam de máquina para máquina e entre execuções. O que não varia, e é o que a CI confere, é **o formato do plano** (a subconsulta antes, o *anti-join* depois) e **o resultado** do painel. Medições padronizadas de todos os cenários, com data e ambiente, ficam em [`MEDICOES.md`](../MEDICOES.md) (`npm run medir`).

---

## 1. Sintoma relatado

> Chamado do time de operação: "O painel de pedidos de hoje sem pagamento demora quase 10 segundos para abrir. Seguimos a recomendação da investigação 01 e criamos um índice em `pagamentos.pedido_id`, mas não mudou nada."

O painel mostra os pedidos do dia que ainda não têm nenhum registro em `pagamentos`, para o time conferir falhas na integração com o meio de pagamento. A consulta ([`consulta.sql`](consulta.sql)):

```sql
SELECT p.id, p.cliente_id, p.status, p.valor_total
FROM pedidos p
WHERE p.data_pedido >= '2025-12-31'
  AND p.data_pedido < '2026-01-01'
  AND p.id NOT IN (SELECT pedido_id FROM pagamentos)
ORDER BY p.id;
```

Ela devolve 20 pedidos, todos cancelados. É o esperado: metade dos pedidos cancelados nunca foi paga, e todos os outros têm um registro de pagamento (aprovado, pendente ou estornado).

| id | cliente_id | status | valor_total |
|---:|---:|---|---:|
| 16960 | 2635 | cancelado | 3766.00 |
| 46618 | 9433 | cancelado | 455.52 |
| ... | | | |
| 485959 | 15682 | cancelado | 1140.42 |

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | O índice criado pelo time está inválido ou não terminou de ser criado | Consultar o catálogo (`pg_index.indisvalid`) |
| H2 | O índice é válido, mas o plano não o usa | Ler o plano de execução real (`EXPLAIN ANALYZE`) |
| H3 | Se H2: a forma da consulta (`NOT IN`) impede um plano melhor | Comparar com uma consulta equivalente escrita de outra forma |
| H4 | Falta memória para a consulta (`work_mem`) | Repetir a consulta com mais memória |

## 3. Investigação

O banco foi colocado no estado do chamado com o índice da tentativa ([`tentativa.sql`](tentativa.sql)).

### Passo 1: o plano real do painel

```
Gather Merge  (cost=1000.45..1509816363.42 rows=277) (actual time=9720.489..9730.227 rows=20 loops=1)
  Buffers: shared hit=1201221, temp read=58 written=834
  ->  Parallel Index Scan using pedidos_pkey on pedidos p  (actual rows=7 loops=3)
        Filter: ((data_pedido >= '2025-12-31') AND (data_pedido < '2026-01-01') AND (NOT (SubPlan 1)))
        Rows Removed by Filter: 166660
        SubPlan 1
          ->  Materialize  (rows=487490) (actual time=0.034..24.935 rows=249502 loops=576)
                ->  Seq Scan on pagamentos  (rows=487490) (actual rows=256801 loops=559)
                      Buffers: shared hit=1195202
Execution Time: 9734.006 ms
```

Como ler:

- **`NOT (SubPlan 1)`** no filtro: a subconsulta não virou um join. Ela é avaliada como uma função, uma vez por pedido.
- **`Materialize ... loops=576`**: para cada um dos 576 pedidos do dia, o PostgreSQL percorre a lista de pagamentos guardada (*materializada*) até achar o pedido. Em média, foram **249.502 linhas por pedido**, ou seja, cerca de 144 milhões de comparações para devolver 20 linhas.
- **`Buffers: shared hit=1201221`**: 1,2 milhão de páginas lidas da memória. A tabela `pagamentos` tem pouco mais de 4 mil páginas: ela foi lida, na prática, centenas de vezes.
- **`cost=...1509816363`**: o próprio planejador estima um custo de 1,5 bilhão. Ele sabe que o plano é caro, mas não tem outro para esta forma de consulta (passo 3).
- **O índice `idx_pagamentos_pedido_id` não aparece no plano.**

**Achado:** **H2 confirmada.** O tempo inteiro está na subconsulta, e o índice não é usado.

### Passo 2: o índice existe e é válido?

| indice | valido | tamanho |
|---|---|---|
| pagamentos_pkey | true | 10 MB |
| idx_pagamentos_pedido_id | true | 10 MB |

**Achado:** **H1 descartada.** O índice está pronto. O problema não é o índice, e sim a consulta não conseguir usá-lo.

### Passo 3: por que o `NOT IN` não vira um join? E com mais memória?

O `NOT IN` tem uma regra que o `NOT EXISTS` não tem: se a subconsulta devolver **um único nulo**, `x NOT IN (...)` nunca é verdadeiro (o resultado é "desconhecido", e a linha não entra). Para respeitar essa regra, o PostgreSQL não transforma o `NOT IN` num *anti-join*. Sobram duas formas de executá-lo:

- **`hashed SubPlan`:** guarda a lista inteira numa tabela *hash* e consulta cada pedido nela. Só é escolhida se a tabela estimada couber na memória reservada para tabelas *hash* (por padrão, 8 MB: o `work_mem` de 4 MB vezes o `hash_mem_multiplier` de 2), porque ela não pode ser dividida em partes como a de um *hash join*;
- **`SubPlan` comum:** percorre a lista para cada pedido. É a do passo 1, porque os 487 mil pagamentos não cabem nesse limite.

Com `SET LOCAL work_mem = '64MB'` (só dentro da transação):

```
->  Parallel Seq Scan on pedidos p  (actual rows=7 loops=3)
      Filter: (... AND (NOT (hashed SubPlan 1)))
      SubPlan 1
        ->  Seq Scan on pagamentos  (rows=487490) (actual rows=487490 loops=3)
Execution Time: 184.696 ms
```

**Achado:** **H4 confirmada em parte.** Com mais memória, o plano muda para `hashed SubPlan` e o painel leva cerca de 185 ms. Mas essa não é uma boa correção: o painel voltaria a ficar lento no dia em que `pagamentos` crescer além dos 64 MB, e aumentar o `work_mem` do servidor inteiro multiplica o consumo de memória de todas as consultas. O problema continua sendo a forma da consulta.

### Passo 4: a reescrita com `NOT EXISTS`

[`consulta-corrigida.sql`](consulta-corrigida.sql) troca a condição por:

```sql
AND NOT EXISTS (SELECT 1 FROM pagamentos pg WHERE pg.pedido_id = p.id)
```

Sem o índice da tentativa (4b):

```
->  Parallel Hash Anti Join  (actual time=41.491..52.330 rows=7 loops=3)
      Hash Cond: (p.id = pg.pedido_id)
      ->  Parallel Seq Scan on pedidos p  (actual rows=192 loops=3)
      ->  Parallel Hash
            ->  Parallel Seq Scan on pagamentos pg  (actual rows=162497 loops=3)
Execution Time: 80.237 ms
```

Com o índice da tentativa (4a):

```
->  Nested Loop Anti Join  (actual time=0.237..8.207 rows=7 loops=3)
      ->  Parallel Seq Scan on pedidos p  (actual rows=192 loops=3)
      ->  Index Only Scan using idx_pagamentos_pedido_id on pagamentos pg  (actual rows=1 loops=576)
Execution Time: 43.071 ms
```

O *anti-join* devolve os pedidos que **não** têm par em `pagamentos`. Sem índice, ele lê `pagamentos` uma única vez e monta uma tabela *hash* (que, num *hash join*, pode ser dividida em partes se não couber na memória). Com o índice, ele faz uma busca no índice para cada pedido do dia.

**Achado:** **H3 confirmada.** Com `NOT EXISTS`, o painel leva cerca de 80 ms sem índice e 43 ms com ele. O índice da tentativa finalmente é útil, mas só depois da reescrita.

### Passo 5: `NOT IN` e `NOT EXISTS` são sempre equivalentes?

Não. Uma pergunta parecida, sobre outra coluna: quais vendedores não venderam nada desde as 18h? A coluna `pedidos.vendedor_id` aceita nulos (pedidos feitos sem vendedor).

| com_not_in | com_not_exists | pedidos_sem_vendedor |
|---:|---:|---:|
| 0 | 8 | 20 |

Oito vendedores não venderam nada no período, e o `NOT EXISTS` encontra os oito. O `NOT IN` encontra **zero**, porque basta um dos 20 pedidos sem vendedor (`NULL`) na subconsulta para nenhuma linha passar. Nesse caso, a consulta com `NOT IN` não é só lenta: ela está **errada**, e de um jeito silencioso, sem nenhuma mensagem de erro.

### Passo 6: e no painel do chamado?

| table_name | column_name | is_nullable |
|---|---|---|
| pagamentos | pedido_id | NO |
| pedidos | vendedor_id | YES |

**Achado:** `pagamentos.pedido_id` é `NOT NULL`. A subconsulta do painel nunca devolve nulo, e por isso a reescrita com `NOT EXISTS` devolve exatamente o mesmo resultado. A comparação por `md5` dos dois resultados confirma (`resultados_iguais = true`). Se a coluna aceitasse nulos, a troca mudaria o resultado, e seria preciso decidir qual dos dois é o correto para o negócio.

## 4. Causa raiz

O painel usa `NOT IN` com uma subconsulta que devolve 487 mil linhas. Por causa da regra do `NOT IN` com nulos, o PostgreSQL não o transforma num *anti-join*. Como a lista não cabe na memória de trabalho, ele percorre a lista do início para cada pedido do dia: 576 pedidos × cerca de 250 mil linhas. O índice criado pelo time não ajuda, porque nenhuma das duas formas de executar um `NOT IN` usa índice.

## 5. Correção e verificação

[`consulta-corrigida.sql`](consulta-corrigida.sql): o mesmo painel com `NOT EXISTS` no lugar de `NOT IN`. O [`correcao.sql`](correcao.sql) não muda nada no banco.

| | Antes (`NOT IN`) | Depois (`NOT EXISTS`) |
|---|---|---|
| Como `pagamentos` é lida | dentro de um `SubPlan`, percorrida de novo para cada um dos 576 pedidos do dia | uma vez, num `Hash Anti Join` |
| Linhas de `pagamentos` comparadas | ~144 milhões | 487.490 |
| Páginas lidas (total da consulta) | 1.201.221 | 8.431 |
| Tempo de execução | ~9,7 s | ~80 ms |
| Resultado | 20 linhas | as mesmas 20 linhas |

### Verificação automatizada

O `npm run validate` (e a CI) repete esta verificação a cada execução, numa transação desfeita no fim:

1. confere que, sem a correção, `pagamentos` é lida com `Seq Scan` **dentro de um `SubPlan`**;
2. aplica a tentativa (o índice), confere que **nada muda** (ainda `Seq Scan` dentro de um `SubPlan`) e a desfaz;
3. confere que a consulta corrigida lê `pagamentos` num **`Hash Join` do tipo `Anti`**;
4. confere que a consulta original e a corrigida devolvem **exatamente o mesmo resultado** (quantidade de linhas e `md5` do conteúdo).

## 6. Recomendações

- **Aplicar a reescrita** no painel.
- **Manter o índice em `pagamentos.pedido_id`.** Depois da reescrita, ele é usado (passo 4a) e também acelera a checagem da chave estrangeira ao apagar pedidos (ver a [investigação 01](../01-fk-sem-indice/README.md)).
- **Não aumentar o `work_mem` para resolver este painel** (passo 3): resolve hoje e volta a quebrar quando a tabela crescer.
- **Revisar os outros `NOT IN` com subconsulta do sistema**, por dois motivos: o plano (este chamado) e o resultado (passo 5). Para cada um, conferir se a coluna da subconsulta aceita nulos antes de trocar por `NOT EXISTS`, porque a troca pode mudar o resultado.
- **Prevenção:** na revisão de código, tratar `NOT IN (SELECT ...)` como um alerta. `NOT IN` com uma lista fixa de valores (`status NOT IN ('cancelado', 'pendente')`) não tem esses problemas.
