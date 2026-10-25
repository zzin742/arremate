import { criarPool, transacaoEm } from '@arremate/shared';

// A configuracao vive em shared/banco.js: eram sete copias identicas
// menos pelo nome do banco, e o TLS do RDS teria de ser corrigido nas
// sete.
export const pool = criarPool('arremate_hab');

/** Roda `fn` dentro de uma transacao; faz rollback em qualquer erro. */
export const emTransacao = (fn) => transacaoEm(pool, fn);
