/**
 * Esperas do banco e a diferença entre "recusou" e "não cheguei lá".
 *
 * O caso que importa aqui foi descoberto pelo teste de carga (T-031):
 * sob 20 clientes no mesmo leilão, o pool estourava a espera por conexão
 * e o erro subia como exceção genérica, virando HTTP 500. É carga, não
 * defeito, e o cliente precisa saber que tentar de novo adianta.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { transacaoEm, SemConexao } from './banco.js';

/** Pool de mentira: só precisa decidir se entrega conexão ou falha. */
function poolQue(comportamento) {
  return {
    connect: async () => {
      if (comportamento === 'estoura') {
        throw new Error('timeout exceeded when trying to connect');
      }
      if (comportamento === 'outro_erro') {
        const e = new Error('password authentication failed');
        e.code = '28P01';
        throw e;
      }
      return {
        consultas: [],
        async query(sql) { this.consultas.push(sql); },
        release() { this.liberada = true; },
      };
    },
  };
}

describe('transacaoEm', () => {
  test('espera estourada no pool vira SemConexao, não erro cru', async () => {
    await assert.rejects(
      () => transacaoEm(poolQue('estoura'), async () => 1),
      (e) => e instanceof SemConexao && e.codigo === 'servico_ocupado',
    );
  });

  test('a causa original é preservada para o log', async () => {
    try {
      await transacaoEm(poolQue('estoura'), async () => 1);
      assert.fail('devia ter lançado');
    } catch (e) {
      assert.match(e.causa.message, /timeout exceeded/);
    }
  });

  test('erro que NÃO é de conexão passa intacto', async () => {
    // Senha errada não é carga: confundir os dois faria o serviço
    // responder "tente de novo" para algo que nunca vai funcionar.
    await assert.rejects(
      () => transacaoEm(poolQue('outro_erro'), async () => 1),
      (e) => !(e instanceof SemConexao) && e.code === '28P01',
    );
  });

  test('o caminho feliz faz BEGIN, roda e COMMIT', async () => {
    const pool = poolQue('ok');
    let vista;
    const r = await transacaoEm(pool, async (cx) => { vista = cx; return 42; });

    assert.equal(r, 42);
    assert.deepEqual(vista.consultas, ['BEGIN', 'COMMIT']);
    assert.equal(vista.liberada, true, 'conexão não devolvida vaza o pool');
  });

  test('erro dentro da transação faz ROLLBACK e devolve a conexão', async () => {
    const pool = poolQue('ok');
    let vista;
    await assert.rejects(() => transacaoEm(pool, async (cx) => {
      vista = cx;
      throw new Error('estourou no meio');
    }));

    assert.deepEqual(vista.consultas, ['BEGIN', 'ROLLBACK']);
    assert.equal(vista.liberada, true);
  });
});
