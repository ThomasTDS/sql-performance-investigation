# ⚡ SQL Performance Investigation

![CI](https://github.com/ThomasTDS/sql-performance-investigation/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
![postgres](https://img.shields.io/badge/PostgreSQL-16-blue.svg)

**Português** | [English](README.en.md)

## Descrição

Este repositório investiga problemas de **performance** em consultas SQL num banco PostgreSQL com volume realista de dados, usando a mesma metodologia de investigação de bugs de produção: sintoma → hipóteses → evidência (planos de execução com `EXPLAIN ANALYZE`) → causa raiz → correção proposta → verificação.

É a continuação do projeto [sql-defect-investigation](https://github.com/ThomasTDS/sql-defect-investigation), que trata de **qualidade de dados** (dado errado). Aqui o dado está certo, mas a consulta está lenta.

> **Nota sobre os dados:** todo o schema e os dados deste projeto são fictícios, criados especificamente para este projeto de portfólio. Nenhuma informação de empregador atual ou anterior foi usada.

### Destaques

- **Triagem antes da otimização:** uma carga simulada da aplicação e a `pg_stat_statements` mostram quais consultas mais pesam no banco. As três do topo viram as investigações.
- **Leitura de planos de execução** (`EXPLAIN (ANALYZE, BUFFERS)`) como evidência de cada hipótese, inclusive para descartá-las.
- **Três causas clássicas de lentidão:** chave estrangeira sem índice, índice ignorado por causa de uma função na coluna e paginação com `OFFSET` alto. As correções incluem índice comum, índice de expressão e paginação por chave (*keyset*). Uma quarta investigação trata da busca por trecho do texto (`LIKE '%...'`), com um índice de trigramas (GIN).
- **Estatísticas desatualizadas:** depois de uma importação, o planejador estima 1 linha onde há 38 mil e escolhe o join errado. A investigação mostra por que o autovacuum não corrigiu sozinho e por que um índice esconderia o problema sem resolvê-lo.
- **Uma consulta lenta que também pode estar errada:** um `NOT IN` com subconsulta leva quase 10 s e não usa o índice criado para ele. A reescrita com `NOT EXISTS` leva 80 ms, mas só é equivalente porque a coluna não aceita nulos; com nulos, o `NOT IN` devolve zero linhas sem nenhum aviso.
- **Nem todo chamado é de lentidão:** uma tabela que dobra de tamanho numa noite, sem nenhuma linha nova, por causa de um job que grava linhas que não mudam. A investigação mostra por que o `VACUUM` não devolve o espaço e quanto custa o `VACUUM FULL`.
- **O risco da própria correção:** uma investigação de bloqueio mostra, com várias sessões simultâneas, por que um `CREATE INDEX` em produção trava as escritas e quais são as armadilhas do `CONCURRENTLY`.
- **Correções que "não deram certo" também documentadas:** em quatro investigações, o time já tinha criado um índice que não resolveu, e o relatório explica por quê.
- **Verificação automatizada e determinística:** a CI não confere tempos, que variam de máquina para máquina. Ela confere o formato do plano, a quantidade de linhas lidas e que a correção não muda o resultado da consulta.
- **Massa de dados reprodutível:** 2,5 milhões de linhas geradas com semente fixa, conferidas por `md5` no Windows, no Linux e em Docker.

---

## Investigações

A [investigação 00 (triagem)](investigacoes/00-triagem/README.md) é o ponto de partida: com uma carga simulada da aplicação e a extensão `pg_stat_statements`, ela mostra quais consultas mais pesam no banco. As três do topo do ranking são as investigações 01 a 03. A 04 trata do risco de aplicar uma dessas correções em produção, a 05, de um relatório que ficou lento depois de uma importação de dados, a 06, de um painel que depende da forma da consulta, e não de um índice, a 07, de uma busca por trecho que o índice comum não atende, e a 08, de uma tabela que dobrou de tamanho:

| # | Investigação | Sintoma | Causa raiz | Antes → depois |
|---|---|---|---|---|
| 01 | [Chave estrangeira sem índice](investigacoes/01-fk-sem-indice/README.md) | Itens de um pedido levam ~60 ms para devolver 2 linhas | `itens_pedido.pedido_id` sem índice: a tabela inteira (1,5 milhão de linhas) é lida a cada consulta | `Seq Scan` ~57 ms → `Index Scan` ~0,05 ms |
| 02 | [Índice ignorado por causa de uma função](investigacoes/02-indice-ignorado/README.md) | A busca por email continua lenta mesmo depois de criarem um índice em `email` | A consulta filtra por `lower(email)`, que o índice comum não contém | `Seq Scan` ~7 ms → `Index Scan` ~0,01 ms |
| 03 | [Paginação com OFFSET alto](investigacoes/03-paginacao-offset/README.md) | As primeiras páginas da listagem de pedidos são instantâneas, mas as últimas são lentas, mesmo com índice | `OFFSET` lê e descarta todas as linhas anteriores à página | 400.500 linhas lidas (~660 ms) → 20 linhas (~0,08 ms), com paginação por chave |
| 04 | [Bloqueio causado pelo CREATE INDEX](investigacoes/04-bloqueio-create-index/README.md) | A gravação de pedidos parou durante a migração que aplicava a correção da investigação 01 | `CREATE INDEX` comum segura um `ShareLock`, que bloqueia `INSERT`, `UPDATE` e `DELETE` | Escrita bloqueada → escrita liberada, com `CONCURRENTLY` (e as armadilhas dele) |
| 05 | [Estatísticas desatualizadas depois de uma importação](investigacoes/05-estatisticas-desatualizadas/README.md) | O relatório de vendas por equipe de janeiro leva quase 1 s; o de dezembro, ~70 ms | As estatísticas não conhecem os 40 mil pedidos importados: o planejador estima 1 linha e escolhe um `Nested Loop` | `Nested Loop` ~960 ms → `Hash Join` ~67 ms, com `ANALYZE` |
| 06 | [NOT IN com subconsulta](investigacoes/06-not-in-subconsulta/README.md) | O painel de pedidos de hoje sem pagamento leva quase 10 s, mesmo depois de criarem um índice | O `NOT IN` não vira join: a lista de 487 mil pagamentos é percorrida para cada pedido do dia, e o índice não é usado | `SubPlan` ~9,7 s → `Hash Anti Join` ~80 ms, com `NOT EXISTS` |
| 07 | [Busca por trecho do texto](investigacoes/07-busca-por-trecho/README.md) | A busca pelo final do telefone lê a tabela inteira de clientes, mesmo depois de criarem um índice em `telefone` | `LIKE '%-4217'` tem o curinga no começo, e o índice B-tree só atende buscas pelo começo do texto | `Seq Scan` ~3 ms → `Bitmap Heap Scan` ~0,09 ms, com um índice de trigramas (`pg_trgm`) |
| 08 | [Tabela inchada depois de um UPDATE em massa](investigacoes/08-tabela-inchada/README.md) | Alerta de disco: `pedidos` dobrou de tamanho numa noite, sem nenhum pedido novo | O job noturno grava as 500 mil linhas mesmo sem mudar nada, e cada `UPDATE` deixa uma versão antiga para trás; o `VACUUM` não devolve o espaço ao disco | 8.410 → 4.207 páginas (66 → 33 MB), com o job gravando só o que muda e um `VACUUM FULL` |

Cada investigação fica numa pasta própria, com:

- `README.md`: o relatório (sintoma → hipóteses → evidência → causa raiz → correção → verificação), com os planos de execução como evidência;
- `consulta.sql`: a consulta lenta do chamado;
- `exploracao.sql`: as queries na ordem em que foram usadas;
- `correcao.sql`: a correção proposta;
- `tentativa.sql` (opcional): uma correção tentada antes do chamado que não resolveu;
- `consulta-corrigida.sql` (opcional): a consulta reescrita, quando a correção inclui mudar a própria consulta;
- `cenario.sql` (opcional): dados que precisam existir antes do chamado, como a importação da investigação 05.

Para cada investigação, a validação abre uma transação e:

1. aplica o cenário, se houver, e confere como a consulta lê a tabela investigada **antes** da correção (por exemplo, `Seq Scan`);
2. se houver tentativa, aplica, confere que ela de fato não resolveu e a desfaz;
3. aplica a correção e confere como a consulta (ou a consulta corrigida, quando há reescrita) lê a tabela **depois** (por exemplo, `Index Scan`);
4. confere que o **resultado** é exatamente o mesmo antes e depois;
5. desfaz tudo com `ROLLBACK`, e o schema base continua sem os índices.

Quando o tipo de acesso não basta para diferenciar os cenários (por exemplo, dois `Index Scan` no mesmo índice), a validação também confere quantas linhas da tabela o plano leu. Ao contrário do tempo, esse número é determinístico. Quando a correção muda o join, e não o acesso à tabela, ela confere o tipo do join: `Nested Loop` → `Hash Join` na investigação 05, onde também confere se a estimativa de linhas do planejador está certa ou errada, e subconsulta (`SubPlan`) → `Hash Join` do tipo `Anti` na 06. Os tempos citados nos relatórios são ilustrativos: variam de máquina para máquina e, por isso, não são conferidos.

A investigação 04 (bloqueio) tem um formato próprio: `migracao.sql`, `migracao-corrigida.sql` e um `exploracao.sql` com consultas de diagnóstico para um terminal observador. A validação abre várias conexões e confere o que acontece com as escritas da aplicação enquanto a migração roda (bloqueada ou liberada), além do estado do índice no fim.

A investigação 08 (tabela inchada) também tem um formato próprio: `job.sql`, `job-corrigido.sql` e `manutencao.sql` (o `VACUUM FULL`). Como o `VACUUM` não roda dentro de uma transação, ela não é desfeita com `ROLLBACK`: a validação a executa por último e confere o tamanho de `pedidos` em cada etapa, terminando com a tabela no tamanho original e com o mesmo `md5` dos dados.

## Modelo de dados

É o mesmo CRM/ERP de vendas do projeto anterior: `clientes`, `vendedores`, `produtos`, `pedidos`, `itens_pedido` e `pagamentos` (ver [`sql/01_schema.sql`](sql/01_schema.sql)).

Propositalmente, o schema só tem os índices que o PostgreSQL cria sozinho: um por chave primária e o da restrição `UNIQUE` de `vendedores.email`. O PostgreSQL **não** cria índice para chave estrangeira. Cada índice adicional entra como correção dentro de uma investigação, com o plano de execução antes e depois como evidência. A validação falha se aparecer algum índice fora dessa lista.

### Volume de dados

O script [`sql/02_volume.sql`](sql/02_volume.sql) gera os dados dentro do próprio PostgreSQL (`generate_series`), num período fixo de 2023 a 2025:

| Tabela | Linhas |
|---|---:|
| `vendedores` | 50 |
| `produtos` | 2.000 |
| `clientes` | 50.000 |
| `pedidos` | 500.000 |
| `itens_pedido` | 1.500.939 |
| `pagamentos` | 487.490 |

O banco ocupa cerca de 210 MB. Três características guiam as investigações:

- **Os dados estão corretos.** Datas em ordem (cadastro → pedido → pagamento), total do pedido igual à soma dos itens, preço do item igual ao do catálogo e pagamento coerente com o status do pedido. A validação confere cada uma dessas regras.
- **A distribuição é desigual, como num sistema real.** 80% dos pedidos vêm de 20% dos clientes e 80% dos itens são de 20% dos produtos. Os status dos pedidos são 80% entregue, 10% confirmado, 5% pendente e 5% cancelado, e o número de pedidos cresce ano a ano.
- **A geração é reprodutível.** Uma semente fixa (`setseed`) faz o script gerar exatamente os mesmos dados em qualquer máquina. A validação compara a quantidade de linhas e uma impressão digital (`md5`) de cada tabela com os valores esperados.

Depois da carga, o [`sql/03_vacuum.sql`](sql/03_vacuum.sql) roda um `VACUUM`. Sem ele, a primeira consulta que lê cada página logo depois da carga ainda precisaria gravar as marcas de visibilidade das linhas (*hint bits*), e a primeira execução de cada investigação seria mais lenta que as seguintes. O `VACUUM` também preenche o mapa de visibilidade, que permite *Index Only Scans*.

## Pré-requisitos

- [Node.js](https://nodejs.org/) 24 ou superior (com npm).
- [Docker](https://www.docker.com/) com Docker Compose — **opcional**, apenas para quem preferir rodar o banco num container.

Não é preciso instalar o PostgreSQL: a validação baixa e executa um binário real do PostgreSQL 16 automaticamente.

## Como executar

### 1. Instalar as dependências

```bash
npm ci
```

### 2. Rodar a validação

```bash
npm run validate
```

O script sobe um PostgreSQL 16 temporário (porta `5433`), executa as verificações em cinco etapas e, ao final, derruba o banco e apaga os dados:

1. **Ambiente:** versão (16), codificação (`UTF8`) e locale (`C`) do banco.
2. **Schema:** tabelas e índices esperados.
3. **Volume de dados:** quantidade de linhas, reprodutibilidade (`md5`), coerência entre as tabelas e o mapa de visibilidade preenchido pelo `VACUUM`.
4. **Triagem:** executa a carga simulada e confere que as três consultas que mais leem blocos, segundo a `pg_stat_statements`, são as das investigações.
5. **Investigações:** plano antes e depois de cada correção e resultado idêntico.

A execução completa leva um pouco mais de 1 minuto, a maior parte na geração do volume e na consulta lenta da investigação 06 (cerca de 10 segundos).

> **Por que locale `C`?** O locale muda planos de execução: com um locale diferente de `C`, por exemplo, um índice B-tree comum não atende `LIKE 'abc%'`. Por isso, o banco embarcado e o do Docker são criados com `UTF8` e locale `C`, e os planos ficam iguais em qualquer máquina. No Windows, se o projeto estiver numa pasta com acento, o script contorna automaticamente uma limitação do `initdb` com esses caminhos.

### Alternativa: banco com Docker Compose

```bash
docker compose up -d --wait
```

Sobe um PostgreSQL 16 na porta `5432` (usuário e senha `postgres`, banco `performance_investigation`) e executa, na criação, os scripts da pasta `sql/`, inclusive a geração do volume. Por isso, o `--wait` leva alguns segundos a mais na primeira subida. Para derrubar o banco e apagar os dados:

```bash
docker compose down -v
```

### Reproduzir uma investigação

Com o banco do Docker Compose no ar, cada relatório pode ser refeito passo a passo. O `exploracao.sql` traz as queries na ordem dos passos do relatório e desfaz, no fim, tudo o que criou (na investigação 08, que não pode usar `ROLLBACK`, ele termina com a tabela no tamanho original e com os mesmos dados):

```bash
docker compose exec -T postgres psql -U postgres -d performance_investigation < investigacoes/01-fk-sem-indice/exploracao.sql
```

Na investigação 05, o `exploracao.sql` começa incluindo o `cenario.sql` (a importação), que o `docker-compose.yml` deixa disponível no container em `/investigacoes`. Se o container foi criado antes dessa montagem existir, recrie-o com `docker compose up -d --wait` (os dados são mantidos).

Na investigação 04 (bloqueio), o `exploracao.sql` traz só consultas de diagnóstico: o roteiro completo usa três terminais `psql` simultâneos e está no [relatório](investigacoes/04-bloqueio-create-index/README.md).

Para explorar interativamente, abra um `psql` no container (`docker compose exec postgres psql -U postgres -d performance_investigation`) ou conecte qualquer cliente SQL em `localhost:5432`, com usuário e senha `postgres`. Os tempos de execução vão variar em relação aos dos relatórios, mas o formato dos planos e as quantidades de linhas lidas devem ser os mesmos.

### Rodar a triagem

```bash
npm run triagem                  # no banco do Docker Compose
npm run triagem -- --embarcado   # sem Docker, num PostgreSQL temporário
```

Zera as estatísticas da `pg_stat_statements`, executa a carga simulada da aplicação e mostra o ranking das consultas que mais pesam no banco (ver a [investigação 00](investigacoes/00-triagem/README.md)).

### Medir os tempos

```bash
npm run medir
```

Mede cada cenário das investigações 01 a 03 e 05 a 07 (antes, tentativa e depois: mediana de 5 execuções, ou de 3 nas consultas que passam de 5 s, linhas lidas e buffers) e grava [`investigacoes/MEDICOES.md`](investigacoes/MEDICOES.md), com a data, o sistema, a CPU e a versão do PostgreSQL. Os tempos citados nos relatórios são aproximados. Esse arquivo é o registro padronizado, e para atualizá-lo basta rodar o script de novo.

## Integração contínua

A cada pull request e a cada push na `main`, o GitHub Actions executa:

- **Validação (Postgres embarcado):** `npm ci` e `npm run validate`, no Linux. Em seguida, `npm run medir` mostra a tabela de medições no resumo da execução, como referência de uma máquina Linux padronizada. Os tempos não são conferidos.
- **Docker Compose:** sobe o banco pelo `docker-compose.yml` e confere a codificação, o locale, o `VACUUM` e, para cada tabela, a quantidade de linhas e o `md5`. Depois, executa cada `exploracao.sql` com `psql -v ON_ERROR_STOP=1` e roda o `npm run triagem` no banco do container. Se qualquer query de um relatório falhar, o job falha.
- **PostgreSQL 17 e 18 (informativo):** a mesma validação, com o PostgreSQL embarcado nas versões 17 e 18, para mostrar o que mudaria num upgrade. Esses dois jobs não bloqueiam o merge. Hoje, as 78 conferências passam nas três versões: os planos, as linhas lidas, o ranking da triagem e o comportamento dos bloqueios são os mesmos.

Os jobs comparam os dados com os mesmos valores esperados, gerados originalmente no Windows. Assim, a CI garante que o volume é idêntico no Linux, no container e nas outras versões do PostgreSQL. O resultado de cada conferência aparece no resumo da execução, na aba **Actions**.

## Estrutura do repositório

```
.
├── .github/
│   ├── dependabot.yml         # atualizações mensais de dependências
│   └── workflows/ci.yml       # integração contínua (GitHub Actions)
├── docker-compose.yml         # PostgreSQL 16 em container (opcional)
├── investigacoes/
│   ├── 00-triagem/            # relatório e ranking da pg_stat_statements
│   ├── 01-fk-sem-indice/      # relatório, consulta, exploração e correção
│   ├── 02-indice-ignorado/    # idem, mais a tentativa anterior ao chamado
│   ├── 03-paginacao-offset/   # idem, mais a consulta reescrita
│   ├── 04-bloqueio-create-index/  # migração, migração corrigida e diagnóstico de bloqueio
│   ├── 05-estatisticas-desatualizadas/  # relatório, cenário (importação), consulta, exploração e correção
│   ├── 06-not-in-subconsulta/ # relatório, consulta, tentativa, exploração e consulta reescrita
│   ├── 07-busca-por-trecho/   # relatório, consulta, tentativa, exploração e correção
│   ├── 08-tabela-inchada/     # relatório, job antigo, job corrigido, manutenção e exploração
│   └── MEDICOES.md            # tempos medidos (gerado por npm run medir)
├── package.json
├── scripts/
│   ├── carga.js               # carga simulada da aplicação (triagem)
│   ├── investigacoes.js       # configuração das investigações de plano e leitura dos planos
│   ├── medir.js               # npm run medir
│   ├── postgres-embarcado.js  # sobe e derruba o PostgreSQL embarcado
│   ├── triagem.js             # npm run triagem
│   └── validate.js            # validação executada localmente e na CI
└── sql/
    ├── 01_schema.sql          # tabelas do CRM/ERP, sem índices além dos automáticos
    ├── 02_volume.sql          # geração reprodutível do volume de dados
    └── 03_vacuum.sql          # VACUUM depois da carga
```

---

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](LICENSE) para mais detalhes.
