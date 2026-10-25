/**
 * Camada HTTP do CAU.
 *
 * Duas decisões de status moram só aqui, e nenhuma é óbvia:
 *
 * - `POST /caucoes` devolve **201 na primeira e 200 na repetida**. É o
 *   `c.repetida` virando status, e é o que diz ao cliente se houve
 *   cobrança nova ou se ele está vendo a de antes.
 * - O webhook devolve **200 mesmo para evento repetido**. O provedor
 *   reenvia enquanto não recebe 2xx; responder 409 numa repetição faria
 *   ele insistir para sempre em algo já processado.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const LEILAO = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const EMPRESA = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

let s;

before(async () => {
  await pool.query('SELECT 1');
  s = await subir(app);
});
beforeEach(async () => { await pool.query('TRUNCATE caucao, evento_pagamento CASCADE'); });
after(async () => { await s.fechar(); await pool.end(); });

const caucao = (extra = {}) => ({
  idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 5000, ...extra,
});

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    assert.deepEqual((await s.get('/saude')).json, { servico: 'cau', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    assert.equal((await s.get('/api/cau/saude')).status, 200);
  });

  test('métricas no formato do Prometheus', async () => {
    assert.match((await s.get('/metricas')).texto, /^# HELP /m);
  });
});

describe('solicitação de caução (RF-019)', () => {
  test('a primeira é 201', async () => {
    const r = await s.post('/caucoes', { corpo: caucao() });
    assert.equal(r.status, 201);
    assert.ok(r.json.id);
  });

  test('a repetida é 200, e devolve a MESMA caução', async () => {
    const primeira = await s.post('/caucoes', { corpo: caucao() });
    const segunda = await s.post('/caucoes', { corpo: caucao() });

    assert.equal(segunda.status, 200);
    assert.equal(segunda.json.id, primeira.json.id,
      'repetir o pedido não pode gerar segunda cobrança');
  });

  test('valor negativo é 400', async () => {
    const r = await s.post('/caucoes', { corpo: caucao({ valor: -100 }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('valor zero é 400', async () => {
    const r = await s.post('/caucoes', { corpo: caucao({ valor: 0 }) });
    assert.equal(r.status, 400);
  });

  test('valor como texto é 400', async () => {
    const r = await s.post('/caucoes', { corpo: caucao({ valor: '5000' }) });
    assert.equal(r.status, 400);
  });

  test('id que não é UUID é 400, não 500', async () => {
    const r = await s.post('/caucoes', { corpo: caucao({ idLeilao: 'abc' }) });
    assert.equal(r.status, 400);
  });
});

describe('consulta de caução ativa (RF-012)', () => {
  test('sem caução, responde ativa: false em vez de 404', async () => {
    // o LEI chama isto antes de aceitar o lance; um 404 o obrigaria a
    // tratar ausência como erro
    const r = await s.get(`/caucoes/ativa?leilao=${LEILAO}&empresa=${EMPRESA}`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { ativa: false });
  });

  test('caução apenas solicitada ainda não está ativa', async () => {
    await s.post('/caucoes', { corpo: caucao() });
    const r = await s.get(`/caucoes/ativa?leilao=${LEILAO}&empresa=${EMPRESA}`);
    assert.equal(r.json.ativa, false, 'pedir não é pagar');
  });
});

describe('webhook do provedor (RF-020, RF-021)', () => {
  test('evento repetido devolve 200 e diz que é repetido', async () => {
    await s.post('/caucoes', { corpo: caucao() });
    const { rows: [c] } = await pool.query('SELECT id_cobranca_externa FROM caucao LIMIT 1');

    const evento = {
      id_evento: '11111111-2222-3333-4444-555555555555',
      id_cobranca: c.id_cobranca_externa,
      tipo: 'pagamento.aprovado',
    };

    const primeira = await s.post('/webhooks/sandbox', { corpo: evento });
    const segunda = await s.post('/webhooks/sandbox', { corpo: evento });

    assert.equal(primeira.status, 200);
    assert.equal(segunda.status, 200, 'repetição não pode ser erro: o provedor reenviaria para sempre');
    assert.equal(segunda.json.repetido, true);
    assert.equal(segunda.json.aplicado, false);
  });

  test('pagamento confirmado deixa a caução ativa', async () => {
    await s.post('/caucoes', { corpo: caucao() });
    const { rows: [c] } = await pool.query('SELECT id_cobranca_externa FROM caucao LIMIT 1');

    await s.post('/webhooks/sandbox', {
      corpo: {
        id_evento: '22222222-3333-4444-5555-666666666666',
        id_cobranca: c.id_cobranca_externa,
        tipo: 'pagamento.aprovado',
      },
    });

    const r = await s.get(`/caucoes/ativa?leilao=${LEILAO}&empresa=${EMPRESA}`);
    assert.equal(r.json.ativa, true);
  });

  test('webhook de cobrança desconhecida não derruba o serviço', async () => {
    const r = await s.post('/webhooks/sandbox', {
      corpo: {
        id_evento: '33333333-4444-5555-6666-777777777777',
        id_cobranca: 'nao-existe',
        tipo: 'pagamento.aprovado',
      },
    });
    assert.ok(r.status < 500, `provedor não pode receber 500, veio ${r.status}`);
    assert.equal((await s.get('/saude')).status, 200);
  });
});
