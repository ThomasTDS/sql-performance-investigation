# Medições das investigações

> Arquivo gerado por `npm run medir`. Não edite à mão: rode o script de novo para atualizar.

- **Gerado em:** 2026-10-16
- **Sistema:** Windows_NT 10.0.26300 (x64)
- **CPU:** 13th Gen Intel(R) Core(TM) i9-13980HX · 32 núcleos
- **PostgreSQL:** 16.14 (embarcado) · **Node.js:** v24.14.0

Cada tempo é a mediana de 5 execuções com `EXPLAIN (ANALYZE, BUFFERS)`, depois de uma execução descartada para aquecer o cache. A faixa mostra o menor e o maior tempo. Linhas lidas e buffers são da tabela investigada e da consulta inteira, respectivamente, e quase não variam entre máquinas. Os tempos variam: numa mesma máquina, já foram observadas diferenças de até 5 vezes entre sessões.

| Investigação | Cenário | Acesso à tabela | Linhas lidas | Buffers | Tempo (mediana) | Faixa |
|---|---|---|---:|---:|---:|---|
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | antes | `Seq Scan` | 1.500.939 | 9.568 | 68,3 ms | 62,9 ms a 99,1 ms |
| [01-fk-sem-indice](01-fk-sem-indice/README.md) | depois | `Index Scan usando idx_itens_pedido_pedido_id` | 2 | 10 | 0,013 ms | 0,011 ms a 0,019 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | antes | `Seq Scan` | 50.000 | 705 | 7,26 ms | 6,49 ms a 7,66 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | tentativa | `Seq Scan` | 50.000 | 705 | 6,72 ms | 6,24 ms a 8,66 ms |
| [02-indice-ignorado](02-indice-ignorado/README.md) | depois | `Index Scan usando idx_clientes_lower_email` | 1 | 4 | 0,020 ms | 0,011 ms a 0,023 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | antes | `Seq Scan` | 500.000 | 4.207 | 191,3 ms | 186,6 ms a 199,6 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | tentativa | `Index Scan usando idx_pedidos_data_id` | 400.500 | 403.479 | 167,8 ms | 166,2 ms a 183,3 ms |
| [03-paginacao-offset](03-paginacao-offset/README.md) | depois | `Index Scan usando idx_pedidos_data_id` | 20 | 23 | 0,021 ms | 0,017 ms a 0,024 ms |
