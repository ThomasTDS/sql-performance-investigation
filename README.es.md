# ⚡ SQL Performance Investigation

![CI](https://github.com/ThomasTDS/sql-performance-investigation/actions/workflows/ci.yml/badge.svg)
![license](https://img.shields.io/badge/license-MIT-blue.svg)
![postgres](https://img.shields.io/badge/PostgreSQL-16-blue.svg)

[Português](README.md) | [English](README.en.md) | **Español**

## Descripción

Este repositorio investiga problemas de **rendimiento** en consultas SQL sobre una base de datos PostgreSQL con un volumen de datos realista, aplicando la misma metodología que se usa para investigar errores en producción: síntoma → hipótesis → evidencia (planes de ejecución con `EXPLAIN ANALYZE`) → causa raíz → corrección propuesta → verificación.

Es la continuación del proyecto [sql-defect-investigation](https://github.com/ThomasTDS/sql-defect-investigation), dedicado a la **calidad de los datos** (datos incorrectos). Aquí los datos son correctos, pero la consulta es lenta.

> **Sobre el idioma:** los informes de las investigaciones, los comentarios de los archivos SQL y el esquema de la base de datos (nombres de tablas y columnas) están en portugués. Esta página resume el proyecto en español; los planes, las cifras y los comandos de los informes pueden seguirse sin traducción.

> **Sobre los datos:** el esquema y todos los datos de este proyecto son ficticios y se crearon específicamente para este proyecto de portafolio. No se utilizó ninguna información de empleadores actuales o anteriores.

### Aspectos destacados

- **Triaje antes de la optimización:** una carga simulada de la aplicación y `pg_stat_statements` muestran qué consultas tienen mayor peso en la base de datos. Las tres primeras se convierten en las investigaciones.
- **Lectura de planes de ejecución** (`EXPLAIN (ANALYZE, BUFFERS)`) como evidencia de cada hipótesis, incluso para descartarlas.
- **Tres causas clásicas de lentitud:** una clave foránea sin índice, un índice ignorado por una función aplicada a la columna y la paginación con un `OFFSET` alto. Las correcciones incluyen un índice común, un índice de expresión y la paginación por clave (*keyset*). Una cuarta investigación aborda la búsqueda por un fragmento del texto (`LIKE '%...'`), con un índice de trigramas (GIN).
- **Estadísticas desactualizadas:** tras una importación, el planificador estima 1 fila donde hay 38 mil y elige el join equivocado. La investigación muestra por qué el autovacuum no lo corrigió por sí solo y por qué un índice ocultaría el problema sin resolverlo.
- **Una consulta lenta que además puede ser incorrecta:** un `NOT IN` con subconsulta tarda casi 10 s y no usa el índice creado para él. La reescritura con `NOT EXISTS` tarda 80 ms, pero solo es equivalente porque la columna no admite nulos; con nulos, el `NOT IN` devuelve cero filas sin ningún aviso.
- **No todos los tickets son de lentitud:** una tabla que duplica su tamaño en una noche, sin ninguna fila nueva, a causa de un job que graba filas que no cambian. La investigación muestra por qué `VACUUM` no devuelve el espacio y cuánto cuesta `VACUUM FULL`.
- **El riesgo de la propia corrección:** una investigación de bloqueos muestra, con varias sesiones simultáneas, por qué un `CREATE INDEX` en producción bloquea las escrituras y cuáles son las trampas de `CONCURRENTLY`.
- **También se documentan las correcciones que «no funcionaron»:** en cuatro investigaciones, el equipo ya había creado un índice que no resolvió el problema, y el informe explica por qué.
- **Verificación automatizada y determinista:** la CI no comprueba tiempos, que varían de una máquina a otra. Comprueba la forma del plan, la cantidad de filas leídas y que la corrección no cambia el resultado de la consulta.
- **Conjunto de datos reproducible:** 2,5 millones de filas generadas con una semilla fija y comprobadas mediante `md5` en Windows, en Linux y en Docker.

---

## Investigaciones

La [investigación 00 (triaje)](investigacoes/00-triagem/README.md) es el punto de partida: con una carga simulada de la aplicación y la extensión `pg_stat_statements`, muestra qué consultas tienen mayor peso en la base de datos. Las tres primeras de la clasificación son las investigaciones 01 a 03. La 04 aborda el riesgo de aplicar una de esas correcciones en producción; la 05, un informe que se volvió lento tras una importación de datos; la 06, un panel que depende de la forma de la consulta y no de un índice; la 07, una búsqueda por fragmento que un índice común no atiende; y la 08, una tabla que duplicó su tamaño:

| # | Investigación | Síntoma | Causa raíz | Antes → después |
|---|---|---|---|---|
| 01 | [Clave foránea sin índice](investigacoes/01-fk-sem-indice/README.md) | Los ítems de un pedido tardan ~60 ms en devolver 2 filas | `itens_pedido.pedido_id` no tiene índice: se lee la tabla completa (1,5 millones de filas) en cada consulta | `Seq Scan` ~57 ms → `Index Scan` ~0,05 ms |
| 02 | [Índice ignorado por una función](investigacoes/02-indice-ignorado/README.md) | La búsqueda por email sigue siendo lenta incluso después de crear un índice en `email` | La consulta filtra por `lower(email)`, que el índice común no contiene | `Seq Scan` ~7 ms → `Index Scan` ~0,01 ms |
| 03 | [Paginación con OFFSET alto](investigacoes/03-paginacao-offset/README.md) | Las primeras páginas del listado de pedidos son instantáneas, pero las últimas son lentas, incluso con índice | `OFFSET` lee y descarta todas las filas anteriores a la página | 400.500 filas leídas (~660 ms) → 20 filas (~0,08 ms), con paginación por clave |
| 04 | [Bloqueo causado por CREATE INDEX](investigacoes/04-bloqueio-create-index/README.md) | La grabación de pedidos se detuvo durante la migración que aplicaba la corrección de la investigación 01 | Un `CREATE INDEX` común mantiene un `ShareLock`, que bloquea `INSERT`, `UPDATE` y `DELETE` | Escritura bloqueada → escritura liberada, con `CONCURRENTLY` (y sus trampas) |
| 05 | [Estadísticas desactualizadas tras una importación](investigacoes/05-estatisticas-desatualizadas/README.md) | El informe de ventas por equipo de enero tarda casi 1 s; el de diciembre, ~70 ms | Las estadísticas no conocen los 40 mil pedidos importados: el planificador estima 1 fila y elige un `Nested Loop` | `Nested Loop` ~960 ms → `Hash Join` ~67 ms, con `ANALYZE` |
| 06 | [NOT IN con subconsulta](investigacoes/06-not-in-subconsulta/README.md) | El panel de pedidos de hoy sin pago tarda casi 10 s, incluso después de crear un índice | `NOT IN` no se convierte en join: la lista de 487 mil pagos se recorre por cada pedido del día, y el índice no se usa | `SubPlan` ~9,7 s → `Hash Anti Join` ~80 ms, con `NOT EXISTS` |
| 07 | [Búsqueda por fragmento del texto](investigacoes/07-busca-por-trecho/README.md) | La búsqueda por el final del teléfono lee toda la tabla de clientes, incluso después de crear un índice en `telefone` | `LIKE '%-4217'` tiene el comodín al principio, y el índice B-tree solo atiende búsquedas por el comienzo del texto | `Seq Scan` ~3 ms → `Bitmap Heap Scan` ~0,09 ms, con un índice de trigramas (`pg_trgm`) |
| 08 | [Tabla inflada tras un UPDATE masivo](investigacoes/08-tabela-inchada/README.md) | Alerta de disco: `pedidos` duplicó su tamaño en una noche, sin ningún pedido nuevo | El job nocturno graba las 500 mil filas aunque nada cambie, y cada `UPDATE` deja atrás una versión antigua; `VACUUM` no devuelve el espacio al disco | 8.410 → 4.207 páginas (66 → 33 MB), con el job grabando solo lo que cambia y un `VACUUM FULL` |

Cada investigación tiene su propia carpeta, con:

- `README.md`: el informe (síntoma → hipótesis → evidencia → causa raíz → corrección → verificación), con los planes de ejecución como evidencia;
- `consulta.sql`: la consulta lenta del ticket;
- `exploracao.sql`: las consultas en el orden en que se utilizaron;
- `correcao.sql`: la corrección propuesta;
- `tentativa.sql` (opcional): una corrección intentada antes del ticket que no resolvió el problema;
- `consulta-corrigida.sql` (opcional): la consulta reescrita, cuando la corrección incluye cambiar la propia consulta;
- `cenario.sql` (opcional): datos que deben existir antes del ticket, como la importación de la investigación 05.

Para cada investigación, la validación abre una transacción y:

1. aplica el escenario, si lo hay, y comprueba cómo lee la consulta la tabla investigada **antes** de la corrección (por ejemplo, `Seq Scan`);
2. si hay un intento previo, lo aplica, comprueba que realmente no resolvió el problema y lo deshace;
3. aplica la corrección y comprueba cómo lee la tabla la consulta (o la consulta corregida, cuando hay reescritura) **después** de ella (por ejemplo, `Index Scan`);
4. comprueba que el **resultado** es exactamente el mismo antes y después;
5. deshace todo con `ROLLBACK`, de modo que el esquema base sigue sin los índices.

Cuando el tipo de acceso no basta para diferenciar los escenarios (por ejemplo, dos `Index Scan` sobre el mismo índice), la validación también comprueba cuántas filas de la tabla leyó el plan. A diferencia del tiempo, este número es determinista. Cuando la corrección cambia el join y no el acceso a la tabla, comprueba el tipo de join: `Nested Loop` → `Hash Join` en la investigación 05, donde también comprueba si la estimación de filas del planificador es correcta o incorrecta, y subconsulta (`SubPlan`) → `Hash Join` de tipo `Anti` en la 06. Los tiempos citados en los informes son ilustrativos: varían de una máquina a otra y, por eso, no se comprueban.

La investigación 04 (bloqueo) tiene un formato propio: `migracao.sql` (la migración), `migracao-corrigida.sql` (la migración corregida) y un `exploracao.sql` con consultas de diagnóstico para un terminal observador. La validación abre varias conexiones y comprueba qué ocurre con las escrituras de la aplicación mientras se ejecuta la migración (bloqueadas o liberadas), además del estado del índice al final.

La investigación 08 (tabla inflada) también tiene un formato propio: `job.sql` (el job), `job-corrigido.sql` (el job corregido) y `manutencao.sql` (el `VACUUM FULL`). Como `VACUUM` no se ejecuta dentro de una transacción, no puede deshacerse con `ROLLBACK`: la validación la ejecuta en último lugar y comprueba el tamaño de `pedidos` en cada etapa, y termina con la tabla en su tamaño original y con el mismo `md5` de los datos.

## Modelo de datos

Es el mismo CRM/ERP de ventas del proyecto anterior: `clientes`, `vendedores`, `produtos` (productos), `pedidos`, `itens_pedido` (ítems de pedido) y `pagamentos` (pagos) (véase [`sql/01_schema.sql`](sql/01_schema.sql)).

A propósito, el esquema solo tiene los índices que PostgreSQL crea por sí mismo: uno por clave primaria y el de la restricción `UNIQUE` de `vendedores.email`. PostgreSQL **no** crea índices para las claves foráneas. Cada índice adicional se incorpora como corrección dentro de una investigación, con el plan de ejecución de antes y de después como evidencia. La validación falla si aparece algún índice fuera de esta lista.

### Volumen de datos

El script [`sql/02_volume.sql`](sql/02_volume.sql) genera los datos dentro del propio PostgreSQL (`generate_series`), en un período fijo de 2023 a 2025:

| Tabla | Filas |
|---|---:|
| `vendedores` | 50 |
| `produtos` | 2.000 |
| `clientes` | 50.000 |
| `pedidos` | 500.000 |
| `itens_pedido` | 1.500.939 |
| `pagamentos` | 487.490 |

La base de datos ocupa unos 210 MB. Tres características guían las investigaciones:

- **Los datos son correctos.** Las fechas están en orden (registro → pedido → pago), el total del pedido es igual a la suma de sus ítems, el precio del ítem coincide con el del catálogo y el pago es coherente con el estado del pedido. La validación comprueba cada una de estas reglas.
- **La distribución es desigual, como en un sistema real.** El 80 % de los pedidos proviene del 20 % de los clientes y el 80 % de los ítems corresponde al 20 % de los productos. Los estados de los pedidos son 80 % entregado, 10 % confirmado, 5 % pendiente y 5 % cancelado, y el número de pedidos crece año tras año.
- **La generación es reproducible.** Una semilla fija (`setseed`) hace que el script genere exactamente los mismos datos en cualquier máquina. La validación compara la cantidad de filas y una huella digital (`md5`) de cada tabla con los valores esperados.

Después de la carga, [`sql/03_vacuum.sql`](sql/03_vacuum.sql) ejecuta un `VACUUM`. Sin él, la primera consulta que leyera cada página justo después de la carga aún tendría que grabar las marcas de visibilidad de las filas (*hint bits*), y la primera ejecución de cada investigación sería más lenta que las siguientes. El `VACUUM` también rellena el mapa de visibilidad, que hace posibles los *Index Only Scans*.

## Requisitos previos

- [Node.js](https://nodejs.org/) 24 o superior (con npm).
- [Docker](https://www.docker.com/) con Docker Compose: **opcional**, solo para quien prefiera ejecutar la base de datos en un contenedor.

No es necesario instalar PostgreSQL: la validación descarga y ejecuta automáticamente un binario real de PostgreSQL 16.

## Cómo ejecutar

### 1. Instalar las dependencias

```bash
npm ci
```

### 2. Ejecutar la validación

```bash
npm run validate
```

El script inicia un PostgreSQL 16 temporal (puerto `5433`), ejecuta las verificaciones en cinco etapas y, al final, detiene la base de datos y borra los datos:

1. **Entorno:** versión (16), codificación (`UTF8`) y locale (`C`) de la base de datos.
2. **Esquema:** tablas e índices esperados.
3. **Volumen de datos:** cantidad de filas, reproducibilidad (`md5`), coherencia entre las tablas y mapa de visibilidad rellenado por `VACUUM`.
4. **Triaje:** ejecuta la carga simulada y comprueba que las tres consultas que más bloques leen, según `pg_stat_statements`, son las de las investigaciones.
5. **Investigaciones:** plan antes y después de cada corrección y resultado idéntico.

Cada comprobación se muestra con ✔ o ✘. Al final, un resumen indica cuántas comprobaciones tiene cada etapa y cada investigación y cuántas se superaron (el mismo resumen aparece en la parte superior de la ejecución de la CI).

La ejecución completa tarda poco más de 1 minuto, la mayor parte en la generación del volumen y en la consulta lenta de la investigación 06 (unos 10 segundos).

> **¿Por qué el locale `C`?** El locale cambia los planes de ejecución: con un locale distinto de `C`, por ejemplo, un índice B-tree común no atiende `LIKE 'abc%'`. Por eso, la base de datos embebida y la de Docker se crean con `UTF8` y locale `C`, y los planes son iguales en cualquier máquina. En Windows, si el proyecto está en una carpeta con caracteres acentuados, el script sortea automáticamente una limitación de `initdb` con esas rutas.

### Alternativa: base de datos con Docker Compose

```bash
docker compose up -d --wait
```

Inicia un PostgreSQL 16 en el puerto `5432` (usuario y contraseña `postgres`, base de datos `performance_investigation`) y, al crearse, ejecuta los scripts de la carpeta `sql/`, incluida la generación del volumen. Por eso, `--wait` tarda unos segundos más la primera vez. Para detener la base de datos y borrar los datos:

```bash
docker compose down -v
```

### Reproducir una investigación

Con la base de datos de Docker Compose en marcha, cada informe puede rehacerse paso a paso. `exploracao.sql` contiene las consultas en el orden de los pasos del informe y, al final, deshace todo lo que creó (en la investigación 08, que no puede usar `ROLLBACK`, termina con la tabla en su tamaño original y con los mismos datos):

```bash
docker compose exec -T postgres psql -U postgres -d performance_investigation < investigacoes/01-fk-sem-indice/exploracao.sql
```

En la investigación 05, `exploracao.sql` empieza incluyendo `cenario.sql` (la importación), que `docker-compose.yml` deja disponible en el contenedor en `/investigacoes`. Si el contenedor se creó antes de que existiera este montaje, recréelo con `docker compose up -d --wait` (los datos se conservan).

En la investigación 04 (bloqueo), `exploracao.sql` solo contiene consultas de diagnóstico: el procedimiento completo usa tres terminales `psql` simultáneos y está en el [informe](investigacoes/04-bloqueio-create-index/README.md).

Para explorar de forma interactiva, abra un `psql` en el contenedor (`docker compose exec postgres psql -U postgres -d performance_investigation`) o conecte cualquier cliente SQL a `localhost:5432`, con usuario y contraseña `postgres`. Los tiempos de ejecución variarán respecto a los de los informes, pero la forma de los planes y la cantidad de filas leídas deberían ser las mismas.

### Ejecutar el triaje

```bash
npm run triagem                  # en la base de datos de Docker Compose
npm run triagem -- --embarcado   # sin Docker, en un PostgreSQL temporal
```

Reinicia las estadísticas de `pg_stat_statements`, ejecuta la carga simulada de la aplicación y muestra la clasificación de las consultas que más pesan en la base de datos (véase la [investigación 00](investigacoes/00-triagem/README.md)).

### Medir los tiempos

```bash
npm run medir
```

Mide cada escenario de las investigaciones 01 a 03 y 05 a 07 (antes, intento y después: mediana de 5 ejecuciones, o de 3 en las consultas que superan los 5 s, filas leídas y buffers) y escribe [`investigacoes/MEDICOES.md`](investigacoes/MEDICOES.md), con la fecha, el sistema, la CPU y la versión de PostgreSQL. Los tiempos citados en los informes son aproximados. Ese archivo es el registro estandarizado y, para actualizarlo, basta con volver a ejecutar el script.

## Integración continua

En cada pull request y en cada push a `main`, GitHub Actions ejecuta:

- **Validação (Postgres embarcado)** (validación, Postgres embebido): `npm ci` y `npm run validate`, en Linux. A continuación, `npm run medir` muestra la tabla de mediciones en el resumen de la ejecución, como referencia de una máquina Linux estandarizada. Los tiempos no se comprueban.
- **Docker Compose:** inicia la base de datos desde `docker-compose.yml` y comprueba la codificación, el locale, el `VACUUM` y, para cada tabla, la cantidad de filas y el `md5`. Después, ejecuta cada `exploracao.sql` con `psql -v ON_ERROR_STOP=1` y ejecuta `npm run triagem` en la base de datos del contenedor. Si falla cualquier consulta de un informe, el job falla.
- **PostgreSQL 17 y 18 (informativo):** la misma validación, con el PostgreSQL embebido en las versiones 17 y 18, para mostrar qué cambiaría en una actualización. Estos dos jobs no bloquean el merge. Actualmente, las 78 comprobaciones se superan en las tres versiones: los planes, las filas leídas, la clasificación del triaje y el comportamiento de los bloqueos son los mismos.

Los jobs comparan los datos con los mismos valores esperados, generados originalmente en Windows. Así, la CI garantiza que el volumen es idéntico en Linux, en el contenedor y en las demás versiones de PostgreSQL. El resultado de cada comprobación aparece en el resumen de la ejecución, en la pestaña **Actions**.

## Estructura del repositorio

```
.
├── .github/
│   ├── dependabot.yml         # actualizaciones mensuales de dependencias
│   └── workflows/ci.yml       # integración continua (GitHub Actions)
├── docker-compose.yml         # PostgreSQL 16 en contenedor (opcional)
├── investigacoes/             # investigaciones
│   ├── 00-triagem/            # triaje: informe y clasificación de pg_stat_statements
│   ├── 01-fk-sem-indice/      # informe, consulta, exploración y corrección
│   ├── 02-indice-ignorado/    # ídem, más el intento anterior al ticket
│   ├── 03-paginacao-offset/   # ídem, más la consulta reescrita
│   ├── 04-bloqueio-create-index/  # migración, migración corregida y diagnóstico de bloqueos
│   ├── 05-estatisticas-desatualizadas/  # informe, escenario (importación), consulta, exploración y corrección
│   ├── 06-not-in-subconsulta/ # informe, consulta, intento, exploración y consulta reescrita
│   ├── 07-busca-por-trecho/   # informe, consulta, intento, exploración y corrección
│   ├── 08-tabela-inchada/     # informe, job antiguo, job corregido, mantenimiento y exploración
│   └── MEDICOES.md            # tiempos medidos (generado por npm run medir)
├── package.json
├── scripts/
│   ├── carga.js               # carga simulada de la aplicación (triaje)
│   ├── investigacoes.js       # configuración de las investigaciones de planes y lectura de los planes
│   ├── medir.js               # npm run medir
│   ├── postgres-embarcado.js  # inicia y detiene el PostgreSQL embebido
│   ├── triagem.js             # npm run triagem
│   └── validate.js            # validación ejecutada localmente y en la CI
└── sql/
    ├── 01_schema.sql          # tablas del CRM/ERP, sin índices aparte de los automáticos
    ├── 02_volume.sql          # generación reproducible del volumen de datos
    └── 03_vacuum.sql          # VACUUM después de la carga
```

---

## Licencia

Distribuido bajo la licencia MIT. Consulte [LICENSE](LICENSE) para más detalles.
