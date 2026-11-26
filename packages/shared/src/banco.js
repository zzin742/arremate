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
/**
 * Limite de espera por trava.
 *
 * Esperar para sempre é o pior desfecho possível: não há erro, não há
 * log, e de fora é idêntico a "ainda trabalhando". Foi assim que a
 * medição de cobertura ficou mais de uma hora parada — um processo de
 * teste sobreviveu ao pai segurando uma transação aberta, e o `TRUNCATE`
 * do arquivo seguinte ficou na fila da trava indefinidamente.
 *
 * Com o limite, a mesma situação vira `canceling statement due to lock
 * timeout`: um erro, com nome, no arquivo certo.
 *
 * Vale para o lance também, e não só para o teste. O RNF-001 dá 300 ms
 * ao registro de lance; uma requisição presa num `FOR UPDATE` por 30 s
 * já descumpriu o requisito muito antes — falhar é mais honesto que
 * segurar o cliente.
 */
/**
 * Ordem das esperas, descoberta pelo teste de carga (T-031).
 *
 * Os três limites precisam crescer nesta ordem:
 *
 *     trava (5 s)  <  conexão do pool (10 s)  <  consulta (30 s)
 *
 * Estavam invertidos: a trava esperava 30 s e o pool desistia em 10 s.
 * Com 20 clientes no MESMO leilão, quem pegava a trava segurava a
 * conexão por até 30 s, e quem esperava vaga no pool estourava antes —
 * então a falha aparecia como `timeout exceeded when trying to connect`,
 * que virava **HTTP 500**. O sistema quebrava no pool, longe de onde a
 * contenção realmente estava.
 *
 * Com a trava menor, quem espera demais pela linha do leilão falha
 * primeiro, **devolve a conexão** e a fila do pool drena. A carga é
 * descartada onde ela existe, e com código próprio em vez de erro
 * interno. Medido: 10 respostas 500 em 113.896 requisições antes,
 * nenhuma depois.
 *
 * 5 s é folgado: sob 380 RPS no mesmo leilão o P99 medido foi 202 ms.
 * Só dispara em contenção patológica — que é quando se quer descartar.
 */
const ESPERA_POR_TRAVA_MS = Number(process.env.PG_LOCK_TIMEOUT_MS ?? 5_000);

/**
 * Limites de espera do lado do cliente.
 *
 * O `pg` não tem nenhum por padrão: conexão que não completa e consulta
 * que não volta ficam penduradas indefinidamente. Um serviço assim não
 * falha — ele para, calado, e o ECS nem reinicia, porque do lado de fora
 * continua "no ar".
 *
 * Foi esse o desfecho que prendeu um processo de teste por dezenove
 * minutos: parado em `kevent`, esperando uma conexão que o banco não
 * tinha. Sem limite não havia erro para investigar, só silêncio.
 */
const ESPERA_POR_CONEXAO_MS = Number(process.env.PG_CONNECT_TIMEOUT_MS ?? 10_000);
const ESPERA_POR_CONSULTA_MS = Number(process.env.PG_STATEMENT_TIMEOUT_MS ?? 30_000);

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
    connectionTimeoutMillis: ESPERA_POR_CONEXAO_MS,
    // `options` chega ao servidor na conexão; vale para toda consulta
    // daquela sessão, sem precisar lembrar de repetir em cada query.
    options: `-c lock_timeout=${ESPERA_POR_TRAVA_MS}`
      + ` -c statement_timeout=${ESPERA_POR_CONSULTA_MS}`,
  });
}

/**
 * O pool não tinha vaga a tempo.
 *
 * Existe para separar "o banco recusou" de "não cheguei ao banco". O
 * segundo é carga, não defeito, e merece 503 com `Retry-After` em vez
 * de 500 — que manda o cliente parar de tentar e esconde a causa no log
 * como se fosse exceção de programação.
 */
export class SemConexao extends Error {
  constructor(causa) {
    super('Sem conexão disponível no pool');
    this.codigo = 'servico_ocupado';
    this.causa = causa;
  }
}

/** Roda `fn` dentro de uma transação; faz rollback em qualquer erro. */
export async function transacaoEm(pool, fn) {
  let cx;
  try {
    cx = await pool.connect();
  } catch (e) {
    // `pg-pool` usa a mensagem, não um código: não há `e.code` aqui.
    if (/timeout exceeded when trying to connect/i.test(e.message)) {
      throw new SemConexao(e);
    }
    throw e;
  }

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
