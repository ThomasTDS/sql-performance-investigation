// Funções compartilhadas pelos scripts que rodam contra um Postgres
// embarcado (binário real, baixado sob demanda, sem precisar de Docker).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const EmbeddedPostgres = require('embedded-postgres').default;
const { Client } = require('pg');

const SQL_DIR = path.join(__dirname, '..', 'sql');

function lerSql(nomeArquivo) {
  return fs.readFileSync(path.join(SQL_DIR, nomeArquivo), 'utf-8');
}

// No Windows, o initdb grava o caminho da pasta share (arquivos de
// instalação do Postgres, dentro de node_modules) num comando SQL. Se o
// projeto estiver numa pasta com acento (ex.: "Programação"), esse caminho
// chega em WIN1252 e o banco em UTF-8 o rejeita ("invalid byte sequence").
// Nesse caso, a share é copiada para a pasta temporária do sistema e o
// initdb a usa de lá (-L). Devolve o caminho da cópia, ou null se não for
// preciso copiar.
async function copiarShareSeNecessario() {
  if (process.platform !== 'win32') return null;
  const { initdb } = await import('@embedded-postgres/windows-x64');
  const share = path.join(path.dirname(initdb), '..', 'share');
  if (/^[\x00-\x7F]*$/.test(share)) return null;

  const copia = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-share-'));
  // fs.promises.cp, e não fs.cpSync: no Node 24 para Windows, o cpSync
  // derruba o processo sem mensagem nenhuma ao copiar desta pasta.
  await fs.promises.cp(share, copia, { recursive: true });
  return copia;
}

// Sobe um Postgres limpo na porta e pasta informadas, executa `fn` com um
// cliente conectado e, no fim (com ou sem erro), derruba o banco e apaga
// a pasta de dados. `opcoesCliente` é repassado ao Client do pg.
async function comPostgresEmbarcado({ porta, pasta, opcoesCliente = {} }, fn) {
  const shareCopia = await copiarShareSeNecessario();
  const pg = new EmbeddedPostgres({
    databaseDir: pasta,
    user: 'postgres',
    password: 'postgres',
    port: porta,
    persistent: false,
    // Sem isso, o initdb herda a codificação e o locale do sistema
    // operacional (no Windows em português: WIN1252 e Portuguese_Brazil).
    // O locale muda planos de execução — com locale diferente de C, um
    // índice B-tree comum não atende LIKE 'abc%' —, então os três
    // ambientes (local, Docker e CI) usam UTF-8 com locale C.
    initdbFlags: ['--encoding=UTF8', '--locale=C', ...(shareCopia ? ['-L', shareCopia] : [])],
  });

  console.log('Subindo Postgres (embarcado, sem Docker)...');
  try {
    await pg.initialise();
  } finally {
    // A share só é lida pelo initdb; depois dele, a cópia pode sair.
    if (shareCopia) fs.rmSync(shareCopia, { recursive: true, force: true });
  }
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

module.exports = { lerSql, comPostgresEmbarcado, executar };
