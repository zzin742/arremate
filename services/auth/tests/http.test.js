/**
 * Camada HTTP do AUTH.
 *
 * O que vale provar: a tradução de cada erro de negócio em status, e que
 * nenhuma resposta carrega o hash da senha.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

let s;
const conta = (extra = {}) => ({
  nome: 'José Henrique',
  email: `jose-${crypto.randomUUID()}@naregua.local`,
  senha: 'senha-de-teste',
  ...extra,
});

before(async () => { await pool.query('SELECT 1'); s = await subir(app); });
beforeEach(async () => { await pool.query('TRUNCATE conta, bloqueio_conta, outbox CASCADE'); });
after(async () => { await s.fechar(); await pool.end(); });

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    assert.deepEqual((await s.get('/saude')).json, { servico: 'auth', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    assert.equal((await s.get('/api/auth/saude')).status, 200);
  });

  test('métricas no formato do Prometheus', async () => {
    const r = await s.get('/metricas');
    assert.equal(r.status, 200);
    assert.match(r.texto, /# HELP/);
  });
});

describe('cadastro', () => {
  test('cria e devolve 201, sem o hash', async () => {
    const r = await s.post('/contas', { corpo: conta() });
    assert.equal(r.status, 201);
    assert.ok(r.json.id);
    assert.equal(r.json.senha_hash, undefined, 'o hash não pode sair pela rota');
    assert.ok(!r.texto.includes('$2a$'), 'hash no corpo da resposta');
  });

  test('e-mail repetido é 409', async () => {
    const dados = conta();
    await s.post('/contas', { corpo: dados });
    const r = await s.post('/contas', { corpo: dados });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'email_ja_cadastrado');
  });

  test('senha curta é 400, com detalhe', async () => {
    const r = await s.post('/contas', { corpo: conta({ senha: '123' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
    assert.ok(r.json.detalhes.length > 0);
  });

  test('e-mail sem formato é 400, não 500', async () => {
    const r = await s.post('/contas', { corpo: conta({ email: 'nao-e-email' }) });
    assert.equal(r.status, 400);
  });

  test('corpo vazio é 400', async () => {
    assert.equal((await s.post('/contas', { corpo: {} })).status, 400);
  });
});

describe('sessão', () => {
  test('entra e recebe token', async () => {
    const dados = conta();
    await s.post('/contas', { corpo: dados });

    const r = await s.post('/sessoes', { corpo: { email: dados.email, senha: dados.senha } });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
    assert.equal(r.json.conta.email, dados.email);
  });

  test('senha errada é 401', async () => {
    const dados = conta();
    await s.post('/contas', { corpo: dados });
    const r = await s.post('/sessoes', { corpo: { email: dados.email, senha: 'outra-senha' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.codigo, 'credenciais_invalidas');
  });

  test('e-mail que não existe dá o MESMO 401', async () => {
    const r = await s.post('/sessoes', { corpo: { email: 'ninguem@naregua.local', senha: 'qualquer' } });
    assert.equal(r.status, 401);
    assert.equal(r.json.codigo, 'credenciais_invalidas');
  });

  test('conta bloqueada é 403, sem o motivo', async () => {
    const dados = conta();
    const c = await s.post('/contas', { corpo: dados });
    await pool.query(
      'INSERT INTO bloqueio_conta (id_conta, motivo) VALUES ($1, $2)',
      [c.json.id, 'motivo interno da plataforma'],
    );

    const r = await s.post('/sessoes', { corpo: { email: dados.email, senha: dados.senha } });
    assert.equal(r.status, 403);
    assert.ok(!r.texto.includes('motivo interno'));
  });
});

describe('/eu', () => {
  test('devolve a conta do token', async () => {
    const dados = conta();
    await s.post('/contas', { corpo: dados });
    const { json } = await s.post('/sessoes', { corpo: { email: dados.email, senha: dados.senha } });

    const r = await s.get('/eu', { token: json.token });
    assert.equal(r.status, 200);
    assert.equal(r.json.email, dados.email);
    assert.equal(r.json.senha_hash, undefined);
  });

  test('sem token é 401', async () => {
    assert.equal((await s.get('/eu')).status, 401);
  });

  test('token de conta apagada é 401, não 404', async () => {
    // Quem pergunta é a sessão, e a resposta é "esta sessão não vale".
    const dados = conta();
    const c = await s.post('/contas', { corpo: dados });
    const { json } = await s.post('/sessoes', { corpo: { email: dados.email, senha: dados.senha } });
    await pool.query('DELETE FROM conta WHERE id = $1', [c.json.id]);

    const r = await s.get('/eu', { token: json.token });
    assert.equal(r.status, 401);
  });
});

describe('CORS', () => {
  test('a origem do frontend é a permitida', async () => {
    const r = await s.get('/saude');
    assert.equal(r.cabecalhos.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('o preflight é respondido', async () => {
    const r = await s.options('/sessoes');
    assert.equal(r.status, 204);
  });
});
