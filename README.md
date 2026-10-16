# ⚡ SQL Performance Investigation

![CI](https://github.com/ThomasTDS/sql-performance-investigation/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
![postgres](https://img.shields.io/badge/PostgreSQL-16-blue.svg)

> 🚧 **Projeto em construção.** Este README será completado a cada etapa.

## Descrição

Este repositório investiga problemas de **performance** em consultas SQL num banco PostgreSQL com volume realista de dados, usando a mesma metodologia de investigação de bugs de produção: sintoma → hipóteses → evidência (planos de execução com `EXPLAIN ANALYZE`) → causa raiz → correção proposta → verificação.

É a continuação do projeto [sql-defect-investigation](https://github.com/ThomasTDS/sql-defect-investigation), que trata de **qualidade de dados** (dado errado). Aqui o dado está certo, mas a consulta está lenta.

> **Nota sobre os dados:** todo o schema e os dados deste projeto são fictícios, criados especificamente para este projeto de portfólio. Nenhuma informação de empregador atual ou anterior foi usada.

---

## Investigações

| # | Investigação | Sintoma | Causa raiz | Antes → depois |
|---|---|---|---|---|
| 01 | [Chave estrangeira sem índice](investigacoes/01-fk-sem-indice/README.md) | Itens de um pedido levam ~60 ms para devolver 2 linhas | `itens_pedido.pedido_id` sem índice: a tabela inteira (1,5 milhão de linhas) é lida a cada consulta | `Seq Scan` ~57 ms → `Index Scan` ~0,05 ms |
| 02 | [Índice ignorado por causa de uma função](investigacoes/02-indice-ignorado/README.md) | A busca por email continua lenta mesmo depois de criarem um índice em `email` | A consulta filtra por `lower(email)`, que o índice comum não contém | `Seq Scan` ~7 ms → `Index Scan` ~0,01 ms |

Cada investigação fica numa pasta própria, com:

- `README.md`: o relatório (sintoma → hipóteses → evidência → causa raiz → correção → verificação), com os planos de execução como evidência;
- `consulta.sql`: a consulta lenta do chamado;
- `exploracao.sql`: as queries na ordem em que foram usadas;
- `correcao.sql`: a correção proposta;
- `tentativa.sql` (opcional): uma correção tentada antes do chamado que não resolveu.

A validação aplica cada correção dentro de uma transação e confere o formato do plano antes e depois (por exemplo, `Seq Scan` → `Index Scan`) e que o resultado da consulta não mudou. Quando existe uma tentativa, a validação confere também que ela, de fato, não mudou o plano. No fim, faz `ROLLBACK`, e o schema base continua sem os índices. Os tempos citados nos relatórios são ilustrativos: variam de máquina para máquina e, por isso, não são conferidos.

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

O script sobe um PostgreSQL 16 temporário (porta `5433`), executa as verificações e, ao final, derruba o banco e apaga os dados. Ele confere a versão (16), a codificação (`UTF8`) e o locale (`C`) do banco, carrega o schema, verifica as tabelas e os índices gera o volume de dados e confere a quantidade de linhas, a reprodutibilidade e a coerência dos dados e, por fim, verifica cada investigação (plano antes e depois da correção e resultado idêntico). A execução completa leva cerca de 30 segundos, a maior parte na geração do volume.

> **Por que locale `C`?** O locale muda planos de execução: com um locale diferente de `C`, por exemplo, um índice B-tree comum não atende `LIKE 'abc%'`. Por isso, o banco embarcado e o do Docker são criados com `UTF8` e locale `C`, e os planos ficam iguais em qualquer máquina. No Windows, se o projeto estiver numa pasta com acento, o script contorna automaticamente uma limitação do `initdb` com esses caminhos.

### Alternativa: banco com Docker Compose

```bash
docker compose up -d --wait
```

Sobe um PostgreSQL 16 na porta `5432` (usuário e senha `postgres`, banco `performance_investigation`) e executa, na criação, os scripts da pasta `sql/`, inclusive a geração do volume. Por isso, o `--wait` leva alguns segundos a mais na primeira subida. Para derrubar o banco e apagar os dados:

```bash
docker compose down -v
```

## Integração contínua

A cada pull request e a cada push na `main`, o GitHub Actions executa dois jobs:

- **Validação (Postgres embarcado):** `npm ci` e `npm run validate`, no Linux.
- **Docker Compose:** sobe o banco pelo `docker-compose.yml` e confere a codificação, o locale e, para cada tabela, a quantidade de linhas e o `md5`.

Os dois jobs comparam os dados com os mesmos valores esperados. Assim, a CI garante que o volume gerado é idêntico no Windows, no Linux e no container. O resultado de cada conferência aparece no resumo da execução, na aba **Actions**.

## Estrutura do repositório

```
.
├── .github/workflows/ci.yml   # integração contínua (GitHub Actions)
├── docker-compose.yml         # PostgreSQL 16 em container (opcional)
├── investigacoes/
│   ├── 01-fk-sem-indice/      # relatório, consulta, exploração e correção
│   └── 02-indice-ignorado/    # idem, mais a tentativa anterior ao chamado
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
