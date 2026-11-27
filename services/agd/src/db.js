import { criarPool, transacaoEm } from '@naregua/shared';

export const pool = criarPool('naregua_agd');

/** Roda `fn` dentro de uma transação; faz rollback em qualquer erro. */
export const emTransacao = (fn) => transacaoEm(pool, fn);
