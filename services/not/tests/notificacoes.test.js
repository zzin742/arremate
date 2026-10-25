import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { registrar, daEvento, listar, marcarLida } from '../src/notificacoes.js';

const EMPRESA = '22222222-2222-2222-2222-222222222222';
const evt = () => crypto.randomUUID();

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => { await pool.query('TRUNCATE notificacao'); });
after(async () => { await pool.end(); });

const aviso = (idEvento = evt()) => ({
  idEvento, idEmpresa: EMPRESA, tipo: 'lance_superado',
  titulo: 'Seu lance foi superado', corpo: 'Alguém ofereceu mais.',
});

describe('registro (RF-027)', () => {
  test('registra e devolve', async () => {
    const n = await registrar(aviso());
    assert.equal(n.tipo, 'lance_superado');
    assert.equal(n.lida_em, null);
    assert.equal(n.repetida, false);
  });

  test('IDEMPOTÊNCIA: o mesmo evento não avisa duas vezes', async () => {
    const id = evt();
    const primeira = await registrar(aviso(id));
    const segunda = await registrar(aviso(id));

    assert.equal(segunda.repetida, true);
    assert.equal(segunda.id, primeira.id);

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM notificacao');
    assert.equal(rows[0].n, 1, 'entrega ao menos uma vez: sem o UNIQUE, avisaria duas');
  });
});

describe('montagem a partir do evento', () => {
  test('lance superado vira aviso para quem foi superado', () => {
    const a = daEvento({
      idEvento: 'e1', tipo: 'lance_superado',
      corpo: { id_empresa_superada: EMPRESA, valor: '1500.00' },
    });
    assert.equal(a.idEmpresa, EMPRESA);
    assert.match(a.corpo, /R\$/, 'valor formatado em real');
  });

  test('vencedor e perdedor recebem textos diferentes', () => {
    const v = daEvento({ idEvento: 'e2', tipo: 'leilao_encerrado', corpo: { id_empresa: EMPRESA, venceu: true, valor: '2000' } });
    const p = daEvento({ idEvento: 'e3', tipo: 'leilao_encerrado', corpo: { id_empresa: EMPRESA, venceu: false } });
    assert.match(v.titulo, /arrematou/i);
    assert.notEqual(v.titulo, p.titulo);
  });

  test('evento desconhecido não vira aviso', () => {
    assert.equal(daEvento({ idEvento: 'e4', tipo: 'conta_criada', corpo: {} }), null);
  });
});

describe('listagem e leitura', () => {
  test('lista em ordem decrescente e filtra não lidas', async () => {
    const a = await registrar(aviso());
    await new Promise((r) => setTimeout(r, 10));
    const b = await registrar(aviso());

    const todas = await listar(EMPRESA);
    assert.equal(todas[0].id, b.id, 'mais recente primeiro');

    await marcarLida(a.id, EMPRESA);
    assert.equal((await listar(EMPRESA, { apenasNaoLidas: true })).length, 1);
    assert.equal((await listar(EMPRESA)).length, 2);
  });

  test('marcar lida duas vezes devolve null na segunda', async () => {
    const n = await registrar(aviso());
    assert.ok(await marcarLida(n.id, EMPRESA));
    assert.equal(await marcarLida(n.id, EMPRESA), null);
  });

  test('não marca notificação de outra empresa', async () => {
    const n = await registrar(aviso());
    assert.equal(await marcarLida(n.id, '99999999-9999-9999-9999-999999999999'), null);
  });
});
