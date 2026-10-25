/**
 * Camada HTTP do VIS.
 *
 * O ponto desta camada é a validação de entrada: as datas chegam como
 * texto e o esquema decide o que vira 400 antes de o banco ver qualquer
 * coisa. A sobreposição, que é a regra de verdade, é imposta pelo
 * `EXCLUDE USING gist` — aqui o que se prova é que ela chega ao cliente
 * como 409, e não como 500.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const EQUIPAMENTO = '55555555-5555-5555-5555-555555555555';
const EMPRESA = '66666666-6666-6666-6666-666666666666';
const OUTRA = '77777777-7777-7777-7777-777777777777';

let s;

const daquiA = (horas) => new Date(Date.now() + horas * 3_600_000).toISOString();

before(async () => {
  await pool.query('SELECT 1');
  s = await subir(app);
});
beforeEach(async () => { await pool.query('TRUNCATE visita'); });
after(async () => { await s.fechar(); await pool.end(); });

const visita = (extra = {}) => ({
  idEquipamento: EQUIPAMENTO,
  idEmpresa: EMPRESA,
  inicio: daquiA(24),
  fim: daquiA(25),
  ...extra,
});

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    const r = await s.get('/saude');
    assert.deepEqual(r.json, { servico: 'vis', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    assert.equal((await s.get('/api/vis/saude')).status, 200);
  });

  test('métricas no formato do Prometheus', async () => {
    assert.match((await s.get('/metricas')).texto, /^# HELP /m);
  });
});

describe('agendamento (RF-014)', () => {
  test('agenda e devolve 201', async () => {
    const r = await s.post('/visitas', { corpo: visita() });
    assert.equal(r.status, 201);
    assert.ok(r.json.id);
  });

  test('data que não é ISO é 400 do esquema', async () => {
    const r = await s.post('/visitas', { corpo: visita({ inicio: '25/10/2026 14:00' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('id que não é UUID é 400, não 500', async () => {
    const r = await s.post('/visitas', { corpo: visita({ idEquipamento: 'abc' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('fim antes do início é erro de regra, com mensagem', async () => {
    const r = await s.post('/visitas', {
      corpo: visita({ inicio: daquiA(25), fim: daquiA(24) }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'periodo_invalido');
    assert.ok(r.json.mensagem);
  });

  test('visita no passado é recusada', async () => {
    const r = await s.post('/visitas', {
      corpo: visita({ inicio: daquiA(-5), fim: daquiA(-4) }),
    });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'periodo_no_passado');
  });

  test('sobreposição chega ao cliente como conflito, não como erro interno', async () => {
    // quem recusa é o EXCLUDE USING gist no banco; o que se prova aqui
    // é a tradução da violação em resposta HTTP
    await s.post('/visitas', { corpo: visita() });
    const r = await s.post('/visitas', {
      corpo: visita({ idEmpresa: OUTRA, inicio: daquiA(24.5), fim: daquiA(25.5) }),
    });
    assert.equal(r.status, 409);
    assert.notEqual(r.json.codigo, 'erro_interno');
  });

  test('outro equipamento no mesmo horário é aceito', async () => {
    await s.post('/visitas', { corpo: visita() });
    const r = await s.post('/visitas', {
      corpo: visita({ idEquipamento: OUTRA }),
    });
    assert.equal(r.status, 201, 'a trava é por equipamento, não global');
  });
});

describe('cancelamento e agenda', () => {
  test('cancela a própria visita', async () => {
    const { json: v } = await s.post('/visitas', { corpo: visita() });
    const r = await s.delete(`/visitas/${v.id}`, { corpo: { idEmpresa: EMPRESA } });
    assert.equal(r.status, 200);
  });

  test('empresa diferente não cancela visita alheia', async () => {
    const { json: v } = await s.post('/visitas', { corpo: visita() });
    const r = await s.delete(`/visitas/${v.id}`, { corpo: { idEmpresa: OUTRA } });
    assert.ok(r.status >= 400, `cancelar visita de outro tem de falhar, veio ${r.status}`);
  });

  test('cancelar sem dizer quem cancela é 400', async () => {
    const { json: v } = await s.post('/visitas', { corpo: visita() });
    const r = await s.delete(`/visitas/${v.id}`, { corpo: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('agenda de equipamento sem visita é lista vazia, não 404', async () => {
    const r = await s.get(`/equipamentos/${EQUIPAMENTO}/agenda`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, []);
  });

  test('horário liberado depois do cancelamento aparece na agenda', async () => {
    const { json: v } = await s.post('/visitas', { corpo: visita() });
    await s.delete(`/visitas/${v.id}`, { corpo: { idEmpresa: EMPRESA } });

    const r = await s.get(`/equipamentos/${EQUIPAMENTO}/agenda`);
    assert.equal(r.status, 200);
    assert.ok(!r.json.some((x) => x.id === v.id && x.status === 'agendada'),
      'visita cancelada não pode continuar ocupando a agenda');
  });
});
