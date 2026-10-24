import pg from 'pg';

// pg puro, sem ORM, de propósito: o coração do projeto é um
// SELECT ... FOR UPDATE, e ORM esconde exatamente o controle de
// transação e trava que precisamos enxergar (ADR-003).
export const pool = new pg.Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'arremate',
  password: process.env.PGPASSWORD ?? 'arremate',
  database: process.env.PGDATABASE ?? 'arremate_auth',
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
