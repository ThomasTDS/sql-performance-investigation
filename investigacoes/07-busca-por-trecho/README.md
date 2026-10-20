# Investigação 07 — Busca por trecho do texto (`LIKE '%...'`)

| | |
|---|---|
| **Sintoma** | A busca de cliente pelo final do telefone, usada no atendimento, lê a tabela inteira de clientes a cada busca, mesmo depois de o time criar um índice em `telefone` |
| **Causa raiz** | A busca é `telefone LIKE '%-4217'`, com o curinga no **começo**. Um índice B-tree guarda os telefones em ordem e só ajuda a achar o começo do texto (`LIKE '(11) 9%'`). Para o final ou o meio, o banco precisa olhar todas as 50 mil linhas |
| **Correção** | Um índice de trigramas: a extensão `pg_trgm` com um índice GIN em `telefone` (em produção, com `CONCURRENTLY`) |
| **Resultado** | De cerca de 3 ms para cerca de 0,09 ms (mais de 30 vezes mais rápido), lendo 18 páginas em vez de 705, com o mesmo resultado |
| **Custo** | O índice de trigramas ocupa 1,2 MB, menos que o B-tree da tentativa (1,4 MB), e só ajuda em buscas com pelo menos 3 caracteres seguidos |
| **Status** | Diagnóstico concluído, com correção verificada numa transação desfeita em seguida (`ROLLBACK`) |

Arquivos desta investigação:

- [`consulta.sql`](consulta.sql): a busca do chamado, exatamente como a tela a executa.
- [`tentativa.sql`](tentativa.sql): o índice B-tree que o time criou antes de abrir o chamado.
- [`exploracao.sql`](exploracao.sql): as queries na ordem em que foram usadas, numeradas conforme os passos abaixo.
- [`correcao.sql`](correcao.sql): a correção proposta.

> **Sobre os tempos:** foram medidos num notebook com Windows e variam de máquina para máquina e entre execuções (em outra sessão, o "antes" levou cerca de 17 ms). O que não varia, e é o que a CI confere, é **o formato do plano** e **o resultado** da busca. Medições padronizadas de todos os cenários, com data e ambiente, ficam em [`MEDICOES.md`](../MEDICOES.md) (`npm run medir`).

---

## 1. Sintoma relatado

> Chamado do time de atendimento: "A busca pelo final do telefone é a mais usada no atendimento, porque o cliente quase nunca lembra o email. Ela ficou mais lenta conforme a base cresceu. Criamos um índice em `telefone`, e nada mudou."

O cliente informa os últimos 4 dígitos, e a tela procura qualquer telefone que termine com eles ([`consulta.sql`](consulta.sql)):

```sql
SELECT id, nome, email, telefone
FROM clientes
WHERE telefone LIKE '%-4217'
ORDER BY id;
```

| id | nome | email | telefone |
|---:|---|---|---|
| 4217 | Cliente 04217 | cliente04217@exemplo.com | (11) 94217-4217 |
| 14217 | Cliente 14217 | cliente14217@exemplo.com | (11) 91421-4217 |
| 24217 | Cliente 24217 | cliente24217@exemplo.com | (11) 92421-4217 |
| 34217 | Cliente 34217 | cliente34217@exemplo.com | (11) 93421-4217 |
| 44217 | Cliente 44217 | cliente44217@exemplo.com | (11) 94421-4217 |

Em tempo absoluto, a busca é rápida (alguns milissegundos). O problema é o padrão: ela lê a tabela inteira a cada execução, roda a cada ligação e cresce junto com a base, como a busca por email da [investigação 02](../02-indice-ignorado/README.md).

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | O índice criado pelo time não é usado | Ler o plano de execução real (`EXPLAIN ANALYZE`) |
| H2 | Se H1: um índice B-tree não atende buscas com curinga no começo | Comparar com uma busca pelo começo do telefone, na mesma coluna |
| H3 | Se H2: outro tipo de índice atende buscas por trecho | Testar um índice de trigramas (`pg_trgm`) |

## 3. Investigação

O banco foi colocado no estado do chamado com o índice da tentativa ([`tentativa.sql`](tentativa.sql)).

### Passo 1: o plano real da busca

```
Sort  (actual time=3.068..3.069 rows=5 loops=1)
  ->  Seq Scan on clientes  (cost=0.00..1330.00 rows=4) (actual time=0.257..3.062 rows=5 loops=1)
        Filter: ((telefone)::text ~~ '%-4217'::text)
        Rows Removed by Filter: 49995
        Buffers: shared hit=705
Execution Time: 3.080 ms
```

- **`Seq Scan on clientes`** com **`Rows Removed by Filter: 49995`**: a tabela inteira (705 páginas) é lida para devolver 5 linhas.
- **`~~`** é como o PostgreSQL escreve `LIKE` no plano.
- O índice `idx_clientes_telefone` existe, mas não aparece.

**Achado:** **H1 confirmada.**

### Passo 2: para que serve o índice B-tree?

A mesma coluna, buscando pelo **começo** do telefone:

```
->  Index Scan using idx_clientes_telefone on clientes  (actual time=0.007..0.008 rows=1 loops=1)
      Index Cond: (((telefone)::text >= '(11) 90421'::text) AND ((telefone)::text < '(11) 90422'::text))
      Filter: ((telefone)::text ~~ '(11) 90421%'::text)
Execution Time: 0.018 ms
```

O índice B-tree guarda os telefones em ordem, como uma lista telefônica. Uma busca pelo começo vira um intervalo (`>= '(11) 90421'` e `< '(11) 90422'`), e o índice vai direto a ele. Uma busca pelo final não tem intervalo: os telefones que terminam com `-4217` estão espalhados pela lista inteira.

> Isso só funciona porque o banco usa o locale `C` (ver o README do projeto). Com outros locales, nem a busca pelo começo usaria este índice sem a classe de operadores `text_pattern_ops`.

**Achado:** **H2 confirmada.** O índice da tentativa é útil para outra busca, não para esta.

### Passo 3: como funcionam os trigramas

A extensão `pg_trgm` quebra o texto em **trigramas**, sequências de 3 caracteres de cada palavra (letras e números; a pontuação separa as palavras), com espaços nas pontas:

| Texto | Trigramas |
|---|---|
| `(11) 94217-4217` | `"  1"`, `"  4"`, `"  9"`, `" 11"`, `" 42"`, `" 94"`, `"11 "`, `"17 "`, `"217"`, `"421"`, `"942"` |
| `-4217` | `"  4"`, `" 42"`, `"17 "`, `"217"`, `"421"` |

Um índice GIN guarda, para cada trigrama, a lista de linhas em que ele aparece. Para `LIKE '%-4217'`, o banco cruza as listas dos trigramas do trecho e depois confere cada candidata com o `LIKE` original (o `Recheck Cond` do plano), porque os trigramas ignoram a pontuação e a posição.

### Passo 4: a correção e o plano depois dela

[`correcao.sql`](correcao.sql):

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX idx_clientes_telefone_trgm ON clientes USING gin (telefone gin_trgm_ops);
```

```
Sort  (actual time=0.067..0.067 rows=5 loops=1)
  ->  Bitmap Heap Scan on clientes  (actual time=0.059..0.063 rows=5 loops=1)
        Recheck Cond: ((telefone)::text ~~ '%-4217'::text)
        Heap Blocks: exact=5
        Buffers: shared hit=18
        ->  Bitmap Index Scan on idx_clientes_telefone_trgm  (actual time=0.056..0.056 rows=5 loops=1)
              Index Cond: ((telefone)::text ~~ '%-4217'::text)
              Buffers: shared hit=13
Execution Time: 0.086 ms
```

O índice aponta as 5 linhas (`Bitmap Index Scan`, 13 páginas do índice), e o banco lê só as 5 páginas da tabela onde elas estão (`Heap Blocks: exact=5`).

**Achado:** **H3 confirmada.**

### Passo 5: o custo do índice

| objeto | tamanho |
|---|---|
| clientes | 5640 kB |
| idx_clientes_telefone (B-tree, da tentativa) | 1432 kB |
| idx_clientes_telefone_trgm (GIN, da correção) | 1240 kB |
| clientes_pkey | 1112 kB |

Nesta coluna, o índice de trigramas fica até menor que o B-tree. Em textos longos e variados (nomes, descrições), ele costuma crescer bem mais. A escrita também fica mais cara: cada `INSERT` ou `UPDATE` de telefone atualiza a lista de vários trigramas.

### Passo 6: o limite dos trigramas

Com menos de 3 caracteres seguidos fora dos curingas, não há trigrama completo para procurar. A busca `LIKE '%17%'` volta a ler a tabela inteira, mesmo com o índice:

```
->  Seq Scan on clientes  (actual time=0.005..3.572 rows=2210 loops=1)
      Filter: ((telefone)::text ~~ '%17%'::text)
      Rows Removed by Filter: 47790
```

Nesse caso, ler a tabela inteira também é a escolha certa: a busca devolve 2.210 clientes, e a tela de atendimento deveria exigir mais dígitos.

## 4. Causa raiz

A busca usa `LIKE` com o curinga no começo do padrão. O índice B-tree que o time criou só atende buscas pelo começo do texto, porque guarda os valores em ordem, e os telefones que terminam com os dígitos buscados estão espalhados pela tabela. Sem um índice que entenda trechos, o banco lê os 50 mil clientes a cada busca.

## 5. Correção e verificação

| | Antes (e com o índice B-tree) | Depois (índice de trigramas) |
|---|---|---|
| Acesso a `clientes` | `Seq Scan` (tabela inteira) | `Bitmap Heap Scan` usando `idx_clientes_telefone_trgm` |
| Linhas lidas para devolver 5 | 50.000 | 5 |
| Páginas lidas | 705 | 18 |
| Tempo de execução | ~3 ms | ~0,09 ms |
| Resultado | 5 linhas | as mesmas 5 linhas |

### Verificação automatizada

O `npm run validate` (e a CI) repete esta verificação a cada execução, numa transação desfeita no fim:

1. confere que, sem a correção, `clientes` é lida com `Seq Scan`;
2. aplica a tentativa (o índice B-tree), confere que **nada muda** (ainda `Seq Scan`) e a desfaz;
3. aplica o [`correcao.sql`](correcao.sql) e confere que `clientes` passa a ser lida com `Bitmap Heap Scan usando idx_clientes_telefone_trgm`;
4. confere que a busca devolve **exatamente o mesmo resultado** antes e depois (quantidade de linhas e `md5` do conteúdo).

## 6. Recomendações

- **Aplicar a correção em produção** com `CREATE INDEX CONCURRENTLY`, depois de criar a extensão. O `pg_trgm` é uma extensão marcada como confiável (*trusted*): não precisa de superusuário, basta a permissão `CREATE` no banco.
- **Avaliar o índice B-tree da tentativa:** ele não serve para esta busca. Se nenhuma outra consulta busca pelo começo do telefone (passo 2), é um índice a mais para manter em cada escrita.
- **Exigir pelo menos 3 dígitos na tela de atendimento** (passo 6). Abaixo disso, nenhum índice ajuda, e a lista de resultados fica grande demais para o atendente.
- **Alternativa mais enxuta, se a busca for sempre pelo final:** guardar os últimos dígitos numa coluna própria (ou num índice de expressão sobre `right(telefone, 4)`) e buscar por igualdade, com um B-tree comum. É mais simples e menor, mas só atende esse formato de busca, enquanto o de trigramas atende qualquer trecho.
