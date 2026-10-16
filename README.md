# ⚡ SQL Performance Investigation

![CI](https://github.com/ThomasTDS/sql-performance-investigation/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
![postgres](https://img.shields.io/badge/PostgreSQL-16-blue.svg)

## Descrição

Este repositório investiga problemas de **performance** em consultas SQL num banco PostgreSQL com volume realista de dados, usando a mesma metodologia de investigação de bugs de produção: sintoma → hipóteses → evidência (planos de execução com `EXPLAIN ANALYZE`) → causa raiz → correção proposta → verificação.

É a continuação do projeto [sql-defect-investigation](https://github.com/ThomasTDS/sql-defect-investigation), que trata de **qualidade de dados** (dado errado). Aqui o dado está certo, mas a consulta está lenta.

> **Nota sobre os dados:** todo o schema e os dados deste projeto são fictícios, criados especificamente para este projeto de portfólio. Nenhuma informação de empregador atual ou anterior foi usada.

### Destaques

- **Leitura de planos de execução** (`EXPLAIN (ANALYZE, BUFFERS)`) como evidência de cada hipótese, inclusive para descartá-las.
- **Três causas clássicas de lentidão:** chave estrangeira sem índice, índice ignorado por causa de uma função na coluna e paginação com `OFFSET` alto. As correções incluem índice comum, índice de expressão e paginação por chave (*keyset*).
- **Correções que "não deram certo" também documentadas:** em duas investigações, o time já tinha criado um índice que não resolveu, e o relatório explica por quê.
- **Verificação automatizada e determinística:** a CI não confere tempos, que variam de máquina para máquina. Ela confere o formato do plano, a quantidade de linhas lidas e que a correção não muda o resultado da consulta.
- **Massa de dados reprodutível:** 2,5 milhões de linhas geradas com semente fixa, conferidas por `md5` no Windows, no Linux e em Docker.

---

## Investigações

| # | Investigação | Sintoma | Causa raiz | Antes → depois |
|---|---|---|---|---|
| 01 | [Chave estrangeira sem índice](investigacoes/01-fk-sem-indice/README.md) | Itens de um pedido levam ~60 ms para devolver 2 linhas | `itens_pedido.pedido_id` sem índice: a tabela inteira (1,5 milhão de linhas) é lida a cada consulta | `Seq Scan` ~57 ms → `Index Scan` ~0,05 ms |
| 02 | [Índice ignorado por causa de uma função](investigacoes/02-indice-ignorado/README.md) | A busca por email continua lenta mesmo depois de criarem um índice em `email` | A consulta filtra por `lower(email)`, que o índice comum não contém | `Seq Scan` ~7 ms → `Index Scan` ~0,01 ms |
| 03 | [Paginação com OFFSET alto](investigacoes/03-paginacao-offset/README.md) | As primeiras páginas da listagem de pedidos são instantâneas, mas as últimas são lentas, mesmo com índice | `OFFSET` lê e descarta todas as linhas anteriores à página | 400.500 linhas lidas (~660 ms) → 20 linhas (~0,08 ms), com paginação por chave |

Cada investigação fica numa pasta própria, com:

- `README.md`: o relatório (sintoma → hipóteses → evidência → causa raiz → correção → verificação), com os planos de execução como evidência;
- `consulta.sql`: a consulta lenta do chamado;
- `exploracao.sql`: as queries na ordem em que foram usadas;
- `correcao.sql`: a correção proposta;
- `tentativa.sql` (opcional): uma correção tentada antes do chamado que não resolveu;
- `consulta-corrigida.sql` (opcional): a consulta reescrita, quando a correção inclui mudar a própria consulta.

Para cada investigação, a validação abre uma transação e:

1. confere como a consulta lê a tabela investigada **antes** da correção (por exemplo, `Seq Scan`);
2. se houver tentativa, aplica, confere que ela de fato não resolveu e a desfaz;
3. aplica a correção e confere como a consulta (ou a consulta corrigida, quando há reescrita) lê a tabela **depois** (por exemplo, `Index Scan`);
4. confere que o **resultado** é exatamente o mesmo antes e depois;
5. desfaz tudo com `ROLLBACK`, e o schema base continua sem os índices.

Quando o tipo de acesso não basta para diferenciar os cenários (por exemplo, dois `Index Scan` no mesmo índice), a validação também confere quantas linhas da tabela o plano leu. Ao contrário do tempo, esse número é determinístico. Os tempos citados nos relatórios são ilustrativos: variam de máquina para máquina e, por isso, não são conferidos.

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

O script sobe um PostgreSQL 16 temporário (porta `5433`), executa as verificações em quatro etapas e, ao final, derruba o banco e apaga os dados:

1. **Ambiente:** versão (16), codificação (`UTF8`) e locale (`C`) do banco.
2. **Schema:** tabelas e índices esperados.
3. **Volume de dados:** quantidade de linhas, reprodutibilidade (`md5`) e coerência entre as tabelas.
4. **Investigações:** plano antes e depois de cada correção e resultado idêntico.

A execução completa leva cerca de 30 segundos, a maior parte na geração do volume.

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

Com o banco do Docker Compose no ar, cada relatório pode ser refeito passo a passo. O `exploracao.sql` traz as queries na ordem dos passos do relatório e desfaz, no fim, tudo o que criou:

```bash
docker compose exec -T postgres psql -U postgres -d performance_investigation < investigacoes/01-fk-sem-indice/exploracao.sql
```

Para explorar interativamente, abra um `psql` no container (`docker compose exec postgres psql -U postgres -d performance_investigation`) ou conecte qualquer cliente SQL em `localhost:5432`, com usuário e senha `postgres`. Os tempos de execução vão variar em relação aos dos relatórios, mas o formato dos planos e as quantidades de linhas lidas devem ser os mesmos.

## Integração contínua

A cada pull request e a cada push na `main`, o GitHub Actions executa dois jobs:

- **Validação (Postgres embarcado):** `npm ci` e `npm run validate`, no Linux.
- **Docker Compose:** sobe o banco pelo `docker-compose.yml`, confere a codificação, o locale e, para cada tabela, a quantidade de linhas e o `md5` e executa cada `exploracao.sql` com `psql -v ON_ERROR_STOP=1`. Se qualquer query de um relatório falhar, o job falha.

Os dois jobs comparam os dados com os mesmos valores esperados, gerados originalmente no Windows. Assim, a CI garante que o volume é idêntico no Linux e no container. O resultado de cada conferência aparece no resumo da execução, na aba **Actions**.

## Estrutura do repositório

```
.
├── .github/
│   ├── dependabot.yml         # atualizações mensais de dependências
│   └── workflows/ci.yml       # integração contínua (GitHub Actions)
├── docker-compose.yml         # PostgreSQL 16 em container (opcional)
├── investigacoes/
│   ├── 01-fk-sem-indice/      # relatório, consulta, exploração e correção
│   ├── 02-indice-ignorado/    # idem, mais a tentativa anterior ao chamado
│   └── 03-paginacao-offset/   # idem, mais a consulta reescrita
├── package.json
├── scripts/
│   ├── postgres-embarcado.js  # sobe e derruba o PostgreSQL embarcado
│   └── validate.js            # validação executada localmente e na CI
└── sql/
    ├── 01_schema.sql          # tabelas do CRM/ERP, sem índices além dos automáticos
    └── 02_volume.sql          # geração reprodutível do volume de dados
```

---

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](LICENSE) para mais detalhes.
