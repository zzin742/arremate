import pg from 'pg';

// O driver devolve BIGINT como string, para não perder precisão acima de
// 2^53. Aqui isso atrapalha mais do que protege: `sequencia` é um contador
// por leilão que nunca chega perto disso, e string quebra tanto a soma
// ('1' + 1 = '11') quanto a comparação que o cliente faz para descartar
// mensagem atrasada ('10' < '9' é verdadeiro).
pg.types.setTypeParser(20, Number);   // 20 = int8 / BIGINT

// pg puro, sem ORM, de propósito: o coração do projeto é um
// SELECT ... FOR UPDATE, e ORM esconde exatamente o controle de
// transação e trava que precisamos enxergar (ADR-003).
export const pool = new pg.Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'arremate',
  password: process.env.PGPASSWORD ?? 'arremate',
  database: process.env.PGDATABASE ?? 'arremate_cat',
  max: 10,
});

/** Roda `fn` dentro de uma transação; faz rollback em qualquer erro. */
export async function emTransacao(fn) {
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
