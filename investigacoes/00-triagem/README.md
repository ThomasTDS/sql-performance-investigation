# Investigação 00 — Triagem: encontrar as consultas lentas

| | |
|---|---|
| **Pergunta** | Entre todas as consultas que a aplicação faz, quais mais pesam no banco? |
| **Ferramenta** | Extensão `pg_stat_statements`, que acumula, para cada consulta, quantas vezes foi executada, quanto tempo levou e quantos blocos leu |
| **Resultado** | As três consultas do topo são as das investigações [01](../01-fk-sem-indice/README.md), [02](../02-indice-ignorado/README.md) e [03](../03-paginacao-offset/README.md). As consultas pela chave primária, mesmo executadas 10 vezes mais, ficam no fim da lista |
| **Próximo passo** | `EXPLAIN (ANALYZE, BUFFERS)` em cada consulta do topo, que é o que cada investigação faz |

Arquivos desta investigação:

- [`ranking.sql`](ranking.sql): a consulta à `pg_stat_statements` que monta o ranking.
- [`../../scripts/carga.js`](../../scripts/carga.js): a carga simulada da aplicação, com as consultas e quantas vezes cada uma é executada.

> **Sobre os tempos:** foram medidos num notebook com Windows e variam de máquina para máquina e entre execuções. Os **blocos lidos** variam muito menos: dependem dos planos, não da velocidade da máquina. Por isso, a CI confere o ranking por blocos.

---

## 1. Por que começar por aqui

Nas investigações 01 a 03, o chamado já chega apontando uma consulta. Na prática, o ponto de partida costuma ser mais vago: "o banco está pesado", "a CPU está alta", "a aplicação ficou lenta". Antes de otimizar qualquer coisa, é preciso descobrir **quais consultas** respondem pela maior parte do trabalho do banco.

Olhar só a consulta mais lenta engana. Uma consulta de 1 segundo que roda uma vez por dia pesa menos que uma de 30 ms que roda a cada login. O que importa é o **tempo total**: execuções × tempo médio.

## 2. Como funciona a `pg_stat_statements`

A extensão registra cada consulta executada, agrupando as execuções que só diferem nos valores. Para isso, ela troca as constantes por parâmetros no texto registrado. As 60 buscas por email da carga, cada uma com um email diferente, viram uma única linha:

```sql
SELECT id, nome, email, status FROM clientes WHERE lower(email) = lower($1)
```

Ela precisa ser carregada na inicialização do servidor e criada no banco:

```
# postgresql.conf (no docker-compose.yml deste projeto, via "command")
shared_preload_libraries = 'pg_stat_statements'
```

```sql
CREATE EXTENSION pg_stat_statements;
SELECT pg_stat_statements_reset();  -- zera as estatísticas acumuladas
```

## 3. A carga simulada

Para ter o que medir, o [`scripts/carga.js`](../../scripts/carga.js) executa as consultas da aplicação com parâmetros variados, como um dia de uso em escala reduzida. A carga roda sobre o banco **antes de qualquer correção** (sem os índices das investigações):

| Consulta | Execuções | Investigação |
|---|---:|---|
| Pedido pela chave primária | 200 | — |
| Cliente pela chave primária | 100 | — |
| Produtos de uma categoria | 100 | — |
| Busca de cliente por email (login) | 60 | [02](../02-indice-ignorado/README.md) |
| Itens do pedido (tela "Detalhes do pedido") | 20 | [01](../01-fk-sem-indice/README.md) |
| Listagem de pedidos (backoffice) | 20 | [03](../03-paginacao-offset/README.md) |

Na listagem, 16 das 20 execuções são das primeiras páginas, e 4 vêm da exportação, que passa pelas páginas finais.

## 4. O ranking

Resultado do [`ranking.sql`](ranking.sql) depois da carga, ordenado pelo **tempo total**:

| # | Consulta | Execuções | Tempo total | Tempo médio | Blocos lidos | Blocos por execução | Linhas devolvidas |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1 | Listagem de pedidos (03) | 20 | 1.286 ms | 64,3 ms | 85.516 | 4.275 | 400 |
| 2 | Itens do pedido (01) | 20 | 1.093 ms | 54,6 ms | 191.421 | 9.571 | 67 |
| 3 | Busca por email (02) | 60 | 391 ms | 6,5 ms | 42.300 | 705 | 60 |
| 4 | Produtos de uma categoria | 100 | 16 ms | 0,16 ms | 1.600 | 16 | 20.000 |
| 5 | Cliente pela chave primária | 100 | 6,8 ms | 0,07 ms | 300 | 3 | 100 |
| 6 | Pedido pela chave primária | 200 | 1,5 ms | 0,01 ms | 800 | 4 | 200 |

Como ler:

- **As três primeiras somam mais de 99% do tempo total.** São as candidatas a investigação, e cada uma virou uma das investigações 01 a 03.
- **As consultas pela chave primária são as mais executadas** (200 e 100 vezes) e quase não pesam: leem 3 a 4 blocos por execução, o caminho do índice até a linha.
- **Blocos lidos × linhas devolvidas é o sinal mais forte de índice faltando:**
  - itens do pedido: 191 mil blocos para devolver 67 linhas (~2.900 blocos por linha);
  - busca por email: 705 blocos para devolver 1 linha;
  - listagem: 4.275 blocos para devolver 20 linhas.
- **`Seq Scan` não é sinônimo de problema.** A consulta de produtos lê a tabela `produtos` inteira a cada execução, mas a tabela tem 16 blocos (2 mil linhas): são 16 blocos para devolver 200 linhas. Criar um índice ali não traria ganho perceptível.

### Tempo ou blocos?

O tempo total é o critério usado no dia a dia, mas a **ordem** entre consultas próximas muda com a máquina e com a carga do momento. No protótipo desta triagem, com outra proporção de execuções, a ordem por tempo foi 03, 02, 01. Nesta execução, foi 03, 01, 02. Já a ordem por **blocos lidos** foi a mesma em todas as execuções (01, 03, 02): depende dos planos, não da velocidade da máquina. As consultas com plano paralelo oscilam algumas unidades (191.421 numa execução, 191.430 em outra), mas a distância entre as posições é de dezenas de milhares de blocos.

## 5. Verificação automatizada

O `npm run validate` (e a CI) executa a mesma carga num PostgreSQL com a `pg_stat_statements` carregada e confere que:

1. todas as consultas da carga foram registradas, cada uma com a quantidade certa de execuções;
2. as três consultas que mais leem blocos são, em ordem, as das investigações 01, 03 e 02.

Se uma consulta rápida passasse a ser executada a ponto de ler mais blocos que as investigações, ou se um índice do schema base acelerasse uma delas, o ranking mudaria e a validação falharia. Isso foi testado: com a consulta de produtos executada 15 mil vezes, ela assume o primeiro lugar e a validação acusa.

## 6. Como reproduzir

Com o banco do Docker Compose no ar (`docker compose up -d --wait`):

```bash
npm run triagem
```

Sem Docker, num PostgreSQL embarcado temporário (gera o volume antes, uns 30 segundos a mais):

```bash
npm run triagem -- --embarcado
```

O script zera as estatísticas, executa a carga e mostra o ranking do [`ranking.sql`](ranking.sql). Se o banco do Docker tiver sido criado antes de a `pg_stat_statements` ser incluída no `docker-compose.yml`, recrie-o com `docker compose down -v && docker compose up -d --wait`.

## 7. Recomendações para uso em produção

- **Manter a `pg_stat_statements` sempre ativa.** O custo é baixo, e sem ela a triagem depende de palpites.
- **Comparar janelas de tempo, e não só o acumulado:** salvar um retrato periódico da view (por exemplo, a cada hora) e olhar a diferença entre dois retratos. O acumulado desde o último *reset* mistura o comportamento de hoje com o de semanas atrás.
- **Ligar `track_io_timing`** para separar o tempo gasto lendo disco do tempo de CPU (colunas `blk_read_time` e `blk_write_time`).
- **Complementar com `auto_explain`:** ela registra no log o plano das execuções que passarem de um limite de tempo. A `pg_stat_statements` diz **qual** consulta pesa, e a `auto_explain` mostra **o plano** que ela usou em produção.
