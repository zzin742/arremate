/**
 * Camada HTTP do agendamento.
 *
 * O que vale provar aqui é a tradução: cada recusa de negócio tem de
 * chegar ao navegador com o status que deixa a tela dizer a coisa certa.
 * Um 500 no lugar de um 409 transforma "esse horário acabou de ser
 * preenchido" em "erro interno", e o cliente desiste.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { AUDIENCIA_SESSAO, assinar } from '@naregua/shared';
import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';
const BARBEARIA = '11111111-1111-1111-1111-111111111111';
const BARBEIRO = 'bbbbbbbb-1111-1111-1111-111111111111';
const SERVICO = 'cccccccc-1111-1111-1111-111111111111';
const CLIENTE = 'dddddddd-1111-1111-1111-111111111111';
const OUTRO = 'dddddddd-2222-2222-2222-222222222222';

const DIA = '2027-03-09';
const DIA_DA_SEMANA = 2;

const token = (sub) => assinar({ sub }, SEGREDO, { audiencia: AUDIENCIA_SESSAO, expiraEm: '1h' });

let s;

before(async () => { await pool.query('SELECT 1'); s = await subir(app); });

beforeEach(async () => {
  await pool.query('TRUNCATE agendamento, expediente_espelho, bloqueio_espelho, outbox CASCADE');
  await pool.query(
    `INSERT INTO expediente_espelho (id_barbeiro, dia_da_semana, comeca_em, termina_em)
     VALUES ($1, $2, '09:00', '18:00')`,
    [BARBEIRO, DIA_DA_SEMANA],
  );
});

after(async () => { await s.fechar(); await pool.end(); });

const corpo = (extra = {}) => ({
  idBarbearia: BARBEARIA, idBarbeiro: BARBEIRO, idServico: SERVICO,
  dia: DIA, comecaEm: '10:00', duracaoMin: 30, valorCentavos: 4500, ...extra,
});

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    assert.deepEqual((await s.get('/saude')).json, { servico: 'agd', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    assert.equal((await s.get('/api/agd/saude')).status, 200);
  });

  test('métricas no formato do Prometheus', async () => {
    const r = await s.get('/metricas');
    assert.equal(r.status, 200);
    assert.match(r.texto, /# HELP/);
  });
});

describe('marcar', () => {
  test('marca e devolve 201', async () => {
    const r = await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo() });
    assert.equal(r.status, 201);
    assert.equal(r.json.id_cliente, CLIENTE, 'o dono sai do token, não do corpo');
    assert.equal(r.json.termina_em, '10:30:00');
  });

  test('sem token é 401', async () => {
    const r = await s.post('/agendamentos', { corpo: corpo() });
    assert.equal(r.status, 401);
    assert.equal(r.json.codigo, 'nao_autenticado');
  });

  test('horário tomado é 409, não 500', async () => {
    // É a diferença entre a tela dizer "esse horário acabou de ser
    // preenchido" e dizer "erro interno".
    await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo() });
    const r = await s.post('/agendamentos', { token: token(OUTRO), corpo: corpo() });

    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'horario_ocupado');
  });

  test('fora do expediente é 422, com o motivo', async () => {
    const r = await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo({ comecaEm: '19:00' }) });
    assert.equal(r.status, 422);
    assert.equal(r.json.codigo, 'fora_do_expediente');
  });

  test('dia em formato errado é 400, não 500', async () => {
    const r = await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo({ dia: '09/03/2027' }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('id que não é UUID é 400', async () => {
    const r = await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo({ idBarbeiro: 'abc' }) });
    assert.equal(r.status, 400);
  });
});

describe('encaixe', () => {
  test('o balcão anota sem conta de cliente', async () => {
    const r = await s.post('/encaixes', {
      token: token(CLIENTE),
      corpo: corpo({ nomeEncaixe: 'Seu Zé', whatsappEncaixe: '11999998888' }),
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.id_cliente, null);
    assert.equal(r.json.nome_encaixe, 'Seu Zé');
    assert.equal(r.json.origem, 'painel');
  });

  test('encaixe sem nome é 400', async () => {
    const r = await s.post('/encaixes', { token: token(CLIENTE), corpo: corpo() });
    assert.equal(r.status, 400);
  });
});

describe('cancelar', () => {
  test('o cliente cancela o próprio', async () => {
    const a = await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo() });
    const r = await s.post(`/agendamentos/${a.json.id}/cancelar`, {
      token: token(CLIENTE), corpo: { por: 'cliente' },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.agendamento.status, 'cancelado_pelo_cliente');
  });

  test('cancelar o dos outros é 403', async () => {
    const a = await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo() });
    const r = await s.post(`/agendamentos/${a.json.id}/cancelar`, {
      token: token(OUTRO), corpo: { por: 'cliente' },
    });
    assert.equal(r.status, 403);
    assert.equal(r.json.codigo, 'nao_e_seu');
  });

  test('agendamento que não existe é 404', async () => {
    const r = await s.post(`/agendamentos/${crypto.randomUUID()}/cancelar`, {
      token: token(CLIENTE), corpo: { por: 'cliente' },
    });
    assert.equal(r.status, 404);
  });
});

describe('consultas', () => {
  test('horários livres não exige sessão', async () => {
    // O cliente precisa ver a agenda antes de criar conta, senão a
    // barbearia perde a visita.
    const r = await s.get(`/barbeiros/${BARBEIRO}/livres?dia=${DIA}&duracaoMin=30`);
    assert.equal(r.status, 200);
    assert.ok(r.json.includes('10:00'));
  });

  test('a lista some o horário depois de marcado', async () => {
    await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo() });
    const r = await s.get(`/barbeiros/${BARBEIRO}/livres?dia=${DIA}&duracaoMin=30`);
    assert.ok(!r.json.includes('10:00'));
  });

  test('a agenda do dia exige sessão', async () => {
    assert.equal((await s.get(`/barbearias/${BARBEARIA}/agenda?dia=${DIA}`)).status, 401);
  });

  test('meus agendamentos traz só os meus', async () => {
    await s.post('/agendamentos', { token: token(CLIENTE), corpo: corpo({ comecaEm: '09:00' }) });
    await s.post('/agendamentos', { token: token(OUTRO), corpo: corpo({ comecaEm: '11:00' }) });

    const r = await s.get('/meus-agendamentos', { token: token(CLIENTE) });
    assert.equal(r.json.length, 1);
    assert.equal(r.json[0].id_cliente, CLIENTE);
  });
});

describe('CORS', () => {
  test('a origem do frontend é a permitida', async () => {
    const r = await s.get('/saude');
    assert.equal(r.cabecalhos.get('access-control-allow-origin'), 'http://localhost:5173');
  });

  test('o preflight é respondido', async () => {
    const r = await s.options('/agendamentos');
    assert.equal(r.status, 204);
    assert.match(r.cabecalhos.get('access-control-allow-headers'), /Authorization/i);
  });
});
