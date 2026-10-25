/**
 * Camada HTTP do CAT.
 *
 * O esquema desta rota é o mais rico do projeto — enum de estado de
 * conservação, faixa de ano, ficha técnica livre — e é aqui que ele é
 * exercido. `catalogo.test.js` chama as funções já com objeto válido;
 * nada lá diz o que acontece quando chega `estadoConservacao: "meia
 * boca"` pela rede.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const EMPRESA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
let s;

before(async () => {
  await pool.query('SELECT 1');
  s = await subir(app);
});
beforeEach(async () => { await pool.query('TRUNCATE equipamento, midia, outbox CASCADE'); });
after(async () => { await s.fechar(); await pool.end(); });

const equipamento = (extra = {}) => ({
  idEmpresa: EMPRESA,
  nome: 'Torno CNC Romi GL240',
  categoria: 'usinagem',
  ano: 2015,
  estadoConservacao: 'seminovo',
  localizacao: 'Jundiaí/SP',
  ...extra,
});

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    assert.deepEqual((await s.get('/saude')).json, { servico: 'cat', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    assert.equal((await s.get('/api/cat/saude')).status, 200);
  });

  test('métricas trazem a pendência da outbox', async () => {
    const r = await s.get('/metricas');
    assert.equal(r.status, 200);
    assert.match(r.texto, /outbox_pendencia_mais_antiga_segundos/);
  });
});

describe('cadastro de equipamento (RF-007)', () => {
  test('cadastra e devolve 201', async () => {
    const r = await s.post('/equipamentos', { corpo: equipamento() });
    assert.equal(r.status, 201);
    assert.ok(r.json.id);
  });

  test('estado de conservação fora da lista é 400', async () => {
    const r = await s.post('/equipamentos', { corpo: equipamento({ estadoConservacao: 'meia boca' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('ano fora da faixa é 400', async () => {
    const r = await s.post('/equipamentos', { corpo: equipamento({ ano: 1850 }) });
    assert.equal(r.status, 400);
  });

  test('ano como texto é 400, e não vira 1850 por conversão', async () => {
    const r = await s.post('/equipamentos', { corpo: equipamento({ ano: '2015' }) });
    assert.equal(r.status, 400, 'o esquema exige número, não texto convertível');
  });

  test('ano é opcional: máquina antiga sem placa entra sem ele', async () => {
    const { ano, ...sem } = equipamento();
    const r = await s.post('/equipamentos', { corpo: sem });
    assert.equal(r.status, 201);
  });

  test('ficha técnica livre é aceita e volta inteira', async () => {
    const ficha = { potencia: '15 cv', tensao: '380V', eixos: 3 };
    const r = await s.post('/equipamentos', { corpo: equipamento({ fichaTecnica: ficha }) });
    assert.equal(r.status, 201);
    assert.deepEqual(r.json.ficha_tecnica, ficha);
  });

  test('nome curto demais é 400', async () => {
    const r = await s.post('/equipamentos', { corpo: equipamento({ nome: 'ab' }) });
    assert.equal(r.status, 400);
  });
});

describe('busca e consulta (RF-008)', () => {
  test('busca sem filtro devolve lista', async () => {
    await s.post('/equipamentos', { corpo: equipamento() });
    const r = await s.get('/equipamentos');
    assert.equal(r.status, 200);
    assert.ok(Array.isArray(r.json) || Array.isArray(r.json.itens));
  });

  test('equipamento inexistente é 404 com código, não corpo vazio', async () => {
    const r = await s.get('/equipamentos/dddddddd-dddd-dddd-dddd-dddddddddddd');
    assert.equal(r.status, 404);
    assert.equal(r.json.codigo, 'equipamento_inexistente');
  });

  test('consulta por id devolve o que foi cadastrado', async () => {
    const { json: criado } = await s.post('/equipamentos', { corpo: equipamento() });
    const r = await s.get(`/equipamentos/${criado.id}`);
    assert.equal(r.status, 200);
    assert.equal(r.json.id, criado.id);
  });

  test('id malformado não derruba o serviço', async () => {
    const r = await s.get('/equipamentos/nao-e-uuid');
    assert.ok(r.status >= 400, `esperava erro, veio ${r.status}`);
    assert.equal((await s.get('/saude')).status, 200);
  });
});

describe('upload de mídia (RF-009)', () => {
  test('tipo fora de foto/video é 400 antes de falar com o S3', async () => {
    const { json: criado } = await s.post('/equipamentos', { corpo: equipamento() });
    const r = await s.post(`/equipamentos/${criado.id}/midias`, { corpo: { tipo: 'pdf' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('sem o campo tipo é 400', async () => {
    const { json: criado } = await s.post('/equipamentos', { corpo: equipamento() });
    const r = await s.post(`/equipamentos/${criado.id}/midias`, { corpo: {} });
    assert.equal(r.status, 400);
  });
});
