/**
 * Agendamento — o núcleo.
 *
 * O caso que mais importa é o da concorrência: N clientes tocando
 * "agendar" no mesmo instante, para o mesmo barbeiro e o mesmo horário.
 * Exatamente um pode entrar. É o critério de sucesso do MVP, e a única
 * forma de prová-lo é disparar os pedidos de verdade, em paralelo, contra
 * o banco de verdade.
 *
 * Os demais testes cercam o que a constraint NÃO cobre: expediente,
 * bloqueio, horário no passado, e quem pode cancelar o quê.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from '../src/db.js';
import {
  agendar, cancelar, concluir, marcarFalta,
  agendaDoDia, meusAgendamentos, horariosLivres, somarMinutos,
  AgendamentoRecusado,
} from '../src/agendamentos.js';

const BARBEARIA = '11111111-1111-1111-1111-111111111111';
const BARBEIRO = 'bbbbbbbb-1111-1111-1111-111111111111';
const OUTRO_BARBEIRO = 'bbbbbbbb-2222-2222-2222-222222222222';
const SERVICO = 'cccccccc-1111-1111-1111-111111111111';
const CLIENTE = 'dddddddd-1111-1111-1111-111111111111';
const cliente = (i) => `dddddddd-0000-0000-0000-${String(i).padStart(12, '0')}`;

/** Uma terça-feira bem no futuro, para o teste não vencer com o tempo. */
const DIA = '2027-03-09';
const DIA_DA_SEMANA = 2;  // terça

before(async () => { await pool.query('SELECT 1'); });

beforeEach(async () => {
  await pool.query('TRUNCATE agendamento, expediente_espelho, bloqueio_espelho, outbox CASCADE');
  // Os dois barbeiros trabalham das 9h às 18h na terça.
  for (const b of [BARBEIRO, OUTRO_BARBEIRO]) {
    await pool.query(
      `INSERT INTO expediente_espelho (id_barbeiro, dia_da_semana, comeca_em, termina_em)
       VALUES ($1, $2, '09:00', '18:00')`,
      [b, DIA_DA_SEMANA],
    );
  }
});

after(async () => { await pool.end(); });

const marcar = (extra = {}) => agendar({
  idBarbearia: BARBEARIA, idBarbeiro: BARBEIRO, idServico: SERVICO,
  idCliente: CLIENTE, dia: DIA, comecaEm: '10:00', duracaoMin: 30,
  valorCentavos: 4500, ...extra,
});

describe('a cadeira só aceita um — o critério do MVP', () => {
  test('(a) 30 pedidos SIMULTÂNEOS para o mesmo horário: exatamente um aceito', async () => {
    const quantos = 30;
    const resultados = await Promise.allSettled(
      Array.from({ length: quantos }, (_, i) => marcar({ idCliente: cliente(i) })),
    );

    const aceitos = resultados.filter((r) => r.status === 'fulfilled');
    const recusados = resultados.filter((r) => r.status === 'rejected');

    assert.equal(aceitos.length, 1, 'mais de um cliente ficou com a mesma cadeira');
    assert.equal(recusados.length, quantos - 1);

    // A recusa tem de ser de NEGÓCIO, não um 500 vazando do Postgres: é
    // o que deixa a tela dizer "esse horário acabou de ser preenchido".
    for (const r of recusados) {
      assert.ok(r.reason instanceof AgendamentoRecusado, `recusa inesperada: ${r.reason?.message}`);
      assert.equal(r.reason.codigo, 'horario_ocupado');
    }

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM agendamento WHERE id_barbeiro = $1', [BARBEIRO],
    );
    assert.equal(rows[0].n, 1, 'o banco tem de ter exatamente um');
  });

  test('(b) o aceito está no banco, e é o que foi devolvido ao cliente', async () => {
    const resultados = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => marcar({ idCliente: cliente(i) })),
    );
    const aceito = resultados.find((r) => r.status === 'fulfilled').value;

    const { rows } = await pool.query('SELECT * FROM agendamento');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].id, aceito.id, 'confirmou um id e gravou outro');
    assert.equal(rows[0].id_cliente, aceito.id_cliente);
  });

  test('(c) cada cliente aceito gerou UM evento, e nenhum recusado gerou', async () => {
    await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) => marcar({ idCliente: cliente(i) })),
    );
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE tipo_evento = 'agendamento_criado'",
    );
    assert.equal(rows[0].n, 1, 'evento de agendamento que não existe foi publicado');
  });

  test('(d) outra cadeira no mesmo horário é aceita', async () => {
    // A barbearia tem mais de um barbeiro. Bloquear isso quebraria o
    // negócio inteiro.
    await marcar();
    const outro = await marcar({ idBarbeiro: OUTRO_BARBEIRO, idCliente: cliente(99) });
    assert.equal(outro.id_barbeiro, OUTRO_BARBEIRO);
  });

  test('(e) horário encostado é aceito: 10h30 começa onde o outro terminou', async () => {
    // O intervalo é '[)'. Com '[]' a agenda perderia um horário a cada
    // atendimento.
    await marcar({ comecaEm: '10:00', duracaoMin: 30 });
    const seguinte = await marcar({ comecaEm: '10:30', idCliente: cliente(2) });
    assert.equal(seguinte.comeca_em, '10:30:00');
  });

  test('(f) cancelar libera a cadeira', async () => {
    const primeiro = await marcar();
    await cancelar(primeiro.id, { por: 'cliente', idQuemPede: CLIENTE });

    const segundo = await marcar({ idCliente: cliente(3) });
    assert.ok(segundo.id);
    assert.notEqual(segundo.id, primeiro.id);
  });

  test('(g) falta também libera: a cadeira esteve vaga de verdade', async () => {
    const primeiro = await marcar();
    await marcarFalta(primeiro.id);
    const segundo = await marcar({ idCliente: cliente(4) });
    assert.ok(segundo.id);
  });

  test('(h) atendimento CONCLUÍDO não libera', async () => {
    // Concluído ocupou a cadeira. Liberar permitiria marcar por cima do
    // histórico e quebraria o relatório do dono.
    const primeiro = await marcar();
    await concluir(primeiro.id);
    await assert.rejects(
      () => marcar({ idCliente: cliente(5) }),
      (e) => e.codigo === 'horario_ocupado',
    );
  });
});

describe('o que a constraint não cobre', () => {
  test('fora do expediente é recusado', async () => {
    await assert.rejects(
      () => marcar({ comecaEm: '19:00' }),
      (e) => e.codigo === 'fora_do_expediente',
    );
  });

  test('atendimento que passa do fim do expediente é recusado', async () => {
    // Começa 17h45 e dura 30 min: terminaria 18h15, depois do fechamento.
    await assert.rejects(
      () => marcar({ comecaEm: '17:45', duracaoMin: 30 }),
      (e) => e.codigo === 'fora_do_expediente',
    );
  });

  test('dia em que o barbeiro não trabalha é recusado', async () => {
    await assert.rejects(
      () => marcar({ dia: '2027-03-08' }),     // segunda
      (e) => e.codigo === 'fora_do_expediente',
    );
  });

  test('horário bloqueado é recusado', async () => {
    await pool.query(
      `INSERT INTO bloqueio_espelho (id, id_barbeiro, comeca_em, termina_em, motivo)
       VALUES (gen_random_uuid(), $1,
               ($2::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo',
               ($2::date + time '13:00') AT TIME ZONE 'America/Sao_Paulo', 'almoço')`,
      [BARBEIRO, DIA],
    );
    await assert.rejects(
      () => marcar({ comecaEm: '12:15' }),
      (e) => e.codigo === 'horario_bloqueado',
    );
  });

  test('horário no passado é recusado', async () => {
    await pool.query(
      `INSERT INTO expediente_espelho (id_barbeiro, dia_da_semana, comeca_em, termina_em)
       VALUES ($1, EXTRACT(DOW FROM CURRENT_DATE - 1), '00:00', '23:59')`,
      [BARBEIRO],
    );
    const { rows: [{ ontem }] } = await pool.query(
      "SELECT (CURRENT_DATE - 1)::text AS ontem",
    );
    await assert.rejects(
      () => marcar({ dia: ontem, comecaEm: '10:00' }),
      (e) => e.codigo === 'horario_no_passado',
    );
  });

  test('sem cliente e sem encaixe é recusado', async () => {
    await assert.rejects(
      () => marcar({ idCliente: null }),
      (e) => e.codigo === 'sem_dono',
    );
  });

  test('encaixe no balcão ocupa a cadeira igual', async () => {
    const encaixe = await marcar({ idCliente: null, nomeEncaixe: 'Seu Zé', origem: 'painel' });
    assert.equal(encaixe.nome_encaixe, 'Seu Zé');

    await assert.rejects(
      () => marcar({ idCliente: cliente(6) }),
      (e) => e.codigo === 'horario_ocupado',
    );
  });

  test('atendimento que atravessaria a meia-noite é recusado', async () => {
    await pool.query(
      `INSERT INTO expediente_espelho (id_barbeiro, dia_da_semana, comeca_em, termina_em)
       VALUES ($1, $2, '23:00', '23:59')`,
      [BARBEIRO, DIA_DA_SEMANA],
    );
    await assert.rejects(
      () => marcar({ comecaEm: '23:50', duracaoMin: 30 }),
      (e) => e.codigo === 'atravessa_a_meia_noite',
    );
  });
});

describe('cancelamento', () => {
  test('o cliente cancela o próprio', async () => {
    const a = await marcar();
    const r = await cancelar(a.id, { por: 'cliente', idQuemPede: CLIENTE });
    assert.equal(r.cancelado, true);
    assert.equal(r.agendamento.status, 'cancelado_pelo_cliente');
  });

  test('o cliente NÃO cancela o dos outros', async () => {
    // Sem esta regra, qualquer sessão válida cancelaria o corte de
    // qualquer pessoa sabendo o id.
    const a = await marcar();
    await assert.rejects(
      () => cancelar(a.id, { por: 'cliente', idQuemPede: cliente(7) }),
      (e) => e.codigo === 'nao_e_seu',
    );
  });

  test('a barbearia cancela, e o status diz quem foi', async () => {
    const a = await marcar();
    const r = await cancelar(a.id, { por: 'barbearia', idQuemPede: BARBEARIA });
    assert.equal(r.agendamento.status, 'cancelado_pela_barbearia');
  });

  test('cancelar duas vezes não publica dois eventos', async () => {
    const a = await marcar();
    await cancelar(a.id, { por: 'cliente', idQuemPede: CLIENTE });
    const segunda = await cancelar(a.id, { por: 'cliente', idQuemPede: CLIENTE });

    assert.equal(segunda.cancelado, false);
    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE tipo_evento = 'agendamento_cancelado'",
    );
    assert.equal(rows[0].n, 1);
  });
});

describe('conclusão', () => {
  test('conclui e publica o evento que dá direito a avaliar', async () => {
    const a = await marcar();
    const r = await concluir(a.id);
    assert.equal(r.concluido, true);

    const { rows } = await pool.query(
      "SELECT payload FROM outbox WHERE tipo_evento = 'atendimento_concluido'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.id_agendamento, a.id);
  });

  test('concluir duas vezes não publica dois eventos', async () => {
    const a = await marcar();
    await concluir(a.id);
    const segunda = await concluir(a.id);
    assert.equal(segunda.concluido, false);

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE tipo_evento = 'atendimento_concluido'",
    );
    assert.equal(rows[0].n, 1);
  });

  test('cancelado não vira concluído', async () => {
    const a = await marcar();
    await cancelar(a.id, { por: 'cliente', idQuemPede: CLIENTE });
    await assert.rejects(
      () => concluir(a.id),
      (e) => e.codigo === 'nao_esta_agendado',
    );
  });
});

describe('consultas', () => {
  test('a agenda do dia vem em ordem de horário', async () => {
    await marcar({ comecaEm: '14:00', idCliente: cliente(10) });
    await marcar({ comecaEm: '09:00', idCliente: cliente(11) });
    await marcar({ comecaEm: '11:00', idCliente: cliente(12) });

    const agenda = await agendaDoDia(BARBEARIA, DIA);
    assert.deepEqual(agenda.map((a) => a.comeca_em), ['09:00:00', '11:00:00', '14:00:00']);
  });

  test('meus agendamentos traz só os meus', async () => {
    await marcar({ comecaEm: '09:00' });
    await marcar({ comecaEm: '11:00', idCliente: cliente(20) });

    const meus = await meusAgendamentos(CLIENTE);
    assert.equal(meus.length, 1);
    assert.equal(meus[0].id_cliente, CLIENTE);
  });

  test('horários livres descontam o que já está marcado', async () => {
    const antes = await horariosLivres(BARBEIRO, DIA, 30);
    assert.ok(antes.includes('10:00'));

    await marcar({ comecaEm: '10:00', duracaoMin: 30 });
    const depois = await horariosLivres(BARBEIRO, DIA, 30);

    assert.ok(!depois.includes('10:00'), 'horário tomado continuou na lista');
    assert.ok(!depois.includes('09:45'), 'um atendimento de 30 min invade as 09:45');
    assert.ok(depois.includes('10:30'), 'o horário encostado continua livre');
  });

  test('horários livres descontam bloqueio', async () => {
    await pool.query(
      `INSERT INTO bloqueio_espelho (id, id_barbeiro, comeca_em, termina_em, motivo)
       VALUES (gen_random_uuid(), $1,
               ($2::date + time '12:00') AT TIME ZONE 'America/Sao_Paulo',
               ($2::date + time '13:00') AT TIME ZONE 'America/Sao_Paulo', 'almoço')`,
      [BARBEIRO, DIA],
    );
    const livres = await horariosLivres(BARBEIRO, DIA, 30);
    assert.ok(!livres.includes('12:00'));
    assert.ok(!livres.includes('12:30'));
    assert.ok(livres.includes('13:00'));
  });

  test('sem expediente no dia, não há horário livre', async () => {
    assert.deepEqual(await horariosLivres(BARBEIRO, '2027-03-08', 30), []);
  });

  test('a lista de livres é consulta, não garantia', async () => {
    // Entre ver o horário livre e marcar, outra pessoa pode marcar. É por
    // isso que a tela precisa tratar `horario_ocupado` mesmo tendo acabado
    // de mostrar o horário como livre.
    const livres = await horariosLivres(BARBEIRO, DIA, 30);
    assert.ok(livres.includes('10:00'));

    const [primeiro, segundo] = await Promise.allSettled([
      marcar({ idCliente: cliente(30) }),
      marcar({ idCliente: cliente(31) }),
    ]);
    const falhou = [primeiro, segundo].find((r) => r.status === 'rejected');
    assert.equal(falhou.reason.codigo, 'horario_ocupado');
  });
});

describe('somarMinutos', () => {
  test('soma dentro do dia', () => {
    assert.equal(somarMinutos('10:00', 30), '10:30');
    assert.equal(somarMinutos('09:45', 45), '10:30');
  });

  test('devolve null quando atravessaria a meia-noite', () => {
    assert.equal(somarMinutos('23:50', 30), null);
  });
});
