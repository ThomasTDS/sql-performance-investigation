# Medições das investigações

> Arquivo gerado por `npm run medir`. Não edite à mão: rode o script de novo para atualizar.

- **Gerado em:** 2026-10-20
- **Sistema:** Windows_NT 10.0.26300 (x64)
- **CPU:** 13th Gen Intel(R) Core(TM) i9-13980HX · 32 núcleos
- **PostgreSQL:** 16.14 (embarcado) · **Node.js:** v24.14.0

Cada tempo é a mediana de 5 execuções com `EXPLAIN (ANALYZE, BUFFERS)`, depois de uma execução descartada para aquecer o cache. Consultas em que a primeira execução passa de 5 s são medidas só 3 vezes, sem descartar nenhuma: para elas, o aquecimento não muda o tempo. A coluna "Execuções" mostra quantas foram usadas. A faixa mostra o menor e o maior tempo. Linhas lidas e buffers são da tabela investigada e da consulta inteira, respectivamente, e quase não variam entre máquinas. Os tempos variam: numa mesma máquina, já foram observadas diferenças de até 5 vezes entre sessões.

| Investigação | Cenário | Acesso à tabela (→ join) | Linhas lidas | Buffers | Tempo (mediana) | Faixa | Execuções |
|---|---|---|---:|---:|---:|---|---:|
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | antes | `Seq Scan` | 1.500.939 | 9.567 | 57,3 ms | 49,0 ms a 74,8 ms | 5 |
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | depois | `Index Scan usando idx_itens_pedido_pedido_id` | 2 | 10 | 0,018 ms | 0,012 ms a 0,023 ms | 5 |
| [02-indice-ignorado](02-indice-ignorado/README.md) | antes | `Seq Scan` | 50.000 | 705 | 5,59 ms | 5,41 ms a 5,79 ms | 5 |
| [02-indice-ignorado](02-indice-ignorado/README.md) | tentativa | `Seq Scan` | 50.000 | 705 | 5,61 ms | 5,33 ms a 5,71 ms | 5 |
| [02-indice-ignorado](02-indice-ignorado/README.md) | depois | `Index Scan usando idx_clientes_lower_email` | 1 | 4 | 0,010 ms | 0,007 ms a 0,015 ms | 5 |
| [03-paginacao-offset](03-paginacao-offset/README.md) | antes | `Seq Scan` | 500.000 | 4.207 | 169,6 ms | 162,1 ms a 179,8 ms | 5 |
| [03-paginacao-offset](03-paginacao-offset/README.md) | tentativa | `Index Scan usando idx_pedidos_data_id` | 400.500 | 403.479 | 106,7 ms | 103,3 ms a 112,7 ms | 5 |
| [03-paginacao-offset](03-paginacao-offset/README.md) | depois | `Index Scan usando idx_pedidos_data_id` | 20 | 23 | 0,013 ms | 0,010 ms a 0,017 ms | 5 |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | antes | `Seq Scan → SubPlan` | 143.551.759 | 1.201.192 | 8.852,3 ms | 8.794,0 ms a 9.012,1 ms | 3 |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | tentativa | `Seq Scan → SubPlan` | 143.551.759 | 1.201.200 | 9.074,6 ms | 9.025,4 ms a 9.191,9 ms | 3 |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | depois | `Seq Scan → Hash Join (Anti)` | 487.491 | 8.431 | 56,5 ms | 53,1 ms a 61,5 ms | 5 |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | antes | `Seq Scan → Nested Loop` | 540.000 | 42.563 | 155,1 ms | 152,8 ms a 157,2 ms | 5 |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | depois | `Seq Scan → Hash Join` | 540.000 | 4.592 | 40,4 ms | 30,1 ms a 45,0 ms | 5 |
