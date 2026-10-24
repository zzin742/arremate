import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  solicitar, processarWebhook, temCaucaoAtiva, reconciliar, TRANSICOES, ErroDeCaucao,
} from '../src/caucoes.js';
import { criarProvedorSandbox } from '../src/provedor.js';

const LEILAO = '11111111-1111-1111-1111-111111111111';
const EMPRESA = '22222222-2222-2222-2222-222222222222';
const evt = () => crypto.randomUUID();

let provedor;

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => {
  await pool.query('TRUNCATE evento_pagamento, caucao CASCADE');
  provedor = criarProvedorSandbox();
});
after(async () => { await pool.end(); });

const webhook = (caucao, tipo, idEvento = evt()) => processarWebhook({
  provedor: 'sandbox', idEvento, idCobranca: caucao.id_cobranca_externa, tipo, payload: {},
});

describe('solicitação (RF-019)', () => {
  test('cria pendente e guarda a referência do provedor', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    assert.equal(c.status, 'pendente');
    assert.ok(c.id_cobranca_externa, 'sem isto a reconciliação não tem o que perguntar');
    assert.equal(c.repetida, false);
  });

  test('pedir duas vezes não cria duas cobranças', async () => {
    await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    const segunda = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });

    assert.equal(segunda.repetida, true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM caucao');
    assert.equal(rows[0].n, 1, 'o UNIQUE (id_leilao, id_empresa) existe por isto');
  });

  test('provedor fora devolve 503, não deixa caução órfã', async () => {
    provedor._derrubar();
    await assert.rejects(
      () => solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor }),
      (e) => e instanceof ErroDeCaucao && e.status === 503,
    );
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM caucao');
    assert.equal(rows[0].n, 0, 'sem cobrança não pode sobrar caução no banco');
  });
});

describe('webhook (RF-020, RF-021)', () => {
  test('aprovado confirma a caução', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    const r = await webhook(c, 'pagamento.aprovado');

    assert.equal(r.status, 'confirmada');
    assert.equal(r.aplicado, true);
    assert.equal(await temCaucaoAtiva(LEILAO, EMPRESA), true);
  });

  test('recusado não libera participação', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    await webhook(c, 'pagamento.recusado');
    assert.equal(await temCaucaoAtiva(LEILAO, EMPRESA), false);
  });

  test('IDEMPOTÊNCIA: o mesmo evento duas vezes não aplica duas vezes', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    const id = evt();

    const p = await webhook(c, 'pagamento.aprovado', id);
    const s = await webhook(c, 'pagamento.aprovado', id);

    assert.equal(p.aplicado, true);
    assert.equal(s.repetido, true);
    assert.equal(s.aplicado, false);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM evento_pagamento');
    assert.equal(rows[0].n, 1, 'o evento repetido não pode ser gravado de novo');
  });

  test('a chave é o EVENTO, não a transação: outro evento da mesma cobrança passa', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    await webhook(c, 'pagamento.aprovado', 'evt_1');
    await webhook(c, 'pagamento.devolvido', 'evt_2');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM evento_pagamento');
    assert.equal(rows[0].n, 2, 'uma transação gera vários eventos legítimos');
  });

  test('cobrança desconhecida dá 404', async () => {
    await assert.rejects(
      () => processarWebhook({
        provedor: 'sandbox', idEvento: evt(), idCobranca: 'sb_nao_existe',
        tipo: 'pagamento.aprovado', payload: {},
      }),
      (e) => e.codigo === 'cobranca_desconhecida' && e.status === 404,
    );
  });
});

describe('máquina de estados', () => {
  test('abatida e devolvida são terminais', () => {
    assert.deepEqual(TRANSICOES.abatida, []);
    assert.deepEqual(TRANSICOES.devolvida, []);
    assert.deepEqual(TRANSICOES.recusada, []);
  });

  test('RF-021b: aprovação após devolução NÃO ressuscita a caução', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    await webhook(c, 'pagamento.aprovado');
    await webhook(c, 'pagamento.devolvido');

    // o provedor reenvia uma aprovação antiga, atrasada
    const tardio = await webhook(c, 'pagamento.aprovado');

    assert.equal(tardio.aplicado, false);
    assert.match(tardio.motivo, /transicao_invalida: devolvida -> confirmada/);
    assert.equal(await temCaucaoAtiva(LEILAO, EMPRESA), false,
      'participação não volta depois de devolvida');
  });

  test('o evento tardio fica registrado mesmo sem ser aplicado', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    await webhook(c, 'pagamento.aprovado');
    await webhook(c, 'pagamento.devolvido');
    await webhook(c, 'pagamento.aprovado');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM evento_pagamento');
    assert.equal(rows[0].n, 3, 'ele aconteceu; não aplicar é diferente de não registrar');
  });

  test('pendente não pode ir direto para abatida', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    assert.ok(!TRANSICOES.pendente.includes('abatida'),
      'abater sem confirmar seria cobrar quem não pagou');
  });
});

describe('reconciliação (RF-022)', () => {
  test('corrige a caução cujo webhook se perdeu', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });

    // o provedor aprovou, mas o webhook nunca chegou
    provedor._aprovar(c.id_cobranca_externa);
    assert.equal(await temCaucaoAtiva(LEILAO, EMPRESA), false, 'ainda pendente aqui');

    const r = await reconciliar({ provedor });
    assert.equal(r.conferidas, 1);
    assert.equal(r.corrigidas, 1);
    assert.equal(await temCaucaoAtiva(LEILAO, EMPRESA), true);
  });

  test('não mexe no que o provedor ainda não decidiu', async () => {
    await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    const r = await reconciliar({ provedor });
    assert.equal(r.corrigidas, 0);
  });

  test('não desfaz o que o webhook já resolveu', async () => {
    const c = await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    await webhook(c, 'pagamento.aprovado');
    provedor._recusar(c.id_cobranca_externa);   // provedor mudou de ideia depois

    await reconciliar({ provedor });
    const { rows } = await pool.query('SELECT status FROM caucao WHERE id = $1', [c.id]);
    assert.equal(rows[0].status, 'confirmada',
      'o UPDATE só toca em pendente — reconciliação não reverte decisão aplicada');
  });

  test('provedor fora não quebra a rodada', async () => {
    await solicitar({ idLeilao: LEILAO, idEmpresa: EMPRESA, valor: 500 }, { provedor });
    provedor._derrubar();

    const r = await reconciliar({ provedor });
    assert.equal(r.indisponivel, 1);
    assert.equal(r.corrigidas, 0);
  });
});
