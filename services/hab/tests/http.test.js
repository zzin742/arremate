/**
 * Camada HTTP do HAB.
 *
 * O que estes testes cobrem e `habilitacao.test.js` não: o mapeamento de
 * resultado de regra para código de status. `emitirToken` devolve
 * `{ emitido: false, motivo }` — não lança —, e é a rota que decide se
 * isso vira 409 ou 200 com corpo vazio. Esse tipo de decisão só existe
 * aqui.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const EMPRESA = '33333333-3333-3333-3333-333333333333';
let s;

before(async () => {
  await pool.query('SELECT 1');
  s = await subir(app);
});
beforeEach(async () => { await pool.query('TRUNCATE habilitacao'); });
after(async () => { await s.fechar(); await pool.end(); });

/** `id_evento_origem` e unico: e ele que torna o consumo idempotente. */
let evento = 0;
async function habilitacao(situacao) {
  evento += 1;
  await pool.query(
    `INSERT INTO habilitacao (id_empresa, cnpj, situacao, id_evento_origem)
     VALUES ($1, '11222333000181', $2, $3)`,
    [EMPRESA, situacao, `44444444-4444-4444-4444-${String(evento).padStart(12, '0')}`],
  );
}

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    const r = await s.get('/saude');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { servico: 'hab', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    const r = await s.get('/api/hab/saude');
    assert.equal(r.status, 200);
  });

  test('métricas no formato do Prometheus', async () => {
    const r = await s.get('/metricas');
    assert.equal(r.status, 200);
    assert.match(r.texto, /^# HELP /m);
  });
});

describe('emissão de token de habilitação (RF-004)', () => {
  test('empresa aprovada recebe token', async () => {
    await habilitacao('aprovada');
    const r = await s.get(`/empresas/${EMPRESA}/token`);
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
    assert.ok(r.json.validade);
  });

  test('empresa sem habilitação é 409 com o motivo', async () => {
    const r = await s.get(`/empresas/${EMPRESA}/token`);
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'sem_habilitacao');
    assert.ok(!r.json.token, 'não pode vazar token em recusa');
  });

  test('o motivo da recusa distingue pendente de recusada', async () => {
    // 409 em ambos; o corpo é o que diz ao usuário se vale esperar ou
    // se o caminho acabou. Conferir só o status esconderia a troca.
    await habilitacao('pendente');
    const pendente = await s.get(`/empresas/${EMPRESA}/token`);

    await pool.query('TRUNCATE habilitacao');
    await habilitacao('recusada');
    const recusada = await s.get(`/empresas/${EMPRESA}/token`);

    assert.equal(pendente.json.codigo, 'pendente');
    assert.equal(recusada.json.codigo, 'recusada');
  });

  test('vale a habilitação mais recente, não a primeira', async () => {
    await habilitacao('recusada');
    await habilitacao('aprovada');
    const r = await s.get(`/empresas/${EMPRESA}/token`);
    assert.equal(r.status, 200, 'a decisão mais nova é a que vale');
  });

  test('id que não é UUID não derruba o serviço', async () => {
    const r = await s.get('/empresas/isto-nao-e-uuid/token');
    assert.ok(r.status >= 400, `esperava erro, veio ${r.status}`);
    const depois = await s.get('/saude');
    assert.equal(depois.status, 200);
  });
});

describe('reprocessamento das pendentes (RF-005)', () => {
  test('sem pendentes, devolve contagem zerada em vez de erro', async () => {
    const r = await s.post('/reprocessar');
    assert.equal(r.status, 200);
    assert.ok(r.json, 'tem de devolver corpo, mesmo sem trabalho a fazer');
  });
});
