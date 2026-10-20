# Medições das investigações

> Arquivo gerado por `npm run medir`. Não edite à mão: rode o script de novo para atualizar.

- **Gerado em:** 2026-10-20
- **Sistema:** Windows_NT 10.0.26300 (x64)
- **CPU:** 13th Gen Intel(R) Core(TM) i9-13980HX · 32 núcleos
- **PostgreSQL:** 16.14 (embarcado) · **Node.js:** v24.14.0

Cada tempo é a mediana de 5 execuções com `EXPLAIN (ANALYZE, BUFFERS)`, depois de uma execução descartada para aquecer o cache. Consultas em que a primeira execução passa de 5 s são medidas só 3 vezes, sem descartar nenhuma: para elas, o aquecimento não muda o tempo. A coluna "Execuções" mostra quantas foram usadas. A faixa mostra o menor e o maior tempo. Linhas lidas e buffers são da tabela investigada e da consulta inteira, respectivamente, e quase não variam entre máquinas. Os tempos variam: numa mesma máquina, já foram observadas diferenças de até 5 vezes entre sessões.

| Investigação | Cenário | Acesso à tabela (→ join) | Linhas lidas | Buffers | Tempo (mediana) | Faixa | Execuções |
|---|---|---|---:|---:|---:|---|---:|
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | antes | `Seq Scan` | 1.500.939 | 9.568 | 77,1 ms | 72,1 ms a 169,6 ms | 5 |
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | depois | `Index Scan usando idx_itens_pedido_pedido_id` | 2 | 10 | 0,094 ms | 0,091 ms a 0,110 ms | 5 |
| [02-indice-ignorado](02-indice-ignorado/README.md) | antes | `Seq Scan` | 50.000 | 705 | 30,9 ms | 26,6 ms a 33,4 ms | 5 |
| [02-indice-ignorado](02-indice-ignorado/README.md) | tentativa | `Seq Scan` | 50.000 | 705 | 34,0 ms | 30,3 ms a 39,8 ms | 5 |
| [02-indice-ignorado](02-indice-ignorado/README.md) | depois | `Index Scan usando idx_clientes_lower_email` | 1 | 4 | 0,043 ms | 0,042 ms a 0,046 ms | 5 |
| [03-paginacao-offset](03-paginacao-offset/README.md) | antes | `Seq Scan` | 500.000 | 4.207 | 979,4 ms | 949,2 ms a 1.069,8 ms | 5 |
| [03-paginacao-offset](03-paginacao-offset/README.md) | tentativa | `Index Scan usando idx_pedidos_data_id` | 400.500 | 403.479 | 569,7 ms | 545,2 ms a 580,1 ms | 5 |
| [03-paginacao-offset](03-paginacao-offset/README.md) | depois | `Index Scan usando idx_pedidos_data_id` | 20 | 23 | 0,087 ms | 0,082 ms a 0,645 ms | 5 |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | antes | `Seq Scan → SubPlan` | 143.604.973 | 1.201.652 | 38.371,2 ms | 32.597,7 ms a 39.691,0 ms | 3 |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | tentativa | `Seq Scan → SubPlan` | 143.551.759 | 1.201.197 | 8.994,1 ms | 8.903,8 ms a 9.193,4 ms | 3 |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | depois | `Seq Scan → Hash Join (Anti)` | 487.491 | 8.431 | 56,2 ms | 52,8 ms a 59,8 ms | 5 |
| [07-busca-por-trecho](07-busca-por-trecho/README.md) | antes | `Seq Scan` | 50.000 | 705 | 3,21 ms | 3,02 ms a 3,33 ms | 5 |
| [07-busca-por-trecho](07-busca-por-trecho/README.md) | tentativa | `Seq Scan` | 50.000 | 705 | 3,06 ms | 3,05 ms a 3,41 ms | 5 |
| [07-busca-por-trecho](07-busca-por-trecho/README.md) | depois | `Bitmap Heap Scan usando idx_clientes_telefone_trgm` | 5 | 18 | 0,058 ms | 0,051 ms a 0,064 ms | 5 |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | antes | `Seq Scan → Nested Loop` | 540.000 | 42.563 | 181,3 ms | 162,3 ms a 227,9 ms | 5 |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | depois | `Seq Scan → Hash Join` | 540.000 | 4.607 | 37,6 ms | 36,2 ms a 45,0 ms | 5 |
