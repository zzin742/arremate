import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { agendar, cancelar, agendaDoEquipamento, ErroDeVisita } from '../src/visitas.js';

const MAQUINA = '11111111-1111-1111-1111-111111111111';
const OUTRA = '99999999-9999-9999-9999-999999999999';
const EMPRESA_A = '22222222-2222-2222-2222-222222222222';
const EMPRESA_B = '33333333-3333-3333-3333-333333333333';

// amanhã, para nunca cair no passado
const dia = (hora, min = 0) => {
  const d = new Date(Date.now() + 86_400_000);
  d.setUTCHours(hora, min, 0, 0);
  return d.toISOString();
};

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => { await pool.query('TRUNCATE visita'); });
after(async () => { await pool.end(); });

describe('agendamento (RF-024)', () => {
  test('agenda e devolve o período', async () => {
    const v = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11),
    });
    assert.equal(v.status, 'agendada');
    assert.ok(v.inicio && v.fim);
  });

  test('recusa fim antes do início e período no passado', async () => {
    await assert.rejects(
      () => agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(11), fim: dia(9) }),
      (e) => e.codigo === 'periodo_invalido' && e.status === 400,
    );
    await assert.rejects(
      () => agendar({
        idEquipamento: MAQUINA, idEmpresa: EMPRESA_A,
        inicio: new Date(Date.now() - 86_400_000).toISOString(),
        fim: new Date(Date.now() - 80_000_000).toISOString(),
      }),
      (e) => e.codigo === 'periodo_no_passado',
    );
  });
});

describe('RF-025 — a regra é do banco, não do código', () => {
  test('sobreposição no mesmo equipamento é recusada', async () => {
    await agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11) });

    await assert.rejects(
      () => agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_B, inicio: dia(10), fim: dia(12) }),
      (e) => e instanceof ErroDeVisita && e.codigo === 'horario_ocupado',
      'o banco recusa com exclusion_violation; a aplicação só traduz',
    );
  });

  test('visitas encostadas passam: fim de uma = início da outra', async () => {
    await agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11) });
    const v = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_B, inicio: dia(11), fim: dia(13),
    });
    assert.ok(v.id, 'tstzrange é [início, fim) — encostar não é sobrepor');
  });

  test('mesmo horário em equipamento diferente passa', async () => {
    await agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11) });
    const v = await agendar({
      idEquipamento: OUTRA, idEmpresa: EMPRESA_B, inicio: dia(9), fim: dia(11),
    });
    assert.ok(v.id, 'a exclusão é por equipamento');
  });

  test('CONCORRÊNCIA: dois pedidos simultâneos, só um vence', async () => {
    const r = await Promise.allSettled([
      agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11) }),
      agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_B, inicio: dia(10), fim: dia(12) }),
    ]);

    const aceitos = r.filter((x) => x.status === 'fulfilled');
    assert.equal(aceitos.length, 1,
      'verificar antes e inserir depois teria janela; a constraint não tem');

    const recusado = r.find((x) => x.status === 'rejected');
    assert.equal(recusado.reason.codigo, 'horario_ocupado');
  });
});

describe('cancelamento (RF-026)', () => {
  test('cancelar libera o horário', async () => {
    const v = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11),
    });
    await cancelar(v.id, EMPRESA_A);

    const nova = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_B, inicio: dia(9), fim: dia(11),
    });
    assert.ok(nova.id, 'é para isto que a constraint tem WHERE status = agendada');
  });

  test('não dá para cancelar visita de outra empresa', async () => {
    const v = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11),
    });
    await assert.rejects(
      () => cancelar(v.id, EMPRESA_B),
      (e) => e.codigo === 'visita_nao_cancelavel' && e.status === 404,
    );
  });

  test('cancelar duas vezes não funciona na segunda', async () => {
    const v = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(11),
    });
    await cancelar(v.id, EMPRESA_A);
    await assert.rejects(() => cancelar(v.id, EMPRESA_A));
  });
});

describe('agenda do equipamento', () => {
  test('lista só as agendadas e futuras, em ordem', async () => {
    const manha = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(9), fim: dia(10),
    });
    await agendar({ idEquipamento: MAQUINA, idEmpresa: EMPRESA_B, inicio: dia(14), fim: dia(15) });
    const cancelada = await agendar({
      idEquipamento: MAQUINA, idEmpresa: EMPRESA_A, inicio: dia(16), fim: dia(17),
    });
    await cancelar(cancelada.id, EMPRESA_A);

    const agenda = await agendaDoEquipamento(MAQUINA);
    assert.equal(agenda.length, 2, 'cancelada não aparece');
    assert.equal(agenda[0].id, manha.id, 'ordenada por início');
  });
});
