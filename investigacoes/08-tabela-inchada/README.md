# Investigação 08 — Tabela inchada depois de um UPDATE em massa

| | |
|---|---|
| **Sintoma** | Alerta de disco: a tabela `pedidos` dobrou de tamanho em uma noite (33 MB → 66 MB, mais os índices: 11 MB → 21 MB), sem nenhum pedido novo |
| **Causa raiz** | O job noturno "recalcular totais" grava as 500 mil linhas toda noite, mesmo quando o total já está certo (e está certo em todas). No PostgreSQL, cada `UPDATE` grava uma **versão nova** da linha e deixa a antiga para trás. O `VACUUM` libera o espaço das versões antigas para ser reaproveitado, mas não devolve esse espaço ao disco |
| **Correção** | 1. O job passa a gravar só os pedidos cujo total mudou (`IS DISTINCT FROM`). 2. Um `VACUUM FULL`, uma única vez, numa janela de manutenção, devolve o espaço |
| **Resultado** | O job passa a gravar 0 linhas por noite, e a tabela volta a 4.207 páginas (33 MB), com exatamente os mesmos dados (`md5`) |
| **Status** | Diagnóstico concluído, com correção verificada pela validação |

Arquivos desta investigação:

- [`job.sql`](job.sql): o job noturno como estava em produção.
- [`job-corrigido.sql`](job-corrigido.sql): a correção, parte 1: o job só grava o que mudou.
- [`manutencao.sql`](manutencao.sql): a correção, parte 2: o `VACUUM FULL`.
- [`exploracao.sql`](exploracao.sql): as queries na ordem em que foram usadas, numeradas conforme os passos abaixo.

> **Formato diferente das outras investigações:** o `VACUUM` não roda dentro de uma transação, então esta investigação não pode ser desfeita com `ROLLBACK`. O [`exploracao.sql`](exploracao.sql) grava as mudanças de verdade e termina com a tabela no tamanho original e com os mesmos dados. Na validação, ela roda por último.

> **Sobre o tempo:** este chamado não é de lentidão. A tabela inchada é lida com o dobro de páginas (num relatório por status, 8.426 em vez de 4.223), mas nesta máquina o tempo quase não mudou, porque os 66 MB ainda cabem na memória. Numa tabela maior que a memória, o dobro de páginas vira o dobro de leitura do disco.

---

## 1. Sintoma relatado

> Chamado da infraestrutura: "O monitoramento de disco alertou: a tabela `pedidos` dobrou de tamanho de ontem para hoje. A quantidade de pedidos é a mesma. Os backups também cresceram."

Uma tabela que dobra sem ganhar linhas não está guardando dados novos, e sim **outra coisa**. A pergunta é: o que ocupa o espaço extra, e de onde veio?

O único processo que mexeu em `pedidos` naquela noite foi o job "recalcular totais" ([`job.sql`](job.sql)), que confere o `valor_total` de cada pedido contra a soma dos itens:

```sql
UPDATE pedidos AS p
SET valor_total = t.total
FROM (
    SELECT pedido_id, sum(quantidade * preco_unitario) AS total
    FROM itens_pedido
    GROUP BY pedido_id
) AS t
WHERE t.pedido_id = p.id;
```

## 2. Hipóteses iniciais

| # | Hipótese | Como confirmar ou descartar |
|---|---|---|
| H1 | Entraram pedidos novos | Contar as linhas da tabela |
| H2 | O espaço extra são versões antigas das linhas, deixadas pelo job | Medir linhas vivas, mortas e espaço livre (`pgstattuple`) |
| H3 | O job grava linhas que não precisava gravar | Contar quantos totais estavam de fato errados |
| H4 | Um `VACUUM` resolve | Rodar o `VACUUM` e medir o tamanho de novo |

## 3. Investigação

O banco foi colocado no estado do chamado com o job antigo já executado uma vez.

### Passo 1: o tamanho da tabela

| | Depois da carga | Depois do job |
|---|---:|---:|
| Páginas de 8 KB | 4.207 | 8.410 |
| Tabela | 33 MB | 66 MB |
| Índices (só a chave primária) | 11 MB | 21 MB |

### Passo 2: o que ocupa o espaço

A extensão `pgstattuple` (do pacote contrib do PostgreSQL) lê a tabela inteira e separa o que há em cada página:

| linhas_vivas | pct_vivas | linhas_mortas | pct_mortas | pct_livre |
|---:|---:|---:|---:|---:|
| 500000 | 45.84 | 500000 | 45.84 | 0.31 |

Metade da tabela são as 500 mil linhas vivas, e a outra metade são **500 mil linhas mortas**: as versões antigas, de antes do job. É assim que o PostgreSQL implementa o controle de concorrência (MVCC). O `UPDATE` não sobrescreve a linha: grava uma versão nova e marca a antiga como apagada, porque outra transação, que começou antes, ainda pode precisar enxergá-la. O índice da chave primária também dobrou, porque cada versão nova ganhou uma entrada nele.

> Esta medição precisa vir antes de qualquer outra leitura da tabela. Uma leitura comum já "poda" as páginas que encontra cheias de versões mortas: elas viram espaço livre, e o `pgstattuple` passa a mostrar 0% de mortas e cerca de 50% de livre. O tamanho do arquivo não muda.

### Passo 3: o job precisava gravar alguma coisa?

| pedidos |
|---:|
| 500000 |

| totais_errados |
|---:|
| 0 |

**Achado:** **H1 descartada** (são os mesmos 500 mil pedidos) e **H2 e H3 confirmadas.** Nenhum total estava errado. O job gravou 500 mil linhas, e criou 500 mil versões mortas, para não mudar nenhum valor.

### Passo 4: o `VACUUM` resolve?

Depois de um `VACUUM pedidos`:

| | Páginas | Tabela | Vivas | Mortas | Livre |
|---|---:|---:|---:|---:|---:|
| Depois do `VACUUM` | 8.410 | 66 MB | 45,84% | 0% | 49,59% |

O `VACUUM` removeu as versões mortas, mas o espaço delas ficou **dentro do arquivo**, como espaço livre para novas gravações. Ele só devolve ao disco as páginas vazias no **fim** do arquivo, e aqui as versões novas foram gravadas justamente no fim.

**Achado:** **H4 descartada.** O `VACUUM` deixa a tabela pronta para reaproveitar o espaço, mas não a encolhe.

### Passo 5: e na noite seguinte?

O job antigo roda de novo, agora com metade do arquivo livre:

| | Páginas | Tabela |
|---|---:|---:|
| Depois da segunda noite | 8.411 | 66 MB |

As versões novas ocupam o espaço que o `VACUUM` liberou, e a tabela fica estável no dobro do tamanho. O alerta não vai "piorar" a cada noite (o autovacuum faz o papel do `VACUUM` do passo 4), mas a tabela também nunca volta ao tamanho original sozinha. Se o autovacuum não acompanhar o job (por exemplo, se o job rodar duas vezes antes de ele passar), a tabela cresce mais.

## 4. Causa raiz

O job "recalcular totais" grava todos os pedidos, mesmo os que não mudam. No PostgreSQL, cada `UPDATE` cria uma versão nova da linha, e a primeira execução do job dobrou a tabela e o índice. O `VACUUM` (e o autovacuum) libera o espaço das versões antigas para reaproveitamento, mas não devolve o espaço ao disco, então a tabela fica permanentemente com o dobro do tamanho.

## 5. Correção e verificação

**Parte 1, a causa** ([`job-corrigido.sql`](job-corrigido.sql)): o job só grava os pedidos cujo total realmente mudou.

```sql
WHERE t.pedido_id = p.id
  AND p.valor_total IS DISTINCT FROM t.total;
```

Com estes dados, o job corrigido grava **0 linhas** (`UPDATE 0`). Quando algum total estiver errado, ele grava só aquele pedido. O `IS DISTINCT FROM`, e não `<>`, trata um total nulo como diferente.

**Parte 2, o espaço** ([`manutencao.sql`](manutencao.sql)): um `VACUUM FULL`, uma única vez.

| | Antes da correção | Depois do `VACUUM FULL` |
|---|---:|---:|
| Páginas | 8.411 | 4.207 |
| Tabela | 66 MB | 33 MB |
| Índices | 21 MB | 11 MB |
| Dados (`md5` de todos os pedidos) | `5a4f5e43...` | `5a4f5e43...` (o mesmo) |

O `VACUUM FULL` reescreve a tabela num arquivo novo, só com as linhas vivas, e recria os índices. Ele tem um custo alto:

- **Bloqueia a tabela inteira** enquanto roda (`ACCESS EXCLUSIVE`): nenhuma leitura nem escrita passa. É o bloqueio mais forte do PostgreSQL, mais forte que o do `CREATE INDEX` da [investigação 04](../04-bloqueio-create-index/README.md). Por isso, precisa de uma janela de manutenção.
- **Precisa de espaço livre** em disco para a cópia nova, enquanto a antiga ainda existe.

Sem a parte 1, a parte 2 não adianta: na noite seguinte, o job antigo dobraria a tabela de novo.

### Verificação automatizada

O `npm run validate` (e a CI) repete esta investigação a cada execução, por último, depois de todas as outras:

1. confere que `pedidos` tem o tamanho do volume base;
2. roda o [`job.sql`](job.sql) e confere que ele grava 500 mil linhas e que a tabela fica com **cerca do dobro** de páginas (entre 1,9 e 2,1 vezes);
3. roda um `VACUUM` e confere que a tabela **continua** com cerca do dobro;
4. roda o job antigo de novo e confere que a tabela continua com cerca do dobro (reaproveitou o espaço);
5. roda o [`job-corrigido.sql`](job-corrigido.sql) e confere que ele grava **0 linhas**;
6. roda o [`manutencao.sql`](manutencao.sql) e confere que a tabela volta **exatamente** ao tamanho base, com o **mesmo `md5`** dos dados conferido na validação do volume.

O tamanho depois do job é conferido como proporção, e não em páginas exatas, para não depender de detalhes de cada versão do PostgreSQL.

## 6. Recomendações

- **Aplicar as duas partes:** o job corrigido primeiro e o `VACUUM FULL` numa janela de manutenção.
- **Alternativa ao `VACUUM FULL` sem janela:** a extensão `pg_repack` reescreve a tabela segurando o bloqueio forte só por instantes, no começo e no fim. Ela não vem com o PostgreSQL e precisa ser instalada no servidor.
- **Revisar outros jobs em massa** com a mesma pergunta: "ele grava linhas que não mudam?". Um `UPDATE` que não muda nada custa o mesmo que um que muda tudo.
- **Monitoramento:** acompanhar o tamanho das maiores tabelas ao longo do tempo e o `n_dead_tup` de `pg_stat_user_tables`. Uma tabela que cresce sem ganhar linhas aponta para versões mortas.
- **Se o job precisar mesmo atualizar muitas linhas** (por exemplo, quando um preço muda para todos os pedidos), dividir em lotes com um `VACUUM` entre eles, para o espaço ser reaproveitado aos poucos em vez de dobrar a tabela de uma vez.
