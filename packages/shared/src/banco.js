/**
 * Conexão com o Postgres, igual para os sete serviços.
 *
 * Antes cada serviço tinha o seu `db.js`, idêntico aos outros menos pelo
 * nome do banco padrão. Sete cópias significam sete lugares para mudar
 * quando a conexão muda — e a primeira vez que isso aconteceu foi logo
 * na estreia na AWS, com o TLS abaixo.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

// O driver devolve BIGINT como string, para não perder precisão acima de
// 2^53. Aqui isso atrapalha mais do que protege: `sequencia` é um
// contador por leilão que nunca chega perto disso, e string quebra tanto
// a soma ('1' + 1 = '11') quanto a comparação que o cliente faz para
// descartar mensagem atrasada ('10' < '9' é verdadeiro).
pg.types.setTypeParser(20, Number); // 20 = int8 / BIGINT

const CERTIFICADO = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', 'certificados', 'rds-us-east-1.pem',
);

/**
 * Configuração de TLS.
 *
 * O RDS recusa conexão em claro, e a recusa não diz "use TLS": ela volta
 * como `no pg_hba.conf entry for host ..., no encryption`, que parece
 * problema de senha ou de regra de acesso. Custou uma ida ao CloudWatch
 * para descobrir que o Postgres local, sem TLS, tinha escondido isso o
 * tempo todo.
 *
 * `rejectUnauthorized: true` com o pacote de CAs do RDS, e não o
 * `false` que aparece em todo exemplo da internet: aceitar qualquer
 * certificado desliga a verificação justamente da parte que o TLS
 * existe para garantir — que do outro lado está o banco, e não alguém
 * no meio do caminho. O pacote é só o de us-east-1 (3 certificados,
 * 4 KB) em vez do global (114, 175 KB), porque é a única região onde
 * este projeto roda.
 */
function tls() {
  if (process.env.PGSSL !== 'exigir') return false;
  return {
    ca: fs.readFileSync(CERTIFICADO, 'utf8'),
    rejectUnauthorized: true,
  };
}

/** Pool do serviço. `bancoPadrao` vale quando PGDATABASE não vem no ambiente. */
export function criarPool(bancoPadrao) {
  // pg puro, sem ORM, de propósito: o coração do projeto é um
  // SELECT ... FOR UPDATE, e ORM esconde exatamente o controle de
  // transação e trava que precisamos enxergar (ADR-003).
  return new pg.Pool({
    host: process.env.PGHOST ?? 'localhost',
    port: Number(process.env.PGPORT ?? 5432),
    user: process.env.PGUSER ?? 'arremate',
    password: process.env.PGPASSWORD ?? 'arremate',
    database: process.env.PGDATABASE ?? bancoPadrao,
    ssl: tls(),
    max: 10,
  });
}

/** Roda `fn` dentro de uma transação; faz rollback em qualquer erro. */
export async function transacaoEm(pool, fn) {
  const cx = await pool.connect();
  try {
    await cx.query('BEGIN');
    const r = await fn(cx);
    await cx.query('COMMIT');
    return r;
  } catch (e) {
    await cx.query('ROLLBACK');
    throw e;
  } finally {
    cx.release();
  }
}
