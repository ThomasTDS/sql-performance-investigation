# Investigação 01 — Chave estrangeira sem índice

| | |
|---|---|
| **Sintoma** | A consulta dos itens de um pedido, usada na tela "Detalhes do pedido", leva cerca de 60 ms para devolver 2 linhas |
| **Causa raiz** | A coluna `itens_pedido.pedido_id` é uma chave estrangeira sem índice. O PostgreSQL não cria índice para chave estrangeira, então cada consulta lê a tabela inteira: 1,5 milhão de linhas e cerca de 75 MB |
| **Correção** | `CREATE INDEX` em `itens_pedido (pedido_id)` (em produção, com `CONCURRENTLY`) |
| **Resultado** | De cerca de 60 ms para cerca de 0,05 ms (mais de 1.000 vezes mais rápido), lendo 10 páginas em vez de 9.567, com o mesmo resultado |
| **Efeito colateral positivo** | A checagem da chave estrangeira ao apagar um pedido cai de cerca de 74 ms para 0,09 ms |
| **Status** | Diagnóstico concluído, com correção verificada numa transação desfeita em seguida (`ROLLBACK`) |

Arquivos desta investigação:

- [`consulta.sql`](consulta.sql): a consulta do chamado, exatamente como a tela a executa.
- [`exploracao.sql`](exploracao.sql): as queries na ordem em que foram usadas, numeradas conforme os passos abaixo.
- [`correcao.sql`](correcao.sql): a correção proposta.

> **Sobre os tempos:** foram medidos num notebook com Windows e variam de máquina para máquina e entre execuções. Logo depois da carga do volume, a primeira leitura de cada página é mais lenta, porque o PostgreSQL ainda grava as *hint bits* (marcas de visibilidade das linhas). Por isso, os tempos do "antes" vêm de uma segunda execução. O que não varia, e é o que a CI confere, é **o formato do plano** e **o resultado** da consulta.

---

## 1. Sintoma relatado

> Chamado do time de produto: "A tela de detalhes do pedido ficou lenta conforme a base cresceu." No relatório de consultas lentas do banco, a consulta dos itens do pedido aparece no topo: cerca de **60 ms por execução**, contra menos de 1 ms das outras consultas da mesma tela.

A consulta ([`consulta.sql`](consulta.sql)) busca os itens de um único pedido, com o nome do produto:

```sql
SELECT i.id, i.produto_id, p.nome AS produto, i.quantidade, i.preco_unitario,
       i.quantidade * i.preco_unitario AS subtotal
FROM itens_pedido i
JOIN produtos p ON p.id = i.produto_id
WHERE i.pedido_id = 428117
ORDER BY i.id;
```

| id | produto_id | produto | quantidade | preco_unitario | subtotal |
|---|---|---|---|---|---|
| 1285014 | 71 | Produto 0071 | 2 | 1637.49 | 3274.98 |
| 1285015 | 181 | Produto 0181 | 2 | 373.39 | 746.78 |

Sessenta milissegundos para devolver **2 linhas** é desproporcional. A pergunta é: quanto trabalho o banco está fazendo para encontrar essas 2 linhas?

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | O banco está lento em geral (máquina sobrecarregada, cache frio, bloqueios) | Comparar com outra consulta simples na mesma base |
| H2 | A consulta lê muito mais dados do que devolve | Ler o plano de execução real (`EXPLAIN ANALYZE`) |
| H3 | Se H2: não existe índice utilizável em `pedido_id` | Listar os índices da tabela no catálogo |
| H4 | Se H2: o planejador escolheu mal por causa de estatísticas desatualizadas | Comparar as linhas estimadas com as linhas reais |

## 3. Investigação

### Passo 1: o plano de execução real

`EXPLAIN (ANALYZE, BUFFERS)` executa a consulta e mostra o plano que o PostgreSQL usou, com o tempo e as páginas lidas em cada etapa (trecho principal):

```
Sort  (actual time=53.149..56.722 rows=2 loops=1)
  ->  Gather  (actual time=50.101..56.711 rows=2 loops=1)
        Workers Planned: 2
        ->  Nested Loop  (actual time=23.802..24.750 rows=1 loops=3)
              ->  Parallel Seq Scan on itens_pedido i  (cost=0.00..17378.39 rows=2) (actual time=23.786..24.732 rows=1 loops=3)
                    Filter: (pedido_id = 428117)
                    Rows Removed by Filter: 500312
                    Buffers: shared hit=4073 read=5488
              ->  Index Scan using produtos_pkey on produtos p  (actual time=0.017..0.017 rows=1 loops=2)
Execution Time: 56.741 ms
```

Como ler:

- **`Parallel Seq Scan on itens_pedido`**: a tabela é lida do início ao fim (*sequential scan*), dividida entre 3 processos (o principal e 2 *workers*).
- **`Rows Removed by Filter: 500312`** com **`loops=3`**: cada processo descartou cerca de 500 mil linhas. Ao todo, foram **cerca de 1,5 milhão de linhas lidas para devolver 2**.
- **`Buffers: shared hit=4073 read=5488`**: 9.561 páginas de 8 KB, ou seja, praticamente a tabela inteira (75 MB).
- A busca em `produtos` usa a chave primária (`Index Scan using produtos_pkey`) e custa 0,017 ms. O problema está todo em `itens_pedido`.

**Achado:** **H2 confirmada.** O tempo inteiro está na leitura completa de `itens_pedido`.

### Passo 2: o banco está lento em geral?

A mesma base, buscando o pedido pela chave primária:

```
Index Scan using pedidos_pkey on pedidos  (actual time=0.005..0.006 rows=1 loops=1)
  Index Cond: (id = 428117)
  Buffers: shared hit=4
Execution Time: 0.014 ms
```

**Achado:** **H1 descartada.** Com um índice, o banco encontra uma linha em 500 mil lendo 4 páginas, em 0,014 ms. O banco não está lento: é essa consulta que faz trabalho demais.

### Passo 3: quais índices existem em `itens_pedido`?

```sql
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'itens_pedido';
```

| indexname | indexdef |
|---|---|
| itens_pedido_pkey | CREATE UNIQUE INDEX itens_pedido_pkey ON public.itens_pedido USING btree (id) |

**Achado:** **H3 confirmada.** O único índice é o da chave primária (`id`). Para filtrar por `pedido_id`, o banco não tem alternativa a não ser ler a tabela inteira.

Isso surpreende quem vem de outros bancos: o schema declara `pedido_id INTEGER NOT NULL REFERENCES pedidos (id)`, e é comum supor que a chave estrangeira "vem com índice". No PostgreSQL, **não vem**. Ele cria índice automaticamente para a chave primária e para `UNIQUE` (que precisam de índice para garantir a unicidade), mas **nunca para o lado que referencia** uma chave estrangeira.

### Passo 4: as estatísticas estão erradas?

Se o planejador achasse que `pedido_id = 428117` devolve muitas linhas, um Seq Scan poderia ser uma escolha razoável. O plano estimou `rows=2` por processo (4 no total), e a consulta devolveu 2. As estatísticas confirmam:

| linhas_estimadas | n_distinct |
|---|---|
| 1500939 | -0.2853374 |

| pedidos | media_itens | max_itens |
|---|---|---|
| 500000 | 3.00 | 5 |

Um `n_distinct` negativo é uma fração do total de linhas: cerca de 0,285 × 1,5 milhão ≈ 428 mil valores distintos, o que dá uns 3,5 itens por pedido. A estimativa (4) está muito perto da realidade (média de 3, máximo de 5).

**Achado:** **H4 descartada.** O planejador sabia que a consulta devolve poucas linhas. Ele escolheu o Seq Scan porque **não havia outro caminho**, e não por estimar errado.

> A estimativa de `n_distinct` vem de uma amostra aleatória do `ANALYZE` e varia um pouco a cada execução (em outra rodada, saiu -0,2712). Por isso, a CI deste projeto não confere números de estatísticas, só o formato do plano.

### Passo 5: o problema é só desta coluna?

Todas as chaves estrangeiras do schema, e se existe algum índice começando pela coluna delas:

| tabela | coluna | referencia | tem_indice |
|---|---|---|---|
| pedidos | cliente_id | clientes | false |
| pedidos | vendedor_id | vendedores | false |
| itens_pedido | pedido_id | pedidos | false |
| itens_pedido | produto_id | produtos | false |
| pagamentos | pedido_id | pedidos | false |

**Achado:** nenhuma das 5 chaves estrangeiras tem índice. Isso **não** significa que todas precisam de um: cada índice ocupa espaço e deixa as escritas na tabela um pouco mais caras. O índice compensa quando existem consultas (ou remoções na tabela referenciada) que filtram por aquela coluna. Este chamado é sobre `itens_pedido.pedido_id`, e a correção fica restrita a ela. As demais estão nas recomendações (seção 6).

## 4. Causa raiz

A consulta filtra `itens_pedido` por `pedido_id`, uma chave estrangeira **sem índice**, porque o PostgreSQL não cria índice para chaves estrangeiras. Sem índice, a única forma de encontrar os itens de um pedido é ler as 1,5 milhão de linhas da tabela. O custo cresce junto com a tabela, o que explica o relato de que a tela "ficou lenta conforme a base cresceu".

## 5. Correção e verificação

[`correcao.sql`](correcao.sql):

```sql
CREATE INDEX idx_itens_pedido_pedido_id ON itens_pedido (pedido_id);
```

> **Em produção, use `CREATE INDEX CONCURRENTLY`.** O `CREATE INDEX` comum bloqueia `INSERT`, `UPDATE` e `DELETE` na tabela enquanto o índice é construído. O `CONCURRENTLY` demora mais, mas não bloqueia as escritas. Ele não pode rodar dentro de uma transação, e por isso o arquivo usa a forma comum, que a validação consegue desfazer com `ROLLBACK`. O índice resultante é o mesmo.

Plano depois da correção (passo 6 do [`exploracao.sql`](exploracao.sql)):

```
Sort  (actual time=0.029..0.029 rows=2 loops=1)
  ->  Nested Loop  (actual time=0.023..0.025 rows=2 loops=1)
        ->  Index Scan using idx_itens_pedido_pedido_id on itens_pedido i  (cost=0.43..8.50 rows=4) (actual time=0.018..0.018 rows=2 loops=1)
              Index Cond: (pedido_id = 428117)
              Buffers: shared hit=1 read=3
        ->  Index Scan using produtos_pkey on produtos p  (actual time=0.001..0.001 rows=1 loops=2)
Execution Time: 0.043 ms
```

| | Antes | Depois |
|---|---|---|
| Acesso a `itens_pedido` | `Parallel Seq Scan` (tabela inteira) | `Index Scan using idx_itens_pedido_pedido_id` |
| Linhas lidas para devolver 2 | ~1,5 milhão | 2 |
| Páginas lidas (total da consulta) | 9.567 | 10 |
| Processos | 3 (principal + 2 *workers*) | 1 |
| Tempo de execução | ~57 ms | ~0,05 ms |
| Resultado | 2 linhas | as mesmas 2 linhas |

**Custo da correção:** o índice ocupa **21 MB** (a tabela tem 75 MB) e levou cerca de 1 segundo para ser criado. Cada `INSERT` em `itens_pedido` passa a atualizar também o índice, um custo pequeno perto do ganho numa consulta que roda a cada abertura da tela.

### Efeito colateral positivo: apagar um pedido

Ao apagar um pedido, o PostgreSQL precisa confirmar que nenhum item e nenhum pagamento aponta para ele. Essa checagem aparece no plano como `Trigger for constraint`, e ela faz a mesma busca por `pedido_id`. Passo 7 do [`exploracao.sql`](exploracao.sql), apagando o pedido 428117 (depois de seus itens e pagamento):

| Checagem da chave estrangeira | Sem o índice | Com o índice |
|---|---|---|
| `itens_pedido_pedido_id_fkey` | 73,6 ms | **0,09 ms** |
| `pagamentos_pedido_id_fkey` | 19,4 ms | 20,2 ms |
| **Tempo total do `DELETE`** | 93,1 ms | 20,3 ms |

A checagem de `itens_pedido` ficou instantânea. A de `pagamentos` continua lenta, pela mesma causa: `pagamentos.pedido_id` também é uma chave estrangeira sem índice.

### Verificação automatizada

O `npm run validate` (e a CI) repete esta verificação a cada execução, numa transação desfeita no fim:

1. confere que, sem a correção, `itens_pedido` é lida com `Seq Scan`;
2. aplica o [`correcao.sql`](correcao.sql);
3. confere que `itens_pedido` passa a ser lida com `Index Scan usando idx_itens_pedido_pedido_id`;
4. confere que a consulta devolve **exatamente o mesmo resultado** antes e depois (quantidade de linhas e `md5` do conteúdo).

## 6. Recomendações

- **Aplicar a correção em produção** com `CREATE INDEX CONCURRENTLY` e conferir depois que o índice ficou válido (`pg_index.indisvalid`). Um `CONCURRENTLY` interrompido deixa para trás um índice inválido, que ocupa espaço e não é usado.
- **Avaliar `pagamentos.pedido_id`**, que tem o mesmo padrão de acesso (pagamentos de um pedido) e já aparece lento na remoção de pedidos.
- **Não indexar as demais chaves estrangeiras às cegas:** criar índice para `pedidos.cliente_id`, `pedidos.vendedor_id` e `itens_pedido.produto_id` só se houver consultas que filtrem por elas.
- **Prevenção:** na revisão de toda nova chave estrangeira, perguntar "alguém vai buscar por esta coluna?". A consulta do passo 5 pode virar uma verificação periódica.
