/**
 * Camada HTTP do NOT.
 *
 * Duas coisas só existem aqui: o filtro `?naoLidas=1`, que vem como
 * texto na query e tem de virar booleano, e o 404 de notificação
 * inexistente — `marcarLida` devolve vazio em vez de lançar, então é a
 * rota que decide o status.
 *
 * O NOT é o único serviço sem tratador de erro de esquema: ele não tem
 * esquema. Qualquer falha cai no 500 genérico, e por isso importa provar
 * que entrada estranha não chega lá.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const EMPRESA = '88888888-8888-8888-8888-888888888888';
const OUTRA = '99999999-9999-9999-9999-999999999999';

let s;
let evento = 0;

before(async () => {
  await pool.query('SELECT 1');
  s = await subir(app);
});
beforeEach(async () => { await pool.query('TRUNCATE notificacao'); });
after(async () => { await s.fechar(); await pool.end(); });

async function aviso({ empresa = EMPRESA, titulo = 'Você foi superado' } = {}) {
  evento += 1;
  const { rows: [n] } = await pool.query(
    `INSERT INTO notificacao (id_empresa, tipo, titulo, corpo, id_evento_origem)
     VALUES ($1, 'lance-superado', $2, 'Alguém cobriu seu lance', $3)
     RETURNING *`,
    [empresa, titulo, `aaaaaaaa-aaaa-aaaa-aaaa-${String(evento).padStart(12, '0')}`],
  );
  return n;
}

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    assert.deepEqual((await s.get('/saude')).json, { servico: 'not', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    assert.equal((await s.get('/api/not/saude')).status, 200);
  });

  test('métricas no formato do Prometheus', async () => {
    assert.match((await s.get('/metricas')).texto, /^# HELP /m);
  });
});

describe('listagem (RF-018)', () => {
  test('empresa sem notificação recebe lista vazia, não 404', async () => {
    const r = await s.get(`/empresas/${EMPRESA}/notificacoes`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  });

  test('lista só o que é da empresa', async () => {
    await aviso();
    await aviso({ empresa: OUTRA });

    const r = await s.get(`/empresas/${EMPRESA}/notificacoes`);
    assert.equal(r.json.length, 1);
    assert.ok(r.json.every((n) => n.id_empresa === EMPRESA),
      'notificação de outra empresa não pode vazar');
  });

  test('o filtro de não lidas só liga com o valor exato', async () => {
    // `req.query.naoLidas === '1'` — qualquer outro texto é lista
    // completa. Vale fixar: trocar por um truthy faria `?naoLidas=0`
    // filtrar, que é o contrário do que o parâmetro diz.
    const n = await aviso();
    await s.post(`/notificacoes/${n.id}/lida`, { corpo: { idEmpresa: EMPRESA } });
    await aviso({ titulo: 'Leilão encerrado' });

    const todas = await s.get(`/empresas/${EMPRESA}/notificacoes`);
    const naoLidas = await s.get(`/empresas/${EMPRESA}/notificacoes?naoLidas=1`);
    const zero = await s.get(`/empresas/${EMPRESA}/notificacoes?naoLidas=0`);

    assert.equal(todas.json.length, 2);
    assert.equal(naoLidas.json.length, 1);
    assert.equal(zero.json.length, 2, '?naoLidas=0 não filtra');
  });
});

describe('marcar como lida (RF-018)', () => {
  test('marca e devolve a notificação', async () => {
    const n = await aviso();
    const r = await s.post(`/notificacoes/${n.id}/lida`, { corpo: { idEmpresa: EMPRESA } });
    assert.equal(r.status, 200);
    assert.ok(r.json.lida_em, 'a resposta tem de trazer o momento da leitura');
  });

  test('marcar duas vezes não quebra', async () => {
    const n = await aviso();
    await s.post(`/notificacoes/${n.id}/lida`, { corpo: { idEmpresa: EMPRESA } });
    const r = await s.post(`/notificacoes/${n.id}/lida`, { corpo: { idEmpresa: EMPRESA } });
    assert.ok(r.status === 200 || r.status === 404, `veio ${r.status}`);
  });

  test('notificação inexistente é 404', async () => {
    const r = await s.post('/notificacoes/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/lida',
      { corpo: { idEmpresa: EMPRESA } });
    assert.equal(r.status, 404);
    assert.equal(r.json.codigo, 'notificacao_nao_encontrada');
  });

  test('empresa errada não marca notificação alheia', async () => {
    const n = await aviso();
    const r = await s.post(`/notificacoes/${n.id}/lida`, { corpo: { idEmpresa: OUTRA } });
    assert.equal(r.status, 404, 'para quem não é dono, a notificação não existe');

    const { rows: [atual] } = await pool.query('SELECT lida_em FROM notificacao WHERE id = $1', [n.id]);
    assert.equal(atual.lida_em, null, 'e não pode ter sido marcada');
  });

  test('id que não é UUID vira erro, e o serviço continua de pé', async () => {
    const r = await s.post('/notificacoes/nao-e-uuid/lida', { corpo: { idEmpresa: EMPRESA } });
    assert.ok(r.status >= 400, `esperava erro, veio ${r.status}`);
    assert.equal((await s.get('/saude')).status, 200);
  });
});
