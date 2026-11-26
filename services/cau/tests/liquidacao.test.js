/**
 * Liquidação do leilão — abatimento e devolução (RF-023, T-025).
 *
 * O que vale provar aqui não é que as linhas mudam de status. É que o
 * dinheiro só é dado por devolvido quando o provedor confirma, e que
 * reprocessar o evento — coisa que a entrega SQS faz — não pede a mesma
 * devolução duas vezes.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  solicitar, processarWebhook, liquidar, daLiquidacao, temCaucaoAtiva,
} from '../src/caucoes.js';
import { criarProvedorSandbox, ProvedorIndisponivel } from '../src/provedor.js';

const LEILAO = '11111111-1111-1111-1111-111111111111';
const ARREMATANTE = '22222222-2222-2222-2222-222222222222';
const PERDEDOR_A = '33333333-3333-3333-3333-333333333333';
const PERDEDOR_B = '44444444-4444-4444-4444-444444444444';
const evt = () => crypto.randomUUID();

let provedor;

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => {
  await pool.query('TRUNCATE liquidacao, evento_pagamento, caucao CASCADE');
  provedor = criarProvedorSandbox();
});
after(async () => { await pool.end(); });

/** Caução paga e confirmada, que é o único estado que a liquidação toca. */
async function caucaoConfirmada(idEmpresa, valor = 500) {
  const c = await solicitar({ idLeilao: LEILAO, idEmpresa, valor }, { provedor });
  await processarWebhook({
    provedor: 'sandbox', idEvento: evt(), idCobranca: c.id_cobranca_externa,
    tipo: 'pagamento.aprovado', payload: {},
  });
  const { rows: [atual] } = await pool.query('SELECT * FROM caucao WHERE id = $1', [c.id]);
  return atual;
}

const statusDe = async (id) => (
  await pool.query('SELECT * FROM caucao WHERE id = $1', [id])
).rows[0];

describe('liquidação com arremate aprovado (RF-023)', () => {
  test('abate a do arrematante e pede devolução das outras', async () => {
    const vencedor = await caucaoConfirmada(ARREMATANTE);
    const a = await caucaoConfirmada(PERDEDOR_A);
    const b = await caucaoConfirmada(PERDEDOR_B);

    const r = await liquidar({
      idEvento: evt(), idLeilao: LEILAO, anulado: false,
      devolverTodas: false, abaterDoArrematante: ARREMATANTE,
    }, { provedor });

    assert.equal(r.abatidas, 1);
    assert.equal(r.devolvidas, 2);
    assert.equal((await statusDe(vencedor.id)).status, 'abatida');
    assert.equal((await statusDe(a.id)).status, 'confirmada',
      'devolvida só quando o webhook confirmar — pedir não é devolver');
    assert.equal((await statusDe(b.id)).status, 'confirmada');
  });

  test('a devolução é PEDIDA ao provedor, não carimbada no banco', async () => {
    const perdedor = await caucaoConfirmada(PERDEDOR_A);
    await caucaoConfirmada(ARREMATANTE);

    await liquidar({
      idEvento: evt(), idLeilao: LEILAO, anulado: false,
      devolverTodas: false, abaterDoArrematante: ARREMATANTE,
    }, { provedor });

    // o provedor registrou a devolução...
    const { estado } = await provedor.consultar(perdedor.id_cobranca_externa);
    assert.equal(estado, 'devolvida');

    // ...e o banco guarda que o pedido foi feito, sem dar por concluído
    const linha = await statusDe(perdedor.id);
    assert.equal(linha.status, 'confirmada');
    assert.ok(linha.devolucao_solicitada_em, 'sem esta marca, reprocessar pediria de novo');
  });

  test('o webhook de devolução é quem fecha o ciclo', async () => {
    const perdedor = await caucaoConfirmada(PERDEDOR_A);
    await caucaoConfirmada(ARREMATANTE);
    await liquidar({
      idEvento: evt(), idLeilao: LEILAO, anulado: false,
      devolverTodas: false, abaterDoArrematante: ARREMATANTE,
    }, { provedor });

    await processarWebhook({
      provedor: 'sandbox', idEvento: evt(), idCobranca: perdedor.id_cobranca_externa,
      tipo: 'pagamento.devolvido', payload: {},
    });

    assert.equal((await statusDe(perdedor.id)).status, 'devolvida');
    assert.equal(await temCaucaoAtiva(LEILAO, PERDEDOR_A), false,
      'devolvida tira a permissão de lançar');
  });
});

describe('liquidação com arremate anulado (RF-004b)', () => {
  test('NENHUMA é abatida, nem a do arrematante', async () => {
    const vencedor = await caucaoConfirmada(ARREMATANTE);
    const a = await caucaoConfirmada(PERDEDOR_A);

    const r = await liquidar({
      idEvento: evt(), idLeilao: LEILAO, anulado: true,
      devolverTodas: true, abaterDoArrematante: null,
    }, { provedor });

    assert.equal(r.abatidas, 0, 'anulado não abate de ninguém');
    assert.equal(r.devolvidas, 2);
    assert.equal((await statusDe(vencedor.id)).status, 'confirmada');
    assert.ok((await statusDe(vencedor.id)).devolucao_solicitada_em);
    assert.ok((await statusDe(a.id)).devolucao_solicitada_em);
  });
});

describe('idempotência do consumo', () => {
  test('o MESMO evento duas vezes não pede a devolução duas vezes', async () => {
    const perdedor = await caucaoConfirmada(PERDEDOR_A);
    await caucaoConfirmada(ARREMATANTE);

    let pedidos = 0;
    const original = provedor.devolver.bind(provedor);
    provedor.devolver = async (id) => { pedidos++; return original(id); };

    const idEvento = evt();
    const args = {
      idEvento, idLeilao: LEILAO, anulado: false,
      devolverTodas: false, abaterDoArrematante: ARREMATANTE,
    };
    await liquidar(args, { provedor });
    const segunda = await liquidar(args, { provedor });

    assert.equal(segunda.repetido, true);
    assert.equal(pedidos, 1, 'a entrega SQS é ao menos uma vez: pedir duas vezes devolveria duas vezes');
    assert.ok((await statusDe(perdedor.id)).devolucao_solicitada_em);
  });

  test('evento DIFERENTE para o mesmo leilão não repete o que já foi feito', async () => {
    await caucaoConfirmada(PERDEDOR_A);
    await caucaoConfirmada(ARREMATANTE);

    let pedidos = 0;
    const original = provedor.devolver.bind(provedor);
    provedor.devolver = async (id) => { pedidos++; return original(id); };

    const base = { idLeilao: LEILAO, anulado: false, devolverTodas: false, abaterDoArrematante: ARREMATANTE };
    await liquidar({ idEvento: evt(), ...base }, { provedor });
    const segunda = await liquidar({ idEvento: evt(), ...base }, { provedor });

    // O segundo evento é novo, então passa pela chave de idempotência —
    // mas a marca por caução impede o segundo pedido ao provedor.
    assert.equal(segunda.repetido, false);
    assert.equal(segunda.devolvidas, 0);
    assert.equal(pedidos, 1, 'devolucao_solicitada_em é a segunda linha de defesa');
  });
});

describe('o que a liquidação NÃO toca', () => {
  test('pendente e recusada ficam de fora', async () => {
    const pendente = await solicitar(
      { idLeilao: LEILAO, idEmpresa: PERDEDOR_A, valor: 500 }, { provedor },
    );
    const recusadaC = await solicitar(
      { idLeilao: LEILAO, idEmpresa: PERDEDOR_B, valor: 500 }, { provedor },
    );
    await processarWebhook({
      provedor: 'sandbox', idEvento: evt(), idCobranca: recusadaC.id_cobranca_externa,
      tipo: 'pagamento.recusado', payload: {},
    });

    const r = await liquidar({
      idEvento: evt(), idLeilao: LEILAO, anulado: true,
      devolverTodas: true, abaterDoArrematante: null,
    }, { provedor });

    assert.equal(r.devolvidas, 0, 'pendente nunca foi paga e recusada não reteve nada');
    assert.equal((await statusDe(pendente.id)).status, 'pendente');
    assert.equal((await statusDe(recusadaC.id)).status, 'recusada');
  });

  test('caução de OUTRO leilão não é liquidada junto', async () => {
    const outroLeilao = '55555555-5555-5555-5555-555555555555';
    const minha = await caucaoConfirmada(PERDEDOR_A);
    const alheia = await solicitar(
      { idLeilao: outroLeilao, idEmpresa: PERDEDOR_A, valor: 500 }, { provedor },
    );
    await processarWebhook({
      provedor: 'sandbox', idEvento: evt(), idCobranca: alheia.id_cobranca_externa,
      tipo: 'pagamento.aprovado', payload: {},
    });

    await liquidar({
      idEvento: evt(), idLeilao: LEILAO, anulado: true,
      devolverTodas: true, abaterDoArrematante: null,
    }, { provedor });

    assert.ok((await statusDe(minha.id)).devolucao_solicitada_em);
    assert.equal((await statusDe(alheia.id)).devolucao_solicitada_em, null);
  });
});

describe('provedor fora do ar', () => {
  test('não marca como pedida o que não foi pedido', async () => {
    const perdedor = await caucaoConfirmada(PERDEDOR_A);
    provedor.devolver = async () => { throw new ProvedorIndisponivel('conexão recusada'); };

    const r = await liquidar({
      idEvento: evt(), idLeilao: LEILAO, anulado: true,
      devolverTodas: true, abaterDoArrematante: null,
    }, { provedor });

    assert.equal(r.devolvidas, 0);
    assert.equal(r.indisponivel, 1);
    assert.equal((await statusDe(perdedor.id)).devolucao_solicitada_em, null,
      'marcar aqui faria o reprocessamento pular uma devolução que nunca aconteceu');
  });
});

describe('tradução do evento do LEI', () => {
  test('daLiquidacao lê o payload que o encerramento publica', () => {
    const a = daLiquidacao({
      idEvento: 'e1',
      corpo: {
        id_leilao: LEILAO, id_arremate: 'x', anulado: false, motivo: null,
        devolver_todas: false, abater_do_arrematante: ARREMATANTE,
      },
    });
    assert.deepEqual(a, {
      idEvento: 'e1', idLeilao: LEILAO, anulado: false,
      devolverTodas: false, abaterDoArrematante: ARREMATANTE,
    });
  });

  test('o payload da anulação vira devolverTodas sem arrematante', () => {
    const a = daLiquidacao({
      idEvento: 'e2',
      corpo: {
        id_leilao: LEILAO, anulado: true, motivo: 'cnpj_irregular',
        devolver_todas: true, abater_do_arrematante: null,
      },
    });
    assert.equal(a.devolverTodas, true);
    assert.equal(a.abaterDoArrematante, null);
    assert.equal(a.anulado, true);
  });
});
