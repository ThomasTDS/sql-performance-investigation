# ⚡ SQL Performance Investigation

![CI](https://github.com/ThomasTDS/sql-performance-investigation/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
![postgres](https://img.shields.io/badge/PostgreSQL-16-blue.svg)

[Português](README.md) | **English**

## Description

This repository investigates **performance** problems in SQL queries on a PostgreSQL database with a realistic data volume, using the same methodology as a production bug investigation: symptom → hypotheses → evidence (execution plans with `EXPLAIN ANALYZE`) → root cause → proposed fix → verification.

It follows the [sql-defect-investigation](https://github.com/ThomasTDS/sql-defect-investigation) project, which deals with **data quality** (wrong data). Here the data is correct, but the query is slow.

> **About the language:** the investigation reports, the SQL comments and the database schema (table and column names) are in Portuguese. This page summarizes the project in English; the plans, numbers and commands in the reports can be followed without translation.

> **About the data:** the schema and all data in this project are fictitious, created specifically for this portfolio project. No information from any current or former employer was used.

### Highlights

- **Triage before optimization:** a simulated application workload and `pg_stat_statements` show which queries weigh the most on the database. The top three become the investigations.
- **Reading execution plans** (`EXPLAIN (ANALYZE, BUFFERS)`) as evidence for each hypothesis, including to rule hypotheses out.
- **Three classic causes of slowness:** a foreign key without an index, an index ignored because of a function on the column, and pagination with a large `OFFSET`. The fixes include a regular index, an expression index and keyset pagination.
- **Stale statistics:** after a data import, the planner estimates 1 row where there are 38 thousand and picks the wrong join. The investigation shows why autovacuum did not fix it on its own and why an index would hide the problem without solving it.
- **A slow query that may also be wrong:** a `NOT IN` with a subquery takes almost 10 s and does not use the index created for it. The `NOT EXISTS` rewrite takes 80 ms, but it is only equivalent because the column does not accept nulls; with nulls, `NOT IN` returns zero rows without any warning.
- **The risk of the fix itself:** a locking investigation shows, with several concurrent sessions, why a `CREATE INDEX` in production blocks writes, and what the pitfalls of `CONCURRENTLY` are.
- **Fixes that "did not work" are documented too:** in three investigations, the team had already created an index that did not help, and the report explains why.
- **Automated, deterministic verification:** the CI does not check timings, which vary from machine to machine. It checks the shape of the plan, the number of rows read, and that the fix does not change the query result.
- **Reproducible dataset:** 2.5 million rows generated with a fixed seed, checked by `md5` on Windows, on Linux and in Docker.

---

## Investigations

[Investigation 00 (triage)](investigacoes/00-triagem/README.md) is the starting point: with a simulated application workload and the `pg_stat_statements` extension, it shows which queries weigh the most on the database. The top three of the ranking are investigations 01 to 03. Investigation 04 deals with the risk of applying one of those fixes in production, 05 with a report that became slow after a data import, and 06 with a dashboard that depends on the shape of the query, not on an index:

| # | Investigation | Symptom | Root cause | Before → after |
|---|---|---|---|---|
| 01 | [Foreign key without an index](investigacoes/01-fk-sem-indice/README.md) | An order's items take ~60 ms to return 2 rows | `itens_pedido.pedido_id` has no index: the whole table (1.5 million rows) is read on every query | `Seq Scan` ~57 ms → `Index Scan` ~0.05 ms |
| 02 | [Index ignored because of a function](investigacoes/02-indice-ignorado/README.md) | The search by email is still slow even after an index on `email` was created | The query filters by `lower(email)`, which the regular index does not contain | `Seq Scan` ~7 ms → `Index Scan` ~0.01 ms |
| 03 | [Pagination with a large OFFSET](investigacoes/03-paginacao-offset/README.md) | The first pages of the order list are instant, but the last ones are slow, even with an index | `OFFSET` reads and discards every row before the page | 400,500 rows read (~660 ms) → 20 rows (~0.08 ms), with keyset pagination |
| 04 | [Locking caused by CREATE INDEX](investigacoes/04-bloqueio-create-index/README.md) | Order writes stopped during the migration that applied the fix from investigation 01 | A regular `CREATE INDEX` holds a `ShareLock`, which blocks `INSERT`, `UPDATE` and `DELETE` | Writes blocked → writes allowed, with `CONCURRENTLY` (and its pitfalls) |
| 05 | [Stale statistics after a data import](investigacoes/05-estatisticas-desatualizadas/README.md) | The January sales-by-team report takes almost 1 s; the December one, ~70 ms | The statistics do not know about the 40 thousand imported orders: the planner estimates 1 row and picks a `Nested Loop` | `Nested Loop` ~960 ms → `Hash Join` ~67 ms, with `ANALYZE` |
| 06 | [NOT IN with a subquery](investigacoes/06-not-in-subconsulta/README.md) | The "today's orders without payment" dashboard takes almost 10 s, even after an index was created | `NOT IN` does not become a join: the list of 487 thousand payments is scanned for each order of the day, and the index is not used | `SubPlan` ~9.7 s → `Hash Anti Join` ~80 ms, with `NOT EXISTS` |

Each investigation lives in its own folder, with:

- `README.md`: the report (symptom → hypotheses → evidence → root cause → fix → verification), with the execution plans as evidence;
- `consulta.sql`: the slow query from the ticket;
- `exploracao.sql`: the queries in the order they were used;
- `correcao.sql`: the proposed fix;
- `tentativa.sql` (optional): a fix attempted before the ticket that did not help;
- `consulta-corrigida.sql` (optional): the rewritten query, when the fix includes changing the query itself;
- `cenario.sql` (optional): data that must exist before the ticket, such as the import in investigation 05.

For each investigation, the validation opens a transaction and:

1. applies the scenario, if there is one, and checks how the query reads the investigated table **before** the fix (for example, `Seq Scan`);
2. if there is an attempted fix, applies it, checks that it really did not help, and undoes it;
3. applies the fix and checks how the query (or the rewritten query, when there is one) reads the table **after** it (for example, `Index Scan`);
4. checks that the **result** is exactly the same before and after;
5. undoes everything with `ROLLBACK`, so the base schema stays without the indexes.

When the access type is not enough to tell the scenarios apart (for example, two `Index Scan`s on the same index), the validation also checks how many rows of the table the plan read. Unlike timing, this number is deterministic. When the fix changes the join rather than the table access, it checks the join type: `Nested Loop` → `Hash Join` in investigation 05, where it also checks whether the planner's row estimate is right or wrong, and subquery (`SubPlan`) → an `Anti` `Hash Join` in 06. The timings quoted in the reports are illustrative: they vary from machine to machine and, for that reason, are not checked.

Investigation 04 (locking) has its own format: `migracao.sql` (the migration), `migracao-corrigida.sql` (the fixed migration) and an `exploracao.sql` with diagnostic queries for an observer terminal. The validation opens several connections and checks what happens to the application's writes while the migration runs (blocked or allowed), as well as the state of the index at the end.

## Data model

It is the same sales CRM/ERP as the previous project: `clientes` (customers), `vendedores` (salespeople), `produtos` (products), `pedidos` (orders), `itens_pedido` (order items) and `pagamentos` (payments) (see [`sql/01_schema.sql`](sql/01_schema.sql)).

On purpose, the schema only has the indexes PostgreSQL creates by itself: one per primary key, plus the one for the `UNIQUE` constraint on `vendedores.email`. PostgreSQL does **not** create indexes for foreign keys. Every additional index comes in as a fix inside an investigation, with the execution plan before and after as evidence. The validation fails if any index outside this list appears.

### Data volume

The [`sql/02_volume.sql`](sql/02_volume.sql) script generates the data inside PostgreSQL itself (`generate_series`), over a fixed period from 2023 to 2025:

| Table | Rows |
|---|---:|
| `vendedores` | 50 |
| `produtos` | 2,000 |
| `clientes` | 50,000 |
| `pedidos` | 500,000 |
| `itens_pedido` | 1,500,939 |
| `pagamentos` | 487,490 |

The database takes about 210 MB. Three characteristics guide the investigations:

- **The data is correct.** Dates are in order (sign-up → order → payment), the order total equals the sum of its items, the item price matches the catalog, and payments are consistent with the order status. The validation checks each of these rules.
- **The distribution is uneven, as in a real system.** 80% of the orders come from 20% of the customers, and 80% of the items are from 20% of the products. Order statuses are 80% delivered, 10% confirmed, 5% pending and 5% cancelled, and the number of orders grows year after year.
- **The generation is reproducible.** A fixed seed (`setseed`) makes the script generate exactly the same data on any machine. The validation compares the row count and a fingerprint (`md5`) of each table with the expected values.

After the load, [`sql/03_vacuum.sql`](sql/03_vacuum.sql) runs a `VACUUM`. Without it, the first query to read each page right after the load would still have to write the row visibility markers (*hint bits*), and the first run of each investigation would be slower than the following ones. The `VACUUM` also fills the visibility map, which enables *Index Only Scans*.

## Prerequisites

- [Node.js](https://nodejs.org/) 24 or later (with npm).
- [Docker](https://www.docker.com/) with Docker Compose — **optional**, only if you prefer to run the database in a container.

There is no need to install PostgreSQL: the validation downloads and runs a real PostgreSQL 16 binary automatically.

## How to run

### 1. Install the dependencies

```bash
npm ci
```

### 2. Run the validation

```bash
npm run validate
```

The script starts a temporary PostgreSQL 16 (port `5433`), runs the checks in five stages and, at the end, shuts the database down and deletes the data:

1. **Environment:** database version (16), encoding (`UTF8`) and locale (`C`).
2. **Schema:** expected tables and indexes.
3. **Data volume:** row counts, reproducibility (`md5`), consistency between the tables, and the visibility map filled by `VACUUM`.
4. **Triage:** runs the simulated workload and checks that the three queries that read the most blocks, according to `pg_stat_statements`, are the ones from the investigations.
5. **Investigations:** the plan before and after each fix, and an identical result.

The full run takes a little over 1 minute, most of it generating the data and running the slow query from investigation 06 (about 10 seconds).

> **Why the `C` locale?** The locale changes execution plans: with a locale other than `C`, for example, a regular B-tree index does not serve `LIKE 'abc%'`. That is why the embedded database and the Docker one are created with `UTF8` and the `C` locale, so the plans are the same on any machine. On Windows, if the project is in a folder with accented characters, the script automatically works around an `initdb` limitation with such paths.

### Alternative: database with Docker Compose

```bash
docker compose up -d --wait
```

Starts a PostgreSQL 16 on port `5432` (user and password `postgres`, database `performance_investigation`) and, on creation, runs the scripts in the `sql/` folder, including the data generation. Because of that, `--wait` takes a few extra seconds the first time. To shut the database down and delete the data:

```bash
docker compose down -v
```

### Reproduce an investigation

With the Docker Compose database running, each report can be redone step by step. `exploracao.sql` has the queries in the order of the report's steps and, at the end, undoes everything it created:

```bash
docker compose exec -T postgres psql -U postgres -d performance_investigation < investigacoes/01-fk-sem-indice/exploracao.sql
```

In investigation 05, `exploracao.sql` starts by including `cenario.sql` (the import), which `docker-compose.yml` makes available in the container at `/investigacoes`. If the container was created before this mount existed, recreate it with `docker compose up -d --wait` (the data is kept).

In investigation 04 (locking), `exploracao.sql` only has diagnostic queries: the full walkthrough uses three concurrent `psql` terminals and is in the [report](investigacoes/04-bloqueio-create-index/README.md).

To explore interactively, open a `psql` in the container (`docker compose exec postgres psql -U postgres -d performance_investigation`) or connect any SQL client to `localhost:5432`, with user and password `postgres`. Execution times will differ from those in the reports, but the shape of the plans and the number of rows read should be the same.

### Run the triage

```bash
npm run triagem                  # on the Docker Compose database
npm run triagem -- --embarcado   # without Docker, on a temporary PostgreSQL
```

Resets the `pg_stat_statements` statistics, runs the simulated application workload and shows the ranking of the queries that weigh the most on the database (see [investigation 00](investigacoes/00-triagem/README.md)).

### Measure the timings

```bash
npm run medir
```

Measures each scenario of investigations 01 to 03, 05 and 06 (before, attempted fix and after: median of 5 runs, or of 3 for queries that take over 5 s, rows read and buffers) and writes [`investigacoes/MEDICOES.md`](investigacoes/MEDICOES.md), with the date, operating system, CPU and PostgreSQL version. The timings quoted in the reports are approximate. That file is the standardized record, and to update it you just run the script again.

## Continuous integration

On every pull request and every push to `main`, GitHub Actions runs:

- **Validação (Postgres embarcado)** (validation, embedded Postgres): `npm ci` and `npm run validate`, on Linux. Then `npm run medir` shows the measurements table in the run summary, as a reference from a standardized Linux machine. The timings are not checked.
- **Docker Compose:** starts the database from `docker-compose.yml` and checks the encoding, the locale, the `VACUUM` and, for each table, the row count and the `md5`. Then it runs every `exploracao.sql` with `psql -v ON_ERROR_STOP=1` and runs `npm run triagem` on the container's database. If any query from a report fails, the job fails.
- **PostgreSQL 17 and 18 (informativo)** (informational): the same validation, with the embedded PostgreSQL in versions 17 and 18, to show what would change in an upgrade. These two jobs do not block merging. Today, all 66 checks pass on the three versions: the plans, the rows read, the triage ranking and the locking behavior are the same.

The jobs compare the data with the same expected values, originally generated on Windows. That way, the CI guarantees that the dataset is identical on Linux, in the container and in the other PostgreSQL versions. The result of each check appears in the run summary, in the **Actions** tab.

## Repository structure

```
.
├── .github/
│   ├── dependabot.yml         # monthly dependency updates
│   └── workflows/ci.yml       # continuous integration (GitHub Actions)
├── docker-compose.yml         # PostgreSQL 16 in a container (optional)
├── investigacoes/             # investigations
│   ├── 00-triagem/            # triage: report and pg_stat_statements ranking
│   ├── 01-fk-sem-indice/      # report, query, exploration and fix
│   ├── 02-indice-ignorado/    # same, plus the attempt made before the ticket
│   ├── 03-paginacao-offset/   # same, plus the rewritten query
│   ├── 04-bloqueio-create-index/  # migration, fixed migration and lock diagnostics
│   ├── 05-estatisticas-desatualizadas/  # report, scenario (import), query, exploration and fix
│   ├── 06-not-in-subconsulta/ # report, query, attempt, exploration and rewritten query
│   └── MEDICOES.md            # measured timings (generated by npm run medir)
├── package.json
├── scripts/
│   ├── carga.js               # simulated application workload (triage)
│   ├── investigacoes.js       # plan investigations config and plan reading
│   ├── medir.js               # npm run medir
│   ├── postgres-embarcado.js  # starts and stops the embedded PostgreSQL
│   ├── triagem.js             # npm run triagem
│   └── validate.js            # validation run locally and in CI
└── sql/
    ├── 01_schema.sql          # CRM/ERP tables, no indexes beyond the automatic ones
    ├── 02_volume.sql          # reproducible data generation
    └── 03_vacuum.sql          # VACUUM after the load
```

---

## License

Distributed under the MIT license. See [LICENSE](LICENSE) for details.
