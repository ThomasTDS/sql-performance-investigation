# ⚡ SQL Performance Investigation

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![postgres](https://img.shields.io/badge/PostgreSQL-16-blue.svg)

> 🚧 **Projeto em construção.** Este README será completado a cada etapa.

## Descrição

Este repositório investiga problemas de **performance** em consultas SQL num banco PostgreSQL com volume realista de dados, usando a mesma metodologia de investigação de bugs de produção: sintoma → hipóteses → evidência (planos de execução com `EXPLAIN ANALYZE`) → causa raiz → correção proposta → verificação.

É a continuação do projeto [sql-defect-investigation](https://github.com/ThomasTDS/sql-defect-investigation), que trata de **qualidade de dados** (dado errado). Aqui o dado está certo, mas a consulta está lenta.

> **Nota sobre os dados:** todo o schema e os dados deste projeto são fictícios, criados especificamente para este projeto de portfólio. Nenhuma informação de empregador atual ou anterior foi usada.

---

## Licença

Distribuído sob a licença MIT. Veja [LICENSE](LICENSE) para mais detalhes.
