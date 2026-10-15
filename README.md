# ⚡ SQL Performance Investigation

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![postgres](https://img.shields.io/badge/PostgreSQL-16-blue.svg)

> 🚧 **Projeto em construção.** Este README será completado a cada etapa.

## Descrição

Este repositório investiga problemas de **performance** em consultas SQL num banco PostgreSQL com volume realista de dados, usando a mesma metodologia de investigação de bugs de produção: sintoma → hipóteses → evidência (planos de execução com `EXPLAIN ANALYZE`) → causa raiz → correção proposta → verificação.

É a continuação do projeto [sql-defect-investigation](https://github.com/ThomasTDS/sql-defect-investigation), que trata de **qualidade de dados** (dado errado). Aqui o dado está certo, mas a consulta está lenta.

> **Nota sobre os dados:** todo o schema e os dados deste projeto são fictícios, criados especificamente para este projeto de portfólio. Nenhuma informação de empregador atual ou anterior foi usada.

---

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

O script sobe um PostgreSQL 16 temporário (porta `5433`), executa as verificações e, ao final, derruba o banco e apaga os dados. Nesta etapa, ele confere apenas que o ambiente está pronto (o banco sobe e a versão é a 16).

### Alternativa: banco com Docker Compose

```bash
docker compose up -d --wait
```

Sobe um PostgreSQL 16 na porta `5432` (usuário e senha `postgres`, banco `performance_investigation`) e executa, na criação, os scripts da pasta `sql/`. Para derrubar o banco e apagar os dados:

```bash
docker compose down -v
```

## Estrutura do repositório

```
.
├── docker-compose.yml         # PostgreSQL 16 em container (opcional)
├── package.json
├── scripts/
│   ├── postgres-embarcado.js  # sobe e derruba o PostgreSQL embarcado
│   └── validate.js            # validação executada localmente e na CI
└── sql/                       # scripts de schema e dados (próximas etapas)
```

---

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](LICENSE) para mais detalhes.
