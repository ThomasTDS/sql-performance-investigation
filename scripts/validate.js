// Valida o ambiente contra um Postgres real (binário baixado sob demanda,
// sem precisar de Docker) — usado tanto em desenvolvimento local quanto
// no CI.
//
// Por enquanto, confere apenas que o banco sobe e que a versão é a 16, a
// mesma do postgres:16 do docker-compose.yml. As verificações dos planos
// de execução das investigações entram aqui nas próximas etapas.

const path = require('node:path');
const { comPostgresEmbarcado, executar } = require('./postgres-embarcado');

const PORT = 5433;
const DATA_DIR = path.join(__dirname, '..', '.pgdata-validate');
const VERSAO_MAJOR_ESPERADA = 16;

async function main() {
  await comPostgresEmbarcado({ porta: PORT, pasta: DATA_DIR }, async (client) => {
    const result = await client.query('SHOW server_version_num');
    // server_version_num tem o formato MMmmmm (ex.: 160014 = 16.14).
    const versaoNum = Number(result.rows[0].server_version_num);
    const major = Math.floor(versaoNum / 10000);
    const ok = major === VERSAO_MAJOR_ESPERADA;
    console.log(`  ${ok ? '✔' : '✘'} versão do PostgreSQL: esperado ${VERSAO_MAJOR_ESPERADA}, encontrado ${major} (${versaoNum})`);
    if (!ok) process.exitCode = 1;
  });

  if (process.exitCode === 1) {
    console.log('\nValidação FALHOU — ver itens marcados com ✘ acima.');
  } else {
    console.log('\nValidação OK — o ambiente está pronto.');
  }
}

executar(main);
