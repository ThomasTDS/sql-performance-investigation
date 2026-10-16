# Investigação 02 — Índice ignorado por causa de uma função na coluna

| | |
|---|---|
| **Sintoma** | A busca de cliente por email continua lendo a tabela inteira, mesmo depois de o time criar um índice em `email` |
| **Causa raiz** | A consulta compara `lower(email)`, e não `email`. Um índice B-tree sobre a coluna guarda os valores de `email` e não serve para uma condição sobre uma expressão calculada a partir dela |
| **Correção** | Índice de expressão em `lower(email)`, seguido de `ANALYZE` |
| **Resultado** | De cerca de 7 ms para cerca de 0,01 ms (mais de 500 vezes mais rápido), lendo 4 páginas em vez de 705, com o mesmo resultado |
| **Status** | Diagnóstico concluído, com correção verificada numa transação desfeita em seguida (`ROLLBACK`) |

Arquivos desta investigação:

- [`consulta.sql`](consulta.sql): a busca do chamado, exatamente como a aplicação a executa.
- [`tentativa.sql`](tentativa.sql): o índice que o time criou antes de abrir o chamado e que não resolveu.
- [`exploracao.sql`](exploracao.sql): as queries na ordem em que foram usadas, numeradas conforme os passos abaixo.
- [`correcao.sql`](correcao.sql): a correção proposta.

> **Sobre os tempos:** foram medidos num notebook com Windows e variam de máquina para máquina. O que não varia, e é o que a CI confere, é **o formato do plano** (inclusive com o índice da tentativa) e **o resultado** da consulta.

---

## 1. Sintoma relatado

> Chamado do time de plataforma: "A busca de cliente por email, usada no login e na tela de atendimento, é uma das consultas que mais consomem tempo do banco no total. Cada execução é rápida, mas ela roda a cada login. **Já criamos um índice em `email`** e nada mudou."

Na [triagem](../00-triagem/README.md) com a `pg_stat_statements`, ela aparece entre as três que mais pesam: **705 blocos por execução** para devolver 1 linha.

A busca ([`consulta.sql`](consulta.sql)) aplica `lower()` dos dois lados, para que `Cliente04217@Exemplo.com` encontre `cliente04217@exemplo.com`:

```sql
SELECT id, nome, email, status
FROM clientes
WHERE lower(email) = lower('Cliente04217@Exemplo.com');
```

| id | nome | email | status |
|---|---|---|---|
| 4217 | Cliente 04217 | cliente04217@exemplo.com | ativo |

O índice que o time criou ([`tentativa.sql`](tentativa.sql)):

```sql
CREATE INDEX idx_clientes_email ON clientes (email);
```

Todos os passos abaixo partem desse estado: o índice comum já existe.

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | O índice não está pronto para uso (criação interrompida, índice inválido) | Consultar `pg_index.indisvalid` |
| H2 | O índice serve, mas o planejador prefere o Seq Scan (por exemplo, por estimar muitas linhas) | Penalizar o Seq Scan e ver se o plano muda |
| H3 | O índice não serve para esta condição | Comparar com a mesma busca sem `lower()` |

## 3. Investigação

### Passo 1: o plano de execução real

```
Seq Scan on clientes  (cost=0.00..1455.00 rows=250 width=49) (actual time=0.497..6.205 rows=1 loops=1)
  Filter: (lower((email)::text) = 'cliente04217@exemplo.com'::text)
  Rows Removed by Filter: 49999
  Buffers: shared hit=705
Execution Time: 6.213 ms
```

O banco lê as 705 páginas da tabela, calcula `lower(email)` para cada um dos 50 mil clientes e descarta 49.999. O índice `idx_clientes_email` **não aparece no plano**.

Duas observações sobre a linha `Filter`:

- O `lower('Cliente04217@Exemplo.com')` já aparece calculado (`'cliente04217@exemplo.com'`): o lado do valor digitado não é o problema.
- O lado da coluna continua como `lower((email)::text)`, uma expressão que precisa ser calculada linha a linha.

### Passo 2: o índice está válido?

| indice | valido | pronto | definicao |
|---|---|---|---|
| clientes_pkey | true | true | CREATE UNIQUE INDEX clientes_pkey ON public.clientes USING btree (id) |
| idx_clientes_email | true | true | CREATE INDEX idx_clientes_email ON public.clientes USING btree (email) |

**Achado:** **H1 descartada.** O índice existe, é válido e está pronto para uso.

### Passo 3: o planejador prefere o Seq Scan ou não tem escolha?

O parâmetro `enable_seqscan = off` não proíbe o Seq Scan, mas soma um custo proibitivo (10 bilhões) a ele. Se ainda assim o plano for Seq Scan, é porque não existe outro caminho:

```sql
SET LOCAL enable_seqscan = off;
EXPLAIN SELECT ... WHERE lower(email) = lower('Cliente04217@Exemplo.com');
```

```
Seq Scan on clientes  (cost=10000000000.00..10000001455.00 rows=250 width=49)
  Filter: (lower((email)::text) = 'cliente04217@exemplo.com'::text)
```

**Achado:** **H2 descartada.** Mesmo com o Seq Scan "proibido", ele continua lá. O planejador não está preferindo um caminho em vez de outro: **o índice simplesmente não é uma opção** para esta condição.

> `enable_seqscan` é uma ferramenta de **diagnóstico**, usada aqui numa transação (`SET LOCAL`). Não é uma correção: desligá-lo no servidor pioraria todas as consultas que precisam mesmo ler a tabela inteira.

### Passo 4: e sem `lower()`?

A mesma busca, comparando a coluna diretamente:

```
Index Scan using idx_clientes_email on clientes  (cost=0.41..8.43 rows=1 width=49) (actual time=0.016..0.016 rows=1 loops=1)
  Index Cond: ((email)::text = 'cliente04217@exemplo.com'::text)
  Buffers: shared hit=1 read=3
Execution Time: 0.022 ms
```

Agora o índice é usado (`Index Cond`), e a busca lê 4 páginas. Mas a comparação direta diferencia maiúsculas de minúsculas: buscando `email = 'Cliente04217@Exemplo.com'`, como o usuário digitou, o resultado é **0 clientes**. Por isso a aplicação usa `lower()`.

**Achado:** **H3 confirmada.** O índice B-tree guarda os valores de `email`, ordenados. Ele permite responder rápido a perguntas sobre `email` (`=`, `<`, `>`, prefixo), mas a consulta pergunta sobre `lower(email)`, um valor diferente que o índice não guarda. Para o banco, não há relação entre a ordem de `email` e a de `lower(email)`. A regra geral: **aplicar uma função à coluna no `WHERE` impede o uso de um índice comum sobre essa coluna.** O mesmo vale para `date(data_pedido)`, `email || ''`, `id + 0` ou um `CAST` na coluna.

## 4. Causa raiz

O índice criado pelo time indexa `email`, mas a consulta filtra por `lower(email)`. Como o índice não contém os valores de `lower(email)`, o banco não tem como usá-lo e lê a tabela inteira, calculando `lower()` em cada linha. Criar um índice "na coluna certa" não basta: ele precisa indexar **a mesma expressão** que aparece no `WHERE`.

## 5. Correção e verificação

[`correcao.sql`](correcao.sql):

```sql
CREATE INDEX idx_clientes_lower_email ON clientes (lower(email));
ANALYZE clientes;
```

O índice de expressão guarda os valores já calculados de `lower(email)`, e a condição da consulta passa a casar exatamente com ele.

### Por que o `ANALYZE` faz parte da correção

Logo depois do `CREATE INDEX`, o plano já usa o índice, mas ainda não o melhor plano:

```
Bitmap Heap Scan on clientes  (cost=10.35..514.87 rows=250 width=49) (actual time=0.016..0.017 rows=1 loops=1)
  Recheck Cond: (lower((email)::text) = 'cliente04217@exemplo.com'::text)
  ->  Bitmap Index Scan on idx_clientes_lower_email  (cost=0.00..10.29 rows=250 width=0) (actual time=0.014..0.014 rows=1 loops=1)
```

Repare em `rows=250`. O PostgreSQL não tinha estatísticas sobre `lower(email)` e usou uma estimativa genérica (0,5% de 50 mil linhas). Para 250 linhas, o *Bitmap Scan* é a escolha certa. Um índice de expressão faz o `ANALYZE` passar a coletar estatísticas também sobre a expressão. Depois dele:

```
Index Scan using idx_clientes_lower_email on clientes  (cost=0.41..8.43 rows=1 width=49) (actual time=0.005..0.006 rows=1 loops=1)
  Index Cond: (lower((email)::text) = 'cliente04217@exemplo.com'::text)
  Buffers: shared hit=4
Execution Time: 0.011 ms
```

A estimativa agora é `rows=1`, e o plano é o *Index Scan* direto. Neste caso, a diferença de tempo entre os dois é pequena, mas estimativas erradas costumam se propagar: numa consulta com `JOIN`, 250 linhas estimadas em vez de 1 podem mudar o tipo de junção inteira. Sem o `ANALYZE` manual, o autovacuum só atualizaria as estatísticas depois de uma quantidade de alterações na tabela.

| | Antes (com o índice da tentativa) | Depois |
|---|---|---|
| Acesso a `clientes` | `Seq Scan` (tabela inteira) | `Index Scan using idx_clientes_lower_email` |
| Linhas lidas para devolver 1 | 50.000 | 1 |
| Páginas lidas | 705 | 4 |
| Linhas estimadas | 250 | 1 |
| Tempo de execução | ~6 a 8 ms | ~0,01 ms |
| Resultado | 1 linha | a mesma linha |

**Custo da correção:** o índice ocupa **2,4 MB**, o mesmo tamanho do índice comum, e cada `INSERT` ou `UPDATE` de `email` passa a calcular `lower()` para atualizá-lo.

### Bônus: busca por prefixo

Com o mesmo índice, uma busca como `lower(email) LIKE 'cliente042%'` também usa o índice, convertida em um intervalo:

```
Index Scan using idx_clientes_lower_email on clientes  (cost=0.41..8.61 rows=5 width=29)
  Index Cond: ((lower((email)::text) >= 'cliente042'::text) AND (lower((email)::text) < 'cliente043'::text))
  Filter: (lower((email)::text) ~~ 'cliente042%'::text)
```

Isso só funciona porque o banco deste projeto usa o locale `C`. Com outros locales (como `pt_BR.UTF-8`), um índice B-tree comum não atende `LIKE` e precisaria ser criado com `text_pattern_ops`. Já um `LIKE '%exemplo.com'`, com `%` no início, não usa índice B-tree em nenhum locale.

### Verificação automatizada

O `npm run validate` (e a CI) repete esta verificação a cada execução, numa transação desfeita no fim:

1. confere que, sem nenhum índice, `clientes` é lida com `Seq Scan`;
2. aplica o [`tentativa.sql`](tentativa.sql) e confere que **continua** `Seq Scan`: o índice comum não resolve;
3. aplica o [`correcao.sql`](correcao.sql) e confere que `clientes` passa a ser lida com `Index Scan usando idx_clientes_lower_email`. Sem o `ANALYZE`, o plano seria `Bitmap Heap Scan`, e a verificação falharia;
4. confere que a busca devolve **exatamente o mesmo resultado** antes e depois.

## 6. Recomendações

- **Aplicar a correção em produção** com `CREATE INDEX CONCURRENTLY`, seguido de `ANALYZE clientes`.
- **Remover o `idx_clientes_email`,** se nenhuma outra consulta comparar `email` diretamente. Hoje ele não ajuda esta busca e ainda custa espaço e escrita. Antes de remover, confira em `pg_stat_user_indexes.idx_scan` se ele foi usado desde a sua criação.
- **Alternativa, se a aplicação puder mudar:** o passo 7 do [`exploracao.sql`](exploracao.sql) mostra que **nenhum email está gravado com maiúsculas**. Com uma restrição `CHECK (email = lower(email))` garantindo isso daqui para frente, a busca pode virar `WHERE email = lower(:digitado)`, que usa o índice comum. Nesse caso, basta um índice. Outra opção é o tipo `citext` (extensão do PostgreSQL), que compara textos sem diferenciar maiúsculas.
- **Prevenção:** em revisão de código, desconfiar de toda função aplicada à **coluna** dentro do `WHERE` (`lower(coluna)`, `date(coluna)`, `coluna::tipo`). Ou o índice indexa a mesma expressão, ou a condição deve ser reescrita para deixar a coluna "nua" (por exemplo, `data_pedido >= '2025-01-01' AND data_pedido < '2025-01-02'` em vez de `date(data_pedido) = '2025-01-01'`).
