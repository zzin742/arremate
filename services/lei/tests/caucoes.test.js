/**
 * Caução como condição do lance (RF-012).
 *
 * O LEI não pergunta ao CAU: mantém um espelho local, alimentado pelo
 * evento `caucao_mudou`, e consulta esse espelho **dentro da trava do
 * leilão**. O porquê está na migration 005 — chamada de rede ali
 * seguraria o lock da linha pelo tempo da resposta alheia.
 *
 * O que estes testes fixam é o comportamento do espelho e a recusa. O
 * caminho do evento em si (outbox -> SNS -> SQS) é provado em
 * `packages/shared/tests/outbox.test.js`, contra o LocalStack.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pool, emTransacao } from '../src/db.js';
import { espelharCaucao, temCaucao } from '../src/caucoes.js';
import { registrarLance, abrirLeilao, LanceRecusado } from '../src/lances.js';

const VENDEDOR = '11111111-1111-1111-1111-111111111111';
const COMPRADOR = '22222222-2222-2222-2222-222222222222';
const OUTRO = '33333333-3333-3333-3333-333333333333';
const CAUCAO = 'aaaaaaaa-0000-0000-0000-000000000001';

const aviso = (extra = {}) => ({
  idCaucao: CAUCAO, idLeilao: null, idEmpresa: COMPRADOR, status: 'confirmada', ...extra,
});

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => {
  await pool.query('TRUNCATE arremate, lance, leilao, outbox, caucao_ativa CASCADE');
});
after(async () => { await pool.end(); });

async function leilaoAberto() {
  const { rows } = await pool.query(
    "SELECT clock_timestamp() + interval '10 minutes' AS t",
  );
  return abrirLeilao({
    idEmpresa: VENDEDOR,
    descricaoEquipamento: 'Torno mecânico 1998',
    lanceInicial: 1000,
    incrementoMin: 100,
    encerraEm: rows[0].t.toISOString(),
  });
}

const liberar = (idLeilao, idEmpresa = COMPRADOR, idCaucao = CAUCAO) =>
  emTransacao((cx) => espelharCaucao(cx, aviso({ idLeilao, idEmpresa, idCaucao })));

describe('o espelho da caução', () => {
  test('caução confirmada libera; qualquer outro status tira', async () => {
    const l = await leilaoAberto();

    await liberar(l.id);
    assert.equal(await emTransacao((cx) => temCaucao(cx, {
      idLeilao: l.id, idEmpresa: COMPRADOR,
    })), true);

    await emTransacao((cx) => espelharCaucao(cx, aviso({
      idLeilao: l.id, status: 'devolvida',
    })));
    assert.equal(await emTransacao((cx) => temCaucao(cx, {
      idLeilao: l.id, idEmpresa: COMPRADOR,
    })), false, 'devolvida tem de tirar a permissão');
  });

  test('o mesmo evento duas vezes não duplica (entrega é ao menos uma vez)', async () => {
    const l = await leilaoAberto();

    await liberar(l.id);
    await liberar(l.id);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM caucao_ativa WHERE id_leilao = $1', [l.id],
    );
    assert.equal(rows[0].n, 1);
  });

  test('a caução é por leilão, não por empresa', async () => {
    // Pagar num leilão não dá direito de lançar em outro.
    const a = await leilaoAberto();
    const b = await leilaoAberto();

    await liberar(a.id);

    assert.equal(await emTransacao((cx) => temCaucao(cx, {
      idLeilao: b.id, idEmpresa: COMPRADOR,
    })), false);
  });

  test('status desconhecido não libera', async () => {
    // Só `confirmada` libera. Um status novo no CAU que chegasse aqui
    // sem ninguém mexer no LEI tem de ser tratado como "não pode".
    const l = await leilaoAberto();

    await emTransacao((cx) => espelharCaucao(cx, aviso({
      idLeilao: l.id, status: 'em_analise',
    })));

    assert.equal(await emTransacao((cx) => temCaucao(cx, {
      idLeilao: l.id, idEmpresa: COMPRADOR,
    })), false);
  });
});

describe('o lance exige caução (RF-012)', () => {
  test('sem caução, o lance é recusado', async () => {
    const l = await leilaoAberto();

    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 }),
      (e) => e instanceof LanceRecusado && e.codigo === 'sem_caucao',
    );
  });

  test('com caução, o lance passa', async () => {
    const l = await leilaoAberto();
    await liberar(l.id);

    const lance = await registrarLance({
      idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000,
    });
    assert.equal(lance.sequencia, 1);
  });

  test('a caução de outra empresa não serve', async () => {
    const l = await leilaoAberto();
    await liberar(l.id, OUTRO, 'aaaaaaaa-0000-0000-0000-000000000002');

    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 }),
      (e) => e.codigo === 'sem_caucao',
    );
  });

  test('devolver a caução impede o PRÓXIMO lance, sem apagar os dados', async () => {
    // A conferência acontece a cada lance, dentro da trava — e não uma
    // vez no começo da participação. Lance já aceito continua válido:
    // ele aconteceu quando a caução existia.
    const l = await leilaoAberto();
    await liberar(l.id);
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });

    await emTransacao((cx) => espelharCaucao(cx, aviso({
      idLeilao: l.id, status: 'devolvida',
    })));

    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1100 }),
      (e) => e.codigo === 'sem_caucao',
    );

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM lance WHERE id_leilao = $1', [l.id],
    );
    assert.equal(rows[0].n, 1, 'o lance anterior continua valendo');
  });
});
