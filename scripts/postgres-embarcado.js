// Funções compartilhadas pelos scripts que rodam contra um Postgres
// embarcado (binário real, baixado sob demanda, sem precisar de Docker).

const fs = require('node:fs');
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');

// Sobe um Postgres limpo na porta e pasta informadas, executa `fn` com um
// cliente conectado e, no fim (com ou sem erro), derruba o banco e apaga
// a pasta de dados. `opcoesCliente` é repassado ao Client do pg.
async function comPostgresEmbarcado({ porta, pasta, opcoesCliente = {} }, fn) {
  const pg = new EmbeddedPostgres({
    databaseDir: pasta,
    user: 'postgres',
    password: 'postgres',
    port: porta,
    persistent: false,
  });

  console.log('Subindo Postgres (embarcado, sem Docker)...');
  await pg.initialise();
  await pg.start();

  try {
    const client = new Client({
      host: 'localhost',
      port: porta,
      user: 'postgres',
      password: 'postgres',
      database: 'postgres',
      ...opcoesCliente,
    });
    await client.connect();
    try {
      await fn(client);
    } finally {
      await client.end();
    }
  } finally {
    await pg.stop();
    fs.rmSync(pasta, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  }
}

// Sai explicitamente com o código certo: o embedded-postgres registra um
// gancho de saída (async-exit-hook) que, se o processo terminar sozinho,
// chama process.exit(0) e descarta o process.exitCode = 1 definido por
// uma verificação que falhou — e a CI ficaria verde mesmo com defeito.
function executar(main) {
  main()
    .then(() => process.exit(process.exitCode || 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

module.exports = { comPostgresEmbarcado, executar };
