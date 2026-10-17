# Investigação 03 — Paginação com OFFSET alto

| | |
|---|---|
| **Sintoma** | A listagem de pedidos é instantânea nas primeiras páginas, mas as últimas levam centenas de milissegundos. A exportação noturna, que percorre todas as páginas, não termina a tempo |
| **Causa raiz** | `OFFSET N` não "pula" linhas: o banco produz as `N` linhas anteriores, na ordem, e as descarta. O custo de cada página cresce com o número dela, com ou sem índice |
| **Correção** | Paginação por chave (*keyset*): `WHERE (data_pedido, id) < (cursor)` em vez de `OFFSET`, apoiada no índice em `(data_pedido, id)` |
| **Resultado** | Página 20.025: de 400.500 linhas lidas (~660 ms) para 20 linhas (~0,08 ms), com exatamente o mesmo resultado. O custo passa a ser o mesmo em qualquer página |
| **Status** | Diagnóstico concluído, com correção verificada numa transação desfeita em seguida (`ROLLBACK`) |

Arquivos desta investigação:

- [`consulta.sql`](consulta.sql): a listagem do chamado, com `OFFSET`.
- [`tentativa.sql`](tentativa.sql): o índice que o time criou antes de abrir o chamado.
- [`exploracao.sql`](exploracao.sql): as queries na ordem em que foram usadas, numeradas conforme os passos abaixo.
- [`correcao.sql`](correcao.sql): parte 1 da correção, o índice (o mesmo da tentativa: necessário, mas não suficiente).
- [`consulta-corrigida.sql`](consulta-corrigida.sql): parte 2 da correção, a listagem reescrita com paginação por chave.

> **Sobre os tempos:** são medianas de 5 execuções num notebook com Windows. Os valores absolutos variam muito: em outra sessão, na mesma máquina, a página 20.025 levou cerca de 190 ms sem índice e 200 ms com índice, contra 920 ms e 660 ms nesta. O que não varia, e é o que a CI confere, é o **formato do plano**, a **quantidade de linhas lidas** e o **resultado** da consulta. Medições padronizadas de todos os cenários, com data e ambiente, ficam em [`MEDICOES.md`](../MEDICOES.md) (`npm run medir`).

---

## 1. Sintoma relatado

> Chamado do time de backoffice: "A listagem de pedidos ficou lenta e criamos um índice para a ordenação. As primeiras páginas ficaram instantâneas, mas as últimas continuam lentas. A exportação noturna, que percorre todas as páginas, não termina a tempo."

Na [triagem](../00-triagem/README.md) com a `pg_stat_statements`, feita sobre o banco antes de qualquer índice, a listagem lidera o ranking por tempo total: **4.275 blocos por execução** para devolver 20 linhas.

A listagem ([`consulta.sql`](consulta.sql)) mostra os pedidos mais recentes primeiro, 20 por página. O `id` desempata pedidos com a mesma data, para que a ordem seja estável. O exemplo é a página 20.025:

```sql
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
ORDER BY data_pedido DESC, id DESC
LIMIT 20 OFFSET 400480;
```

O índice que o time criou ([`tentativa.sql`](tentativa.sql)):

```sql
CREATE INDEX idx_pedidos_data_id ON pedidos (data_pedido, id);
```

Os passos abaixo partem desse estado, ou seja, com o índice.

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | O índice não é usado nas últimas páginas | Ler o plano das últimas páginas |
| H2 | O custo de uma página cresce com o número da página | Comparar páginas do início, do meio e do fim |
| H3 | Se H2: o `OFFSET` lê e descarta todas as linhas anteriores | Contar as linhas lidas no plano |

## 3. Investigação

### Passo 1: a mesma listagem em três páginas

| Página | `OFFSET` | Plano | Linhas lidas | Páginas lidas (buffers) | Tempo |
|---|---:|---|---:|---:|---:|
| 2 | 20 | `Index Scan Backward` | 40 | 43 | ~0,1 ms |
| 2.001 | 40.000 | `Index Scan Backward` | 40.020 | 40.320 | ~61 ms |
| 20.025 | 400.480 | `Index Scan Backward` | 400.500 | 403.479 | ~660 ms |

O plano da página 20.025:

```
Limit  (cost=25653.50..25654.78 rows=20 width=32) (actual time=636.538..636.581 rows=20 loops=1)
  Buffers: shared hit=402098 read=1381
  ->  Index Scan Backward using idx_pedidos_data_id on pedidos  (cost=0.42..32028.34 rows=500000 width=32) (actual time=0.023..594.402 rows=400500 loops=1)
        Buffers: shared hit=402098 read=1381
```

**Achado:** **H1 descartada.** O índice é usado em todas as páginas: o banco percorre o índice de trás para frente (`Index Scan Backward`) e já recebe os pedidos na ordem da listagem, sem precisar ordenar nada.

**Achado:** **H2 confirmada.** As linhas lidas são sempre `OFFSET + 20`, e o tempo cresce na mesma proporção: de 40 linhas na página 2 para 400.500 na página 20.025.

### Passo 2: e sem o índice?

A mesma página 20.025, com o índice removido (dentro de um *savepoint*, desfeito em seguida):

```
Limit  (cost=69500.12..69500.17 rows=20 width=32) (actual time=954.651..954.663 rows=20 loops=1)
  Buffers: shared hit=4207, temp read=2419 written=2607
  ->  Sort  (cost=68498.92..69748.92 rows=500000 width=32) (actual time=746.206..911.441 rows=400500 loops=1)
        Sort Key: data_pedido DESC, id DESC
        Sort Method: external merge  Disk: 20768kB
        ->  Seq Scan on pedidos  (cost=0.00..9207.00 rows=500000 width=32) (actual time=0.028..188.863 rows=500000 loops=1)
              Buffers: shared hit=4207
```

Sem o índice, o banco lê os 500 mil pedidos, ordena tudo (usando **20 MB em disco**, porque a ordenação não coube na memória de trabalho, `work_mem`) e só então descarta as 400.480 primeiras linhas. Mediana: ~920 ms. Sem o índice, mesmo a página 2 lê a tabela inteira (~100 ms), embora ali o banco só precise guardar as 40 primeiras linhas da ordenação (`top-N heapsort`, em memória). Foi essa lentidão geral que levou o time a criar o índice.

Com o índice, a página 20.025 lê ~100 vezes mais páginas (403 mil contra 4,2 mil), porque busca cada linha na tabela, uma a uma, na ordem do índice. Ainda assim, ela fica no mesmo patamar de tempo, porque deixa de ordenar 500 mil linhas em disco. **O índice resolveu a ordenação, mas não o `OFFSET`.**

**Achado:** **H3 confirmada.** `OFFSET 400480` não é um "pulo": é "produza 400.480 linhas, na ordem, e jogue fora". Com ou sem índice, o trabalho é proporcional à posição da página. O índice só torna barato **começar** a percorrer a ordem, e por isso as primeiras páginas ficaram instantâneas.

### O impacto na exportação

A exportação noturna percorre as 25.000 páginas. Com `OFFSET`, a página `p` lê `20 × p` linhas, e o total lido é:

> 20 × (1 + 2 + … + 25.000) = 20 × 312.512.500 ≈ **6,25 bilhões de linhas**

Isso equivale a ler a tabela de 500 mil pedidos mais de 12 mil vezes. O custo cresce com o **quadrado** do tamanho da tabela: com o dobro de pedidos, a exportação leva quatro vezes mais.

## 4. Causa raiz

A listagem pagina com `OFFSET`, e o banco não tem como saber onde começa a linha 400.481 sem antes produzir as 400.480 anteriores. O índice criado pelo time tornou barato começar a percorrer a ordem, o que explica as primeiras páginas instantâneas, mas o custo de cada página continua proporcional à sua posição.

## 5. Correção e verificação

A correção tem duas partes: o índice (o mesmo da tentativa, em [`correcao.sql`](correcao.sql)) e a **reescrita da consulta** ([`consulta-corrigida.sql`](consulta-corrigida.sql)).

Em vez de "pule as 400.480 primeiras linhas", a consulta pede "as 20 linhas que vêm **logo depois** da última linha que o usuário viu". A aplicação guarda a `data_pedido` e o `id` da última linha exibida (o **cursor**) e os envia ao pedir a próxima página:

```sql
SELECT id, cliente_id, data_pedido, status, valor_total
FROM pedidos
WHERE (data_pedido, id) < ('2023-12-04 11:43:35', 320010)
ORDER BY data_pedido DESC, id DESC
LIMIT 20;
```

O cursor é a última linha da página 20.024 (passo 4). Com o índice, o banco **posiciona-se direto** nesse ponto (como numa busca por chave) e lê só as 20 linhas seguintes:

```
Limit  (cost=0.42..4.51 rows=20 width=32) (actual time=0.172..0.200 rows=20 loops=1)
  Buffers: shared hit=22 read=1
  ->  Index Scan Backward using idx_pedidos_data_id on pedidos  (cost=0.42..20063.78 rows=98255 width=32) (actual time=0.170..0.195 rows=20 loops=1)
        Index Cond: (ROW(data_pedido, id) < ROW('2023-12-04 11:43:35'::timestamp without time zone, 320010))
        Buffers: shared hit=22 read=1
```

A diferença para a tentativa está na linha `Index Cond`: o índice deixa de ser só "um jeito de ler na ordem" e passa a ser usado para **encontrar o ponto de partida**.

| Página 20.025 | Sem índice | Só o índice (tentativa) | Índice + keyset |
|---|---|---|---|
| Plano | `Seq Scan` + `Sort` em disco | `Index Scan Backward` | `Index Scan Backward` com `Index Cond` |
| Linhas lidas | 500.000 | 400.500 | **20** |
| Páginas lidas (buffers) | 4.207 + 20 MB em disco | 403.479 | **23** |
| Tempo (mediana) | ~920 ms | ~660 ms | **~0,08 ms** |
| Resultado | 20 linhas | as mesmas 20 linhas | as mesmas 20 linhas |

Com keyset, **qualquer página custa o mesmo**: são 20 linhas lidas a partir do cursor. A exportação completa passa a ler os 500 mil pedidos uma única vez, em vez de 6,25 bilhões de linhas.

### O `id` no cursor não é opcional

A tabela tem **1.456 linhas a mais do que datas distintas** (passo 3), ou seja, há pedidos que dividem exatamente a mesma `data_pedido`. A fronteira entre as páginas 20.024 e 20.025 cai justamente em dois deles (passo 4):

| id | data_pedido | |
|---|---|---|
| 320010 | 2023-12-04 11:43:35 | última linha da página 20.024 (cursor) |
| 35150 | 2023-12-04 11:43:35 | primeira linha da página 20.025 |

Um cursor só com a data (`WHERE data_pedido < '2023-12-04 11:43:35'`) **pularia o pedido 35150**: o passo 7 mostra que ele fica de fora. O par `(data_pedido, id)` é único, e a comparação de linha `(data_pedido, id) < (..., ...)` garante que nenhum pedido seja pulado ou repetido entre páginas. Por isso o `id` precisa estar no `ORDER BY`, no cursor **e** no índice.

### Verificação automatizada

O `npm run validate` (e a CI) repete esta verificação a cada execução, numa transação desfeita no fim:

1. sem nenhum índice, confere que `pedidos` é lida com `Seq Scan` e que são lidas **500.000** linhas;
2. aplica o [`tentativa.sql`](tentativa.sql) num *savepoint* e confere que o acesso vira `Index Scan`, mas ainda lendo **400.500** linhas. Depois, desfaz a tentativa;
3. aplica o [`correcao.sql`](correcao.sql) e confere que a [`consulta-corrigida.sql`](consulta-corrigida.sql) lê `pedidos` com `Index Scan`, lendo só **20** linhas;
4. confere que a consulta corrigida devolve **exatamente o mesmo resultado** (as mesmas 20 linhas, na mesma ordem) que a consulta original.

Como a tentativa e a correção usam o mesmo índice e o mesmo tipo de nó, só a contagem de linhas lidas diferencia uma da outra. Ao contrário do tempo, essa contagem é determinística. A verificação 4 também protege contra o erro do cursor sem `id`: com ele, o resultado muda e a validação falha.

## 6. Recomendações

- **Adotar keyset na API da listagem:** em vez de `?pagina=20025`, a API recebe e devolve um cursor (por exemplo, `?depois_de=2023-12-04T11:43:35_320010`), e o botão "próxima página" usa o cursor da última linha. A página anterior usa a comparação e a ordem invertidas (`>` e `ASC`), e o resultado é reinvertido na aplicação.
- **Reescrever a exportação noturna com keyset.** É o maior ganho: de ~6,25 bilhões de linhas lidas para 500 mil.
- **Limites do keyset:** ele não permite "ir direto para a página 20.025" sem conhecer o cursor. Se a interface precisar desse salto, uma opção é manter o `OFFSET` só para as primeiras páginas e limitar até onde ele vai (a maioria dos usuários não passa da página 10), deixando a navegação profunda para filtros (por data, por cliente).
- **Toda ordenação paginada precisa de desempate único:** `ORDER BY data_pedido DESC` sozinho já é um problema mesmo com `OFFSET`. Com datas repetidas, a ordem entre elas não é garantida, e um pedido pode aparecer em duas páginas ou em nenhuma.
- **Filtros combinados:** se a listagem ganhar filtros (por exemplo, `WHERE status = 'pendente'`), o índice precisa considerá-los, por exemplo `(status, data_pedido, id)`, para que o keyset continue lendo só 20 linhas.
