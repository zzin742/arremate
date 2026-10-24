import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool, emTransacao } from '../src/db.js';
import { cadastrar, autenticar, verificarToken, ErroDeRegra } from '../src/empresas.js';
import { cnpjValido } from '../src/cnpj.js';

// CNPJs com dígito verificador correto
const CNPJ_OK = '11222333000181';
const CNPJ_OK2 = '11444777000161';

before(async () => {
  await pool.query('SELECT 1');   // falha cedo e claro se o banco não subiu
});

beforeEach(async () => {
  await pool.query('TRUNCATE empresa, outbox');
});

after(async () => {
  await pool.end();
});

describe('validação de CNPJ (RF-003)', () => {
  test('aceita CNPJ com dígito verificador correto', () => {
    assert.ok(cnpjValido(CNPJ_OK));
    assert.ok(cnpjValido('11.222.333/0001-81'), 'deve aceitar formatado');
  });

  test('recusa dígito verificador errado', () => {
    assert.ok(!cnpjValido('11222333000182'));
  });

  test('recusa tamanho errado e dígitos repetidos', () => {
    assert.ok(!cnpjValido('112223330001'));
    assert.ok(!cnpjValido('11111111111111'));
    assert.ok(!cnpjValido(''));
    assert.ok(!cnpjValido(null));
  });
});

describe('cadastro (RF-001)', () => {
  test('cadastra e devolve a empresa sem a senha', async () => {
    const e = await cadastrar({
      cnpj: CNPJ_OK, razaoSocial: 'Metalúrgica Teste', email: 'a@t.com', senha: 'senha12345',
    });
    assert.ok(e.id);
    assert.equal(e.cnpj, CNPJ_OK);
    assert.equal(e.email, 'a@t.com');
    assert.ok(!('senha_hash' in e), 'não pode devolver o hash da senha');
  });

  test('guarda a senha com hash, nunca em claro', async () => {
    await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'b@t.com', senha: 'senha12345' });
    const { rows } = await pool.query('SELECT senha_hash FROM empresa WHERE email = $1', ['b@t.com']);
    assert.notEqual(rows[0].senha_hash, 'senha12345');
    assert.match(rows[0].senha_hash, /^\$2[aby]\$/, 'deve ser hash bcrypt');
  });

  test('normaliza CNPJ formatado e e-mail maiúsculo', async () => {
    const e = await cadastrar({
      cnpj: '11.222.333/0001-81', razaoSocial: 'T', email: 'MAIUSCULO@T.COM', senha: 'senha12345',
    });
    assert.equal(e.cnpj, CNPJ_OK);
    assert.equal(e.email, 'maiusculo@t.com');
  });

  test('recusa CNPJ inválido', async () => {
    await assert.rejects(
      () => cadastrar({ cnpj: '11222333000182', razaoSocial: 'T', email: 'c@t.com', senha: 'senha12345' }),
      (e) => e instanceof ErroDeRegra && e.codigo === 'cnpj_invalido',
    );
  });

  test('recusa CNPJ e e-mail repetidos', async () => {
    await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'd@t.com', senha: 'senha12345' });

    await assert.rejects(
      () => cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'outro@t.com', senha: 'senha12345' }),
      (e) => e.codigo === 'cnpj_ja_cadastrado' && e.status === 409,
    );
    await assert.rejects(
      () => cadastrar({ cnpj: CNPJ_OK2, razaoSocial: 'T', email: 'd@t.com', senha: 'senha12345' }),
      (e) => e.codigo === 'email_ja_cadastrado',
    );
  });
});

describe('outbox na mesma transação (RNF-007b)', () => {
  test('cadastro grava o evento conta_criada pendente', async () => {
    const e = await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'e@t.com', senha: 'senha12345' });

    const { rows } = await pool.query('SELECT * FROM outbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tipo_evento, 'conta_criada');
    assert.equal(rows[0].agregado, 'empresa');
    assert.equal(rows[0].id_agregado, e.id);
    assert.equal(rows[0].publicado_em, null, 'nasce pendente');
    assert.ok(rows[0].pendente_desde, 'pendente_desde alimenta a idade real (doc 05, §3.4)');
  });

  test('o payload do evento NÃO leva credencial', async () => {
    await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'f@t.com', senha: 'senha12345' });
    const { rows } = await pool.query('SELECT payload FROM outbox');
    const texto = JSON.stringify(rows[0].payload);
    assert.ok(!texto.includes('senha'), 'payload não pode conter senha');
    assert.ok(!texto.includes('$2a$') && !texto.includes('$2b$'), 'nem o hash');
  });

  test('falha no INSERT da empresa não deixa evento órfão', async () => {
    await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'g@t.com', senha: 'senha12345' });
    const antes = await pool.query('SELECT count(*)::int AS n FROM outbox');

    // segundo cadastro com o mesmo CNPJ: o INSERT da empresa falha
    await assert.rejects(() => cadastrar({
      cnpj: CNPJ_OK, razaoSocial: 'T', email: 'h@t.com', senha: 'senha12345',
    }));

    const depois = await pool.query('SELECT count(*)::int AS n FROM outbox');
    assert.equal(depois.rows[0].n, antes.rows[0].n,
      'rollback tem que levar o evento junto — senão o HAB verifica uma conta que não existe');

    const empresas = await pool.query('SELECT count(*)::int AS n FROM empresa');
    assert.equal(empresas.rows[0].n, 1);
  });
});

describe('rollback cobre a outbox (RNF-007b)', () => {
  // O teste acima NÃO prova atomicidade: lá o INSERT da empresa falha antes
  // de a outbox ser escrita, então com ou sem transação o resultado é igual.
  // Descobri isso sabotando a transação de propósito — o teste continuou
  // passando. A prova real precisa falhar DEPOIS de escrever na outbox.

  test('erro após gravar na outbox desfaz os dois inserts', async () => {
    await assert.rejects(() => emTransacao(async (cx) => {
      const r = await cx.query(
        `INSERT INTO empresa (cnpj, razao_social, email, senha_hash)
         VALUES ($1, 'T', 'rollback@t.com', 'hash') RETURNING id`,
        [CNPJ_OK],
      );
      await cx.query(
        `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
         VALUES ('empresa', $1, 'conta_criada', '{}')`,
        [r.rows[0].id],
      );
      throw new Error('falha simulada depois da outbox');
    }));

    const emp = await pool.query('SELECT count(*)::int AS n FROM empresa');
    const out = await pool.query('SELECT count(*)::int AS n FROM outbox');
    assert.equal(emp.rows[0].n, 0, 'empresa tinha que sumir no rollback');
    assert.equal(out.rows[0].n, 0, 'o evento tinha que sumir junto — é o ponto da outbox transacional');
  });

  test('sem erro, os dois persistem', async () => {
    await emTransacao(async (cx) => {
      const r = await cx.query(
        `INSERT INTO empresa (cnpj, razao_social, email, senha_hash)
         VALUES ($1, 'T', 'ok@t.com', 'hash') RETURNING id`,
        [CNPJ_OK],
      );
      await cx.query(
        `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
         VALUES ('empresa', $1, 'conta_criada', '{}')`,
        [r.rows[0].id],
      );
    });
    const emp = await pool.query('SELECT count(*)::int AS n FROM empresa');
    const out = await pool.query('SELECT count(*)::int AS n FROM outbox');
    assert.equal(emp.rows[0].n, 1);
    assert.equal(out.rows[0].n, 1);
  });
});

describe('autenticação (RF-002)', () => {
  test('emite token válido com as credenciais certas', async () => {
    const e = await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'i@t.com', senha: 'senha12345' });
    const r = await autenticar({ email: 'i@t.com', senha: 'senha12345' });

    assert.ok(r.token);
    const conteudo = verificarToken(r.token);
    assert.equal(conteudo.sub, e.id);
    assert.equal(conteudo.cnpj, CNPJ_OK);
    assert.ok(conteudo.exp > conteudo.iat, 'token tem expiração');
  });

  test('aceita e-mail em maiúsculo no login', async () => {
    await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'j@t.com', senha: 'senha12345' });
    const r = await autenticar({ email: 'J@T.COM', senha: 'senha12345' });
    assert.ok(r.token);
  });

  test('recusa senha errada e e-mail inexistente com o MESMO erro', async () => {
    await cadastrar({ cnpj: CNPJ_OK, razaoSocial: 'T', email: 'k@t.com', senha: 'senha12345' });

    const erros = [];
    for (const cred of [
      { email: 'k@t.com', senha: 'errada123' },
      { email: 'naoexiste@t.com', senha: 'senha12345' },
    ]) {
      await assert.rejects(() => autenticar(cred), (e) => { erros.push(e.codigo); return true; });
    }
    assert.deepEqual(erros, ['credenciais_invalidas', 'credenciais_invalidas'],
      'mensagens diferentes revelariam quais e-mails existem');
  });

  test('token adulterado é recusado', () => {
    assert.throws(() => verificarToken('isso.nao.e.token'), (e) => e.codigo === 'token_invalido');
    assert.throws(() => verificarToken(''), (e) => e.status === 401);
  });
});
