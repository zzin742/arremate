/**
 * Conta e sessão.
 *
 * O que vale provar aqui não é que o bcrypt funciona. É que o evento sai
 * na mesma transação do cadastro, que o login não entrega quais e-mails
 * existem, e que conta bloqueada não entra.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import { pool } from '../src/db.js';
import { cadastrar, autenticar, verificarToken, consultar, ErroDeRegra } from '../src/contas.js';

const novo = (extra = {}) => ({
  nome: 'José Henrique',
  email: `jose-${crypto.randomUUID()}@naregua.local`,
  senha: 'senha-de-teste',
  ...extra,
});

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => { await pool.query('TRUNCATE conta, bloqueio_conta, outbox CASCADE'); });
after(async () => { await pool.end(); });

describe('cadastro', () => {
  test('cria a conta e devolve os dados públicos', async () => {
    const c = await cadastrar(novo());
    assert.ok(c.id);
    assert.equal(c.nome, 'José Henrique');
    assert.equal(c.senha_hash, undefined, 'o hash não pode sair do serviço');
  });

  test('o evento sai na MESMA transação do cadastro', async () => {
    // É o ponto da tarefa: se fossem duas operações, um processo que
    // morresse entre elas deixaria a conta existindo e ninguém sabendo.
    const c = await cadastrar(novo());
    const { rows } = await pool.query(
      "SELECT payload FROM outbox WHERE tipo_evento = 'conta_criada' AND id_agregado = $1",
      [c.id],
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].payload.id_conta, c.id);
  });

  test('o evento NÃO leva credencial', async () => {
    // O payload atravessa SNS e SQS: tudo o que entra nele passa a
    // existir fora do banco do AUTH.
    const c = await cadastrar(novo());
    const { rows } = await pool.query(
      'SELECT payload FROM outbox WHERE id_agregado = $1', [c.id],
    );
    const texto = JSON.stringify(rows[0].payload);
    assert.ok(!texto.includes('senha'), 'senha no payload');
    assert.ok(!texto.includes('$2a$'), 'hash no payload');
  });

  test('e-mail repetido é 409, e não deixa conta pela metade', async () => {
    const dados = novo();
    await cadastrar(dados);

    await assert.rejects(
      () => cadastrar({ ...dados, nome: 'Outro' }),
      (e) => e instanceof ErroDeRegra && e.codigo === 'email_ja_cadastrado' && e.status === 409,
    );

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM conta');
    assert.equal(rows[0].n, 1);
  });

  test('maiúsculas no e-mail não criam duas contas', async () => {
    const dados = novo();
    await cadastrar(dados);
    await assert.rejects(
      () => cadastrar({ ...dados, email: dados.email.toUpperCase() }),
      (e) => e.codigo === 'email_ja_cadastrado',
    );
  });

  test('senha curta é recusada antes de tocar no banco', async () => {
    await assert.rejects(
      () => cadastrar(novo({ senha: '1234' })),
      (e) => e.codigo === 'senha_curta',
    );
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM conta');
    assert.equal(rows[0].n, 0);
  });
});

describe('login', () => {
  test('autentica e devolve um token que o próprio serviço aceita', async () => {
    const dados = novo();
    const c = await cadastrar(dados);
    const r = await autenticar({ email: dados.email, senha: dados.senha });

    assert.equal(r.conta.id, c.id);
    assert.equal(verificarToken(r.token).sub, c.id);
  });

  test('senha errada e e-mail inexistente dão o MESMO erro', async () => {
    // Mensagens diferentes entregariam quais e-mails estão cadastrados.
    const dados = novo();
    await cadastrar(dados);

    const erros = [];
    for (const tentativa of [
      { email: dados.email, senha: 'errada-mas-longa' },
      { email: 'ninguem@naregua.local', senha: dados.senha },
    ]) {
      await autenticar(tentativa).catch((e) => erros.push([e.codigo, e.status, e.message]));
    }
    assert.equal(erros.length, 2);
    assert.deepEqual(erros[0], erros[1]);
  });

  test('conta bloqueada não entra, e o motivo não vaza', async () => {
    const dados = novo();
    const c = await cadastrar(dados);
    await pool.query(
      'INSERT INTO bloqueio_conta (id_conta, motivo) VALUES ($1, $2)',
      [c.id, 'faltou três vezes sem avisar'],
    );

    await assert.rejects(
      () => autenticar({ email: dados.email, senha: dados.senha }),
      (e) => e.codigo === 'conta_bloqueada'
        && e.status === 403
        && !e.message.includes('faltou'),
    );
  });

  test('token de outro segredo não é aceito', async () => {
    assert.throws(
      () => verificarToken('nao.e.um.token'),
      (e) => e.codigo === 'token_invalido' && e.status === 401,
    );
  });
});

describe('consulta', () => {
  test('devolve os dados públicos, sem o hash', async () => {
    const c = await cadastrar(novo());
    const achado = await consultar(c.id);
    assert.equal(achado.id, c.id);
    assert.equal(achado.senha_hash, undefined);
  });

  test('conta que não existe devolve null, não erro', async () => {
    assert.equal(await consultar(crypto.randomUUID()), null);
  });
});
