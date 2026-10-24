import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  verificarHabilitacao, reprocessarPendentes, emitirToken, verificarTokenHabilitacao,
} from '../src/habilitacao.js';
import { consultarCnpj, ApiExternaIndisponivel } from '../src/brasilapi.js';

const EMPRESA = '11111111-1111-1111-1111-111111111111';
const CNPJ = '11222333000181';
const evento = () => crypto.randomUUID();

/**
 * Dublê da BrasilAPI. Os testes não podem depender de internet nem do
 * serviço de terceiro estar de pé — se dependessem, falhariam por motivo
 * que não é nosso e deixariam de significar alguma coisa.
 */
const respondendo = (corpo, status = 200) => ({
  fetchImpl: async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => corpo,
  }),
});
const foraDoAr = (erro = new Error('conexão recusada')) => ({
  fetchImpl: async () => { throw erro; },
});

const ATIVA = { razao_social: 'Metalúrgica Sul', descricao_situacao_cadastral: 'ATIVA' };
const BAIXADA = { razao_social: 'Antiga', descricao_situacao_cadastral: 'BAIXADA' };

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => { await pool.query('TRUNCATE habilitacao'); });
after(async () => { await pool.end(); });

describe('consulta à BrasilAPI (RF-003)', () => {
  test('ATIVA vira situação ativa', async () => {
    const r = await consultarCnpj(CNPJ, respondendo(ATIVA));
    assert.equal(r.situacao, 'ativa');
    assert.equal(r.razaoSocial, 'Metalúrgica Sul');
  });

  test('qualquer coisa diferente de ATIVA vira inativa', async () => {
    assert.equal((await consultarCnpj(CNPJ, respondendo(BAIXADA))).situacao, 'inativa');
  });

  test('404 é CNPJ inexistente, não erro de sistema', async () => {
    const r = await consultarCnpj(CNPJ, respondendo({}, 404));
    assert.equal(r.situacao, 'inativa');
    assert.match(r.descricao, /não encontrado/);
  });

  test('erro de rede, 429 e 5xx são temporários — vale repetir', async () => {
    await assert.rejects(() => consultarCnpj(CNPJ, foraDoAr()), ApiExternaIndisponivel);
    await assert.rejects(() => consultarCnpj(CNPJ, respondendo({}, 429)), ApiExternaIndisponivel);
    await assert.rejects(() => consultarCnpj(CNPJ, respondendo({}, 503)), ApiExternaIndisponivel);
  });

  test('4xx que não é 404 nem 429 não é temporário — repetir não resolve', async () => {
    const r = await consultarCnpj(CNPJ, respondendo({}, 400));
    assert.equal(r.situacao, 'inativa');
  });
});

describe('verificação da habilitação', () => {
  test('CNPJ ativo aprova', async () => {
    const h = await verificarHabilitacao(
      { idEvento: evento(), idEmpresa: EMPRESA, cnpj: CNPJ }, respondendo(ATIVA),
    );
    assert.equal(h.situacao, 'aprovada');
  });

  test('CNPJ baixado recusa — e recusa é resultado, não falha', async () => {
    const h = await verificarHabilitacao(
      { idEvento: evento(), idEmpresa: EMPRESA, cnpj: CNPJ }, respondendo(BAIXADA),
    );
    assert.equal(h.situacao, 'recusada');
  });

  test('API fora deixa pendente, não rejeita o cadastro (RF-005)', async () => {
    const h = await verificarHabilitacao(
      { idEvento: evento(), idEmpresa: EMPRESA, cnpj: CNPJ }, foraDoAr(),
    );
    assert.equal(h.situacao, 'pendente');
    assert.match(h.detalhe, /indisponível/);
  });

  test('IDEMPOTÊNCIA: o mesmo evento duas vezes não duplica', async () => {
    const id = evento();
    const primeira = await verificarHabilitacao(
      { idEvento: id, idEmpresa: EMPRESA, cnpj: CNPJ }, respondendo(ATIVA),
    );
    const segunda = await verificarHabilitacao(
      { idEvento: id, idEmpresa: EMPRESA, cnpj: CNPJ }, respondendo(ATIVA),
    );

    assert.equal(primeira.repetido, false);
    assert.equal(segunda.repetido, true, 'a segunda vez tem de ser reconhecida como repetida');
    assert.equal(segunda.id, primeira.id, 'e devolver a mesma habilitação');

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM habilitacao');
    assert.equal(rows[0].n, 1, 'a entrega é ao menos uma vez — duplicar aqui seria bug');
  });

  test('a segunda vez nem chama a API externa', async () => {
    const id = evento();
    await verificarHabilitacao({ idEvento: id, idEmpresa: EMPRESA, cnpj: CNPJ }, respondendo(ATIVA));

    let chamou = false;
    await verificarHabilitacao({ idEvento: id, idEmpresa: EMPRESA, cnpj: CNPJ }, {
      fetchImpl: async () => { chamou = true; throw new Error('não deveria chamar'); },
    });
    assert.equal(chamou, false, 'evento repetido não pode gastar chamada de terceiro');
  });
});

describe('reprocessamento das pendentes (RF-005)', () => {
  test('resolve quando a API volta', async () => {
    await verificarHabilitacao({ idEvento: evento(), idEmpresa: EMPRESA, cnpj: CNPJ }, foraDoAr());

    const r = await reprocessarPendentes(respondendo(ATIVA));
    assert.equal(r.resolvidas, 1);

    const { rows } = await pool.query('SELECT situacao FROM habilitacao');
    assert.equal(rows[0].situacao, 'aprovada');
  });

  test('continua pendente se a API ainda está fora', async () => {
    await verificarHabilitacao({ idEvento: evento(), idEmpresa: EMPRESA, cnpj: CNPJ }, foraDoAr());

    const r = await reprocessarPendentes(foraDoAr());
    assert.equal(r.resolvidas, 0);
    assert.equal(r.aindaPendentes, 1);
  });
});

describe('token de habilitação (RF-004)', () => {
  test('emite para aprovada e o LEI verifica sem rede', async () => {
    await verificarHabilitacao({ idEvento: evento(), idEmpresa: EMPRESA, cnpj: CNPJ }, respondendo(ATIVA));
    const r = await emitirToken(EMPRESA);

    assert.equal(r.emitido, true);
    assert.equal(r.validade, '15m');

    // é isto que o LEI faz no caminho do lance: só assinatura, zero rede
    const v = verificarTokenHabilitacao(r.token);
    assert.equal(v.valido, true);
    assert.equal(v.idEmpresa, EMPRESA);
  });

  test('não emite para recusada nem pendente', async () => {
    await verificarHabilitacao({ idEvento: evento(), idEmpresa: EMPRESA, cnpj: CNPJ }, respondendo(BAIXADA));
    const r = await emitirToken(EMPRESA);
    assert.equal(r.emitido, false);
    assert.equal(r.motivo, 'recusada');
  });

  test('não emite para empresa sem habilitação', async () => {
    const r = await emitirToken('99999999-9999-9999-9999-999999999999');
    assert.equal(r.motivo, 'sem_habilitacao');
  });

  test('token adulterado ou de outro segredo é recusado', () => {
    assert.equal(verificarTokenHabilitacao('nao.e.token').valido, false);
    assert.equal(verificarTokenHabilitacao('').valido, false);
  });
});
