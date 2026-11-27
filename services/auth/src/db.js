import { criarPool, transacaoEm } from '@naregua/shared';

// A configuração vive em shared/banco.js: seriam oito cópias idênticas
// menos pelo nome do banco, e o TLS do RDS teria de ser corrigido nas oito.
export const pool = criarPool('naregua_auth');

/** Roda `fn` dentro de uma transação; faz rollback em qualquer erro. */
export const emTransacao = (fn) => transacaoEm(pool, fn);
