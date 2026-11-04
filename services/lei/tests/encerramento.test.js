/**
 * Encerramento (RF-018), prorrogação (RF-017) e anulação (RF-004b).
 *
 * O caso que mais importa é o último deste arquivo: um lance entrando
 * enquanto o encerrador espera a trava. É a janela que o critério do
 * T-011 nomeia — "encerrador relê `encerra_em` sob a mesma trava" — e a
 * única forma de provar que a releitura serve para algo é fazer o prazo
 * mudar durante a espera.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from '../src/db.js';
import { registrarLance, abrirLeilao } from '../src/lances.js';
import { encerrarLeilao, anularArremate, encerrarVencidos } from '../src/encerramento.js';

const VENDEDOR = '11111111-1111-1111-1111-111111111111';
const COMPRADOR = '22222222-2222-2222-2222-222222222222';
const OUTRO = '33333333-3333-3333-3333-333333333333';

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => {
  await pool.query('TRUNCATE arremate, lance, leilao, outbox, caucao_ativa CASCADE');
});
after(async () => { await pool.end(); });

/** Prazo pelo relógio do banco: é ele que julga o vencimento. */
async function daquiA(texto) {
  const { rows } = await pool.query(
    `SELECT clock_timestamp() + $1::interval AS t`, [texto],
  );
  return rows[0].t.toISOString();
}

async function leilao({ prazo = '10 minutes' } = {}) {
  const l = await abrirLeilao({
    idEmpresa: VENDEDOR,
    descricaoEquipamento: 'Torno mecânico 1998',
    lanceInicial: 1000,
    incrementoMin: 100,
    encerraEm: await daquiA(prazo),
  });

  await Promise.all([COMPRADOR, OUTRO].map((empresa, i) => pool.query(
    `INSERT INTO caucao_ativa (id_leilao, id_empresa, id_caucao)
     VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
    [l.id, empresa, `cccccccc-0000-0000-0000-${String(i).padStart(12, '0')}`],
  )));

  return l;
}

/** Vence o prazo sem esperar: o relógio é do banco, então mexe no banco. */
const vencer = (id) => pool.query(
  "UPDATE leilao SET encerra_em = clock_timestamp() - interval '1 second' WHERE id = $1",
  [id],
);

describe('encerramento (RF-018)', () => {
  test('com lance: grava arremate e vai para encerrado', async () => {
    const l = await leilao();
    const lance = await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });
    await vencer(l.id);

    const r = await encerrarLeilao(l.id);

    assert.equal(r.encerrado, true);
    assert.equal(r.deserto, false);
    assert.equal(r.leilao.status, 'encerrado');
    assert.equal(r.arremate.id_lance, lance.id);
  });

  test('sem lance: deserto, e NENHUM registro em arremate', async () => {
    const l = await leilao();
    await vencer(l.id);

    const r = await encerrarLeilao(l.id);

    assert.equal(r.leilao.status, 'deserto');
    assert.equal(r.arremate, null);

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM arremate WHERE id_leilao = $1', [l.id],
    );
    assert.equal(rows[0].n, 0, 'leilão deserto não pode gerar arremate');
  });

  test('o arremate é do MAIOR lance, não do último inserido', async () => {
    // Com a sequência crescente os dois coincidem; o teste existe para
    // o dia em que alguém trocar a ordenação por `criado_em`.
    const l = await leilao();
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });
    const maior = await registrarLance({ idLeilao: l.id, idEmpresa: OUTRO, valor: 5000 });
    await vencer(l.id);

    const r = await encerrarLeilao(l.id);
    assert.equal(r.arremate.id_lance, maior.id);
    assert.equal(Number(r.lance.valor), 5000);
  });

  test('nenhum lance entra depois de encerrado', async () => {
    const l = await leilao();
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });
    await vencer(l.id);
    await encerrarLeilao(l.id);

    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: OUTRO, valor: 9000 }),
      (e) => e.codigo === 'leilao_nao_esta_aberto',
    );
  });

  test('encerrar duas vezes não grava dois arremates', async () => {
    // O encerrador roda por tempo e vai reencontrar o mesmo leilão.
    const l = await leilao();
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });
    await vencer(l.id);

    await encerrarLeilao(l.id);
    const segunda = await encerrarLeilao(l.id);

    assert.equal(segunda.encerrado, false);
    assert.equal(segunda.motivo, 'status_encerrado');

    const { rows } = await pool.query(
      'SELECT count(*)::int AS n FROM arremate WHERE id_leilao = $1', [l.id],
    );
    assert.equal(rows[0].n, 1);
  });

  test('prazo não vencido não encerra', async () => {
    const l = await leilao();
    const r = await encerrarLeilao(l.id);
    assert.equal(r.encerrado, false);
    assert.equal(r.motivo, 'prazo_estendido');
  });

  test('o encerramento publica evento na MESMA transação', async () => {
    const l = await leilao();
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });
    await vencer(l.id);
    await encerrarLeilao(l.id);

    const { rows } = await pool.query(
      "SELECT payload FROM outbox WHERE tipo_evento = 'leilao_encerrado' AND id_agregado = $1",
      [l.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.id_arrematante, COMPRADOR);
  });
});

describe('prorrogação (RF-017)', () => {
  test('lance nos últimos 2 minutos estende o prazo', async () => {
    const l = await leilao({ prazo: '30 seconds' });

    const lance = await registrarLance({
      idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000,
    });

    assert.equal(lance.prorrogado, true);
    assert.ok(
      new Date(lance.encerra_em) > new Date(l.encerra_em),
      'o novo prazo tem de ser depois do antigo',
    );
  });

  test('lance fora da janela final NÃO prorroga', async () => {
    const l = await leilao({ prazo: '30 minutes' });

    const lance = await registrarLance({
      idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000,
    });

    assert.equal(lance.prorrogado, false);
    assert.equal(
      new Date(lance.encerra_em).getTime(),
      new Date(l.encerra_em).getTime(),
    );
  });

  test('o novo prazo conta do AGORA, não do prazo antigo', async () => {
    // Somar ao `encerra_em` antigo daria prorrogação nenhuma para um
    // lance que entrou quase no fim: o novo prazo cairia no passado
    // imediato, e o leilão fecharia com o lance recém-aceito.
    const l = await leilao({ prazo: '1 second' });

    const lance = await registrarLance({
      idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000,
    });

    const { rows: [{ falta }] } = await pool.query(
      'SELECT $1::timestamptz - clock_timestamp() > interval \'1 minute\' AS falta',
      [lance.encerra_em],
    );
    assert.equal(falta, true, 'tem de sobrar mais de 1 minuto depois de prorrogar');
  });

  test('prorrogado, o encerrador não fecha o leilão', async () => {
    // Esta é a janela do critério do T-011: o prazo muda enquanto o
    // encerrador está a caminho, e ele tem de reler sob a trava.
    const l = await leilao({ prazo: '30 seconds' });
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });

    const r = await encerrarLeilao(l.id);

    assert.equal(r.encerrado, false);
    assert.equal(r.motivo, 'prazo_estendido');
    assert.equal(r.leilao.status, 'aberto');
  });
});

describe('anulação do arremate (RF-004b)', () => {
  async function leilaoArrematado() {
    const l = await leilao();
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });
    await vencer(l.id);
    await encerrarLeilao(l.id);
    return l;
  }

  test('anula com motivo e leva o leilão para arremate_anulado', async () => {
    const l = await leilaoArrematado();

    const r = await anularArremate(l.id, 'cnpj_inativo');

    assert.equal(r.anulado, true);
    assert.equal(r.arremate.motivo_anulacao, 'cnpj_inativo');
    assert.ok(r.arremate.anulado_em);

    const { rows: [{ status }] } = await pool.query(
      'SELECT status FROM leilao WHERE id = $1', [l.id],
    );
    assert.equal(status, 'arremate_anulado');
  });

  test('sem motivo é recusado', async () => {
    const l = await leilaoArrematado();
    await assert.rejects(
      () => anularArremate(l.id, ''),
      (e) => e.codigo === 'motivo_obrigatorio',
    );
  });

  test('publica a decisão de liquidação mandando devolver TODAS', async () => {
    // O RF-023 diz que com arremate anulado nenhuma caução é abatida.
    // Vai como campo, não deduzido do status: deixar o CAU inferir
    // poria a mesma regra em dois serviços.
    const l = await leilaoArrematado();
    await anularArremate(l.id, 'cnpj_inativo');

    const { rows } = await pool.query(
      "SELECT payload FROM outbox WHERE tipo_evento = 'leilao_liquidar'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.devolver_todas, true);
    assert.equal(rows[0].payload.abater_do_arrematante, null);
    assert.equal(rows[0].payload.motivo, 'cnpj_inativo');
  });

  test('o segundo colocado NÃO é promovido', async () => {
    // O requisito é explícito: quem decide reofertar é o vendedor.
    const l = await leilao();
    await registrarLance({ idLeilao: l.id, idEmpresa: COMPRADOR, valor: 1000 });
    await registrarLance({ idLeilao: l.id, idEmpresa: OUTRO, valor: 5000 });
    await vencer(l.id);
    const { arremate } = await encerrarLeilao(l.id);

    await anularArremate(l.id, 'cnpj_inativo');

    const { rows } = await pool.query(
      'SELECT id, id_lance, anulado_em FROM arremate WHERE id_leilao = $1', [l.id],
    );
    assert.equal(rows.length, 1, 'não pode nascer um arremate novo');
    assert.equal(rows[0].id, arremate.id);
    assert.ok(rows[0].anulado_em);
  });

  test('anular duas vezes não publica dois eventos', async () => {
    const l = await leilaoArrematado();
    await anularArremate(l.id, 'cnpj_inativo');
    const segunda = await anularArremate(l.id, 'cnpj_inativo');

    assert.equal(segunda.anulado, false);
    assert.equal(segunda.motivo, 'ja_anulado');

    const { rows } = await pool.query(
      "SELECT count(*)::int AS n FROM outbox WHERE tipo_evento = 'leilao_liquidar'",
    );
    assert.equal(rows[0].n, 1);
  });

  test('leilão sem arremate não pode ser anulado', async () => {
    const l = await leilao();
    await vencer(l.id);
    await encerrarLeilao(l.id);   // deserto

    await assert.rejects(
      () => anularArremate(l.id, 'cnpj_inativo'),
      (e) => e.codigo === 'sem_arremate',
    );
  });
});

describe('laço do encerrador', () => {
  test('encerra os vencidos e deixa os demais', async () => {
    const vencido = await leilao();
    const aberto = await leilao({ prazo: '30 minutes' });
    await registrarLance({ idLeilao: vencido.id, idEmpresa: COMPRADOR, valor: 1000 });
    await vencer(vencido.id);

    await encerrarVencidos(pool);

    const { rows } = await pool.query(
      'SELECT id, status FROM leilao WHERE id = ANY($1)',
      [[vencido.id, aberto.id]],
    );
    const porId = Object.fromEntries(rows.map((r) => [r.id, r.status]));
    assert.equal(porId[vencido.id], 'encerrado');
    assert.equal(porId[aberto.id], 'aberto');
  });
});
