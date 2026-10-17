# Medições das investigações

> Arquivo gerado por `npm run medir`. Não edite à mão: rode o script de novo para atualizar.

- **Gerado em:** 2026-10-17
- **Sistema:** Windows_NT 10.0.26300 (x64)
- **CPU:** 13th Gen Intel(R) Core(TM) i9-13980HX · 32 núcleos
- **PostgreSQL:** 16.14 (embarcado) · **Node.js:** v24.14.0

Cada tempo é a mediana de 5 execuções com `EXPLAIN (ANALYZE, BUFFERS)`, depois de uma execução descartada para aquecer o cache. A faixa mostra o menor e o maior tempo. Linhas lidas e buffers são da tabela investigada e da consulta inteira, respectivamente, e quase não variam entre máquinas. Os tempos variam: numa mesma máquina, já foram observadas diferenças de até 5 vezes entre sessões.

| Investigação | Cenário | Acesso à tabela (→ join) | Linhas lidas | Buffers | Tempo (mediana) | Faixa |
|---|---|---|---:|---:|---:|---|
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | antes | `Seq Scan` | 1.500.939 | 9.568 | 64,6 ms | 63,5 ms a 83,7 ms |
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | depois | `Index Scan usando idx_itens_pedido_pedido_id` | 2 | 10 | 0,049 ms | 0,042 ms a 0,052 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | antes | `Seq Scan` | 50.000 | 705 | 28,6 ms | 26,8 ms a 33,3 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | tentativa | `Seq Scan` | 50.000 | 705 | 29,6 ms | 27,4 ms a 35,7 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | depois | `Index Scan usando idx_clientes_lower_email` | 1 | 4 | 0,042 ms | 0,040 ms a 0,052 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | antes | `Seq Scan` | 500.000 | 4.207 | 955,1 ms | 935,1 ms a 978,5 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | tentativa | `Index Scan usando idx_pedidos_data_id` | 400.500 | 403.479 | 588,7 ms | 554,0 ms a 633,2 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | depois | `Index Scan usando idx_pedidos_data_id` | 20 | 23 | 0,082 ms | 0,077 ms a 0,095 ms |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | antes | `Seq Scan → Nested Loop` | 540.000 | 42.563 | 938,9 ms | 896,9 ms a 968,8 ms |
| [05-estatisticas-desatualizadas](05-estatisticas-desatualizadas/README.md) | depois | `Seq Scan → Hash Join` | 540.000 | 4.607 | 53,1 ms | 47,0 ms a 54,0 ms |
