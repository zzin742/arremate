/**
 * Cria os bancos e aplica as migrations pendentes.
 *
 * O `db/init/00-bancos.sql` do compose só existe porque o Postgres em
 * contêiner roda o que estiver em `docker-entrypoint-initdb.d` na
 * primeira subida. O RDS não tem esse gancho: o banco nasce com um
 * `postgres` vazio e nada mais. Este script é o caminho que funciona
 * nos dois lugares.
 *
 * Roda como tarefa avulsa do ECS, com a imagem de qualquer serviço:
 *
 *   aws ecs run-task --cluster arremate-dev \
 *     --task-definition arremate-dev-migrador ...
 *
 * É assim, e não no start de cada serviço, porque cada serviço subiria
 * a sua migration em paralelo com as réplicas dele e com os outros seis
 * — e porque migration que roda sozinha a cada boot é migration que
 * ninguém decide quando aplica.
 *
 * Rodar duas vezes é seguro: cada banco tem `schema_migrations` e o
 * registro entra na MESMA transação da migration.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.join(AQUI, 'migrations');

const SERVICOS = ['auth', 'hab', 'cat', 'mid', 'lei', 'cau', 'vis', 'not'];
// Só estes publicam evento, e só eles precisam da tabela de outbox.
const COM_OUTBOX = new Set(['auth', 'cat', 'lei', 'mid']);

function tls() {
  if (process.env.PGSSL !== 'exigir') return false;
  return {
    ca: fs.readFileSync(
      path.join(AQUI, '..', 'packages', 'shared', 'certificados', 'rds-us-east-1.pem'),
      'utf8',
    ),
    rejectUnauthorized: true,
  };
}

function conectar(database) {
  return new pg.Client({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'arremate',
    password: process.env.PGPASSWORD ?? 'arremate',
    database,
    ssl: tls(),
  });
}

/** Lista das migrations de um serviço, na ordem de aplicação. */
function migrationsDe(servico) {
  const lista = [path.join(MIGRATIONS, '_comum', '000_extensoes.sql')];
  if (COM_OUTBOX.has(servico)) {
    lista.push(path.join(MIGRATIONS, '_comum', '001_outbox.sql'));
  }
  const propria = path.join(MIGRATIONS, servico);
  if (fs.existsSync(propria)) {
    // ordem alfabética é a ordem de aplicação: o prefixo numérico do
    // nome do arquivo é o que a garante
    lista.push(...fs.readdirSync(propria).filter((f) => f.endsWith('.sql')).sort()
      .map((f) => path.join(propria, f)));
  }
  return lista;
}

/** Nome estável da migration no registro: pasta/arquivo. */
function nomeDe(arquivo) {
  return `${path.basename(path.dirname(arquivo))}/${path.basename(arquivo)}`;
}

async function criarBancosEUsuarios() {
  const cx = conectar('postgres');
  await cx.connect();
  try {
    for (const s of SERVICOS) {
      // `CREATE USER` e `CREATE DATABASE` não aceitam IF NOT EXISTS, e
      // este script roda de novo a cada implantação — a existência é
      // consultada antes em vez de engolir o erro, que esconderia
      // também um erro de verdade.
      const { rowCount: temUsuario } = await cx.query(
        'SELECT 1 FROM pg_roles WHERE rolname = $1', [`svc_${s}`],
      );
      if (!temUsuario) {
        await cx.query(`CREATE USER svc_${s} WITH PASSWORD '${`svc_${s}`}'`);
        console.log(`  usuario svc_${s}`);
      }

      const { rowCount: temBanco } = await cx.query(
        'SELECT 1 FROM pg_database WHERE datname = $1', [`arremate_${s}`],
      );
      if (!temBanco) {
        // CREATE DATABASE não roda dentro de transação — por isso este
        // bloco não está em BEGIN/COMMIT como o resto.
        await cx.query(`CREATE DATABASE arremate_${s} OWNER svc_${s}`);
        console.log(`  banco arremate_${s}`);
      }

      // Sem o REVOKE, qualquer usuário conecta em qualquer banco e a
      // separação da ADR-003 fica só no papel.
      await cx.query(`REVOKE CONNECT ON DATABASE arremate_${s} FROM PUBLIC`);
      await cx.query(`GRANT CONNECT ON DATABASE arremate_${s} TO svc_${s}`);
    }
  } finally {
    await cx.end();
  }
}

async function aplicar(servico) {
  const banco = `arremate_${servico}`;
  const cx = conectar(banco);
  await cx.connect();
  try {
    await cx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      nome        TEXT PRIMARY KEY,
      aplicada_em TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

    for (const arquivo of migrationsDe(servico)) {
      const nome = nomeDe(arquivo);
      const { rowCount } = await cx.query(
        'SELECT 1 FROM schema_migrations WHERE nome = $1', [nome],
      );
      if (rowCount) continue;

      const sql = fs.readFileSync(arquivo, 'utf8');
      await cx.query('BEGIN');
      try {
        await cx.query(sql);
        // o registro vai na MESMA transação: aplicar e não registrar
        // deixaria a migration para rodar outra vez
        await cx.query('INSERT INTO schema_migrations (nome) VALUES ($1)', [nome]);
        await cx.query('COMMIT');
        console.log(`  ${banco} <- ${nome}`);
      } catch (e) {
        await cx.query('ROLLBACK');
        throw new Error(`${banco} / ${nome}: ${e.message}`, { cause: e });
      }
    }
  } finally {
    await cx.end();
  }
}

async function principal() {
  console.log(`==> ${process.env.PGHOST ?? 'localhost'}`);
  await criarBancosEUsuarios();
  for (const s of SERVICOS) await aplicar(s);
  console.log('==> migrations em dia');
}

principal().catch((e) => {
  console.error(e);
  process.exit(1);
});
