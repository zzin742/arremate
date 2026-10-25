/**
 * Camada HTTP do AUTH.
 *
 * Os testes de `empresas.test.js` provam a regra; estes provam o que o
 * cliente vê — código de status, formato do erro e o que acontece com
 * entrada malformada. A distinção importa: `cadastrar()` rejeitar CNPJ
 * inválido não diz nada sobre a rota devolver 400 em vez de 500.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const CNPJ = '11222333000181';
const CNPJ2 = '11444777000161';

let s;

before(async () => {
  await pool.query('SELECT 1'); // falha cedo e claro se o banco não subiu
  s = await subir(app);
});
beforeEach(async () => { await pool.query('TRUNCATE empresa, outbox'); });
after(async () => { await s.fechar(); await pool.end(); });

const empresa = (extra = {}) => ({
  cnpj: CNPJ,
  razaoSocial: 'Metalurgica Teste LTDA',
  email: 'teste@arremate.dev',
  senha: 'senhaforte123',
  ...extra,
});

describe('rotas de saúde e métricas', () => {
  test('saúde responde sem tocar no banco', async () => {
    const r = await s.get('/saude');
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, { servico: 'auth', ok: true });
  });

  test('o mesmo caminho responde com e sem o prefixo do ALB', async () => {
    // o ALB encaminha `/api/auth/saude` sem reescrever; foi o que
    // devolveu 404 em toda rota na primeira subida (ADR-015)
    const semPrefixo = await s.get('/saude');
    const comPrefixo = await s.get('/api/auth/saude');
    assert.equal(comPrefixo.status, 200);
    assert.deepEqual(comPrefixo.json, semPrefixo.json);
  });

  test('métricas saem no formato que o Prometheus lê', async () => {
    const r = await s.get('/metricas');
    assert.equal(r.status, 200);
    assert.match(r.cabecalhos.get('content-type'), /text\/plain/);
    assert.match(r.texto, /^# HELP /m);
  });
});

describe('cadastro de empresa (RF-001)', () => {
  test('cadastra e devolve 201 sem a senha no corpo', async () => {
    const r = await s.post('/empresas', { corpo: empresa() });
    assert.equal(r.status, 201);
    assert.equal(r.json.cnpj, CNPJ);
    assert.ok(r.json.id);
    assert.ok(!('senha' in r.json), 'a senha não pode voltar na resposta');
    assert.ok(!('senha_hash' in r.json), 'nem o hash dela');
  });

  test('campo faltando é 400, não 500', async () => {
    const { senha, ...semSenha } = empresa();
    const r = await s.post('/empresas', { corpo: semSenha });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
    assert.ok(Array.isArray(r.json.detalhes));
  });

  test('senha curta é recusada pelo esquema', async () => {
    const r = await s.post('/empresas', { corpo: empresa({ senha: '1234' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('e-mail malformado é recusado', async () => {
    const r = await s.post('/empresas', { corpo: empresa({ email: 'nao-e-email' }) });
    assert.equal(r.status, 400);
  });

  test('CNPJ com dígito verificador errado é erro de regra, não de esquema', async () => {
    // Os dois dão 400, mas o corpo é diferente, e é o corpo que o
    // frontend usa: `dados_invalidos` aponta o campo que falta;
    // `cnpj_invalido` traz mensagem para mostrar ao usuário. Conferir
    // só o status deixaria passar a troca de um pelo outro.
    const r = await s.post('/empresas', { corpo: empresa({ cnpj: '11222333000182' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'cnpj_invalido');
    assert.ok(r.json.mensagem, 'erro de regra traz mensagem legível');
    assert.ok(!('detalhes' in r.json), 'isto não é erro de esquema');
  });

  test('corpo que não é JSON não derruba o serviço', async () => {
    const r = await s.post('/empresas', {
      cabecalhos: { 'Content-Type': 'application/json' },
    });
    assert.ok(r.status >= 400 && r.status < 500, `esperava erro do cliente, veio ${r.status}`);

    const depois = await s.get('/saude');
    assert.equal(depois.status, 200, 'o serviço tem de continuar de pé');
  });

  test('CNPJ repetido é conflito, não erro interno', async () => {
    await s.post('/empresas', { corpo: empresa() });
    const r = await s.post('/empresas', { corpo: empresa({ email: 'outro@arremate.dev' }) });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'cnpj_ja_cadastrado');
  });
});

describe('login (RF-002)', () => {
  test('devolve token com as credenciais certas', async () => {
    await s.post('/empresas', { corpo: empresa() });
    const r = await s.post('/sessoes', {
      corpo: { email: 'teste@arremate.dev', senha: 'senhaforte123' },
    });
    assert.equal(r.status, 200);
    assert.ok(r.json.token);
  });

  test('senha errada e e-mail inexistente dão a MESMA resposta', async () => {
    // responder diferente diria a um atacante quais e-mails existem
    await s.post('/empresas', { corpo: empresa() });

    const senhaErrada = await s.post('/sessoes', {
      corpo: { email: 'teste@arremate.dev', senha: 'errada123' },
    });
    const naoExiste = await s.post('/sessoes', {
      corpo: { email: 'ninguem@arremate.dev', senha: 'errada123' },
    });

    assert.equal(senhaErrada.status, naoExiste.status);
    assert.deepEqual(senhaErrada.json, naoExiste.json);
    assert.equal(senhaErrada.status, 401);
  });

  test('senha vazia é 400, não 401', async () => {
    const r = await s.post('/sessoes', { corpo: { email: 'teste@arremate.dev', senha: '' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });
});

describe('rota protegida (RF-002)', () => {
  test('token válido identifica a empresa', async () => {
    const criada = await s.post('/empresas', { corpo: empresa({ cnpj: CNPJ2 }) });
    const { json: { token } } = await s.post('/sessoes', {
      corpo: { email: 'teste@arremate.dev', senha: 'senhaforte123' },
    });

    const r = await s.get('/eu', { token });
    assert.equal(r.status, 200);
    assert.equal(r.json.id, criada.json.id);
  });

  test('sem cabeçalho de autorização é 401', async () => {
    const r = await s.get('/eu');
    assert.equal(r.status, 401);
    assert.equal(r.json.codigo, 'token_invalido');
  });

  test('token adulterado é 401, não 500', async () => {
    const { json: { token } } = await s.post('/empresas', { corpo: empresa() })
      .then(() => s.post('/sessoes', {
        corpo: { email: 'teste@arremate.dev', senha: 'senhaforte123' },
      }));

    // troca o último caractere: assinatura deixa de bater
    const adulterado = token.slice(0, -1) + (token.at(-1) === 'a' ? 'b' : 'a');
    const r = await s.get('/eu', { token: adulterado });
    assert.equal(r.status, 401);
  });
});

describe('CORS', () => {
  test('a requisição de sondagem responde 204 e não chega na rota', async () => {
    const r = await s.options('/empresas');
    assert.equal(r.status, 204);
    assert.equal(r.cabecalhos.get('access-control-allow-origin'), 'http://localhost:5173');
  });
});
