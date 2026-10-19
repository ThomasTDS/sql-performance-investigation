# Medições das investigações

> Arquivo gerado por `npm run medir`. Não edite à mão: rode o script de novo para atualizar.

- **Gerado em:** 2026-10-19
- **Sistema:** Windows_NT 10.0.26300 (x64)
- **CPU:** 13th Gen Intel(R) Core(TM) i9-13980HX · 32 núcleos
- **PostgreSQL:** 16.14 (embarcado) · **Node.js:** v24.14.0

Cada tempo é a mediana de 5 execuções com `EXPLAIN (ANALYZE, BUFFERS)`, depois de uma execução descartada para aquecer o cache. A faixa mostra o menor e o maior tempo. Linhas lidas e buffers são da tabela investigada e da consulta inteira, respectivamente, e quase não variam entre máquinas. Os tempos variam: numa mesma máquina, já foram observadas diferenças de até 5 vezes entre sessões.

| Investigação | Cenário | Acesso à tabela (→ join) | Linhas lidas | Buffers | Tempo (mediana) | Faixa |
|---|---|---|---:|---:|---:|---|
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | antes | `Seq Scan` | 1.500.939 | 9.568 | 61,6 ms | 54,1 ms a 154,8 ms |
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | depois | `Index Scan usando idx_itens_pedido_pedido_id` | 2 | 10 | 0,014 ms | 0,013 ms a 0,025 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | antes | `Seq Scan` | 50.000 | 705 | 6,37 ms | 6,27 ms a 6,98 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | tentativa | `Seq Scan` | 50.000 | 705 | 11,3 ms | 6,77 ms a 22,0 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | depois | `Index Scan usando idx_clientes_lower_email` | 1 | 4 | 0,011 ms | 0,010 ms a 0,013 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | antes | `Seq Scan` | 500.000 | 4.207 | 217,5 ms | 199,5 ms a 289,4 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | tentativa | `Index Scan usando idx_pedidos_data_id` | 400.500 | 403.479 | 184,8 ms | 179,1 ms a 220,7 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | depois | `Index Scan usando idx_pedidos_data_id` | 20 | 23 | 0,021 ms | 0,017 ms a 0,024 ms |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | antes | `Seq Scan → SubPlan` | 143.551.759 | 1.201.230 | 10.178,9 ms | 9.953,0 ms a 10.357,1 ms |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | tentativa | `Seq Scan → SubPlan` | 143.551.759 | 1.201.200 | 9.741,7 ms | 9.706,6 ms a 9.991,8 ms |
| [06-not-in-subconsulta](06-not-in-subconsulta/README.md) | depois | `Seq Scan → Hash Join (Anti)` | 487.491 | 8.431 | 70,9 ms | 68,9 ms a 87,8 ms |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | antes | `Seq Scan → Nested Loop` | 540.000 | 42.563 | 180,7 ms | 166,5 ms a 232,5 ms |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | depois | `Seq Scan → Hash Join` | 540.000 | 4.592 | 45,1 ms | 42,4 ms a 162,2 ms |
