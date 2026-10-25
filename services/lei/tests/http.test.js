/**
 * Camada HTTP do LEI.
 *
 * `lances.test.js` prova a regra chamando `registrarLance` direto, com
 * o `idEmpresa` já em mãos. Pela rede esse id vem do token, e é aí que
 * mora o que só existe nesta camada: quem não tem token não lança, e
 * quem tem não pode escolher lançar em nome de outro.
 *
 * O prazo também muda de natureza aqui. Dentro do processo ele é um
 * `Date`; pela rede é texto, e cabe ao esquema recusar o que não for
 * data antes de o banco ver qualquer coisa.
 */

import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';

import { subir } from '../../../testes/servidor.js';
import { app } from '../src/index.js';
import { pool } from '../src/db.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';
const VENDEDOR = '11111111-1111-1111-1111-111111111111';
const COMPRADOR = '22222222-2222-2222-2222-222222222222';
const OUTRO = '33333333-3333-3333-3333-333333333333';

const token = (sub) => jwt.sign({ sub }, SEGREDO);

let s;

/**
 * Prazo pelo relógio do BANCO.
 *
 * O vencimento é julgado por `clock_timestamp()`. Marcá-lo com
 * `Date.now()` poria dois relógios na mesma conta — o Postgres em
 * contêiner no macOS chegou a ficar 1,7 s atrás do host (ADR-016).
 */
async function daquiA(ms) {
  const { rows } = await pool.query(
    "SELECT clock_timestamp() + ($1 || ' milliseconds')::interval AS t", [ms],
  );
  return rows[0].t.toISOString();
}

before(async () => {
  await pool.query('SELECT 1');
  s = await subir(app);
});
beforeEach(async () => { await pool.query('TRUNCATE arremate, lance, leilao, outbox CASCADE'); });
after(async () => { await s.fechar(); await pool.end(); });

async function leilao(extra = {}) {
  const r = await s.post('/leiloes', {
    token: token(VENDEDOR),
    corpo: {
      descricaoEquipamento: 'Torno mecânico 1998',
      lanceInicial: 1000,
      incrementoMin: 100,
      encerraEm: await daquiA(60_000),
      ...extra,
    },
  });
  return r;
}

describe('saúde e métricas', () => {
  test('saúde responde', async () => {
    assert.deepEqual((await s.get('/saude')).json, { servico: 'lei', ok: true });
  });

  test('responde também sob o prefixo do ALB', async () => {
    assert.equal((await s.get('/api/lei/saude')).status, 200);
  });

  test('métricas trazem a pendência da outbox', async () => {
    const r = await s.get('/metricas');
    assert.match(r.texto, /outbox_pendencia_mais_antiga_segundos/);
  });

  test('a rota de lance aparece pelo padrão, não pelo id', async () => {
    // uma série por leilão derrubaria o Prometheus num leilão
    // movimentado; é o motivo de o rótulo sair de `req.route`
    const { json: l } = await leilao();
    await s.post(`/leiloes/${l.id}/lances`, { token: token(COMPRADOR), corpo: { valor: 1000 } });

    const r = await s.get('/metricas');
    assert.match(r.texto, /rota="\/leiloes\/:id\/lances"/);
    assert.doesNotMatch(r.texto, new RegExp(`rota="/leiloes/${l.id}`));
  });
});

describe('abertura de leilão (RF-011)', () => {
  test('abre e devolve 201', async () => {
    const r = await leilao();
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'aberto');
    assert.equal(r.json.id_empresa, VENDEDOR, 'o dono sai do token, não do corpo');
  });

  test('sem token é 401', async () => {
    const r = await s.post('/leiloes', {
      corpo: {
        descricaoEquipamento: 'Torno', lanceInicial: 1000,
        incrementoMin: 100, encerraEm: await daquiA(60_000),
      },
    });
    assert.equal(r.status, 401);
    assert.equal(r.json.codigo, 'nao_autenticado');
  });

  test('token assinado com outro segredo é 401, não 500', async () => {
    const falso = jwt.sign({ sub: VENDEDOR }, 'segredo-errado');
    const r = await s.post('/leiloes', {
      token: falso,
      corpo: {
        descricaoEquipamento: 'Torno', lanceInicial: 1000,
        incrementoMin: 100, encerraEm: await daquiA(60_000),
      },
    });
    assert.equal(r.status, 401);
  });

  test('o corpo não consegue trocar o dono do leilão', async () => {
    // mandar `idEmpresa` no corpo não pode sobrepor o do token: seria
    // abrir leilão em nome de terceiro
    const r = await s.post('/leiloes', {
      token: token(VENDEDOR),
      corpo: {
        idEmpresa: OUTRO,
        descricaoEquipamento: 'Torno', lanceInicial: 1000,
        incrementoMin: 100, encerraEm: await daquiA(60_000),
      },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.id_empresa, VENDEDOR);
  });

  test('prazo que não é data é 400', async () => {
    const r = await leilao({ encerraEm: 'amanhã de manhã' });
    assert.equal(r.status, 400);
    assert.equal(r.json.codigo, 'dados_invalidos');
  });

  test('prazo no passado é 409, não 400: o texto é data válida', async () => {
    // A diferença não é cosmética. 400 diz "o pedido está malformado";
    // aqui ele está perfeito — é o relógio que recusa. Por isso a data
    // ilegível acima dá 400 pelo esquema e esta dá 409 pela regra, e o
    // frontend trata as duas de formas diferentes.
    const r = await leilao({ encerraEm: await daquiA(-60_000) });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'prazo_no_passado');
    assert.ok(r.json.mensagem);
  });

  test('valores não positivos são 400', async () => {
    assert.equal((await leilao({ lanceInicial: 0 })).status, 400);
    assert.equal((await leilao({ incrementoMin: -5 })).status, 400);
  });
});

describe('consulta de leilão (RF-008)', () => {
  test('leilão inexistente é 404 com código', async () => {
    const r = await s.get('/leiloes/44444444-4444-4444-4444-444444444444');
    assert.equal(r.status, 404);
    assert.equal(r.json.codigo, 'leilao_inexistente');
  });

  test('consulta é pública: não exige token', async () => {
    const { json: l } = await leilao();
    const r = await s.get(`/leiloes/${l.id}`);
    assert.equal(r.status, 200);
  });

  test('id malformado não derruba o serviço', async () => {
    const r = await s.get('/leiloes/nao-e-uuid');
    assert.ok(r.status >= 400, `esperava erro, veio ${r.status}`);
    assert.equal((await s.get('/saude')).status, 200);
  });
});

describe('registro de lance (RF-013)', () => {
  test('lance válido é 201', async () => {
    const { json: l } = await leilao();
    const r = await s.post(`/leiloes/${l.id}/lances`, {
      token: token(COMPRADOR), corpo: { valor: 1000 },
    });
    assert.equal(r.status, 201);
    assert.equal(r.json.sequencia, 1);
  });

  test('sem token é 401', async () => {
    const { json: l } = await leilao();
    const r = await s.post(`/leiloes/${l.id}/lances`, { corpo: { valor: 1000 } });
    assert.equal(r.status, 401);
  });

  test('a sequência avança a cada lance aceito', async () => {
    const { json: l } = await leilao();
    for (const [i, valor] of [1000, 1100, 1200].entries()) {
      const r = await s.post(`/leiloes/${l.id}/lances`, {
        token: token(COMPRADOR), corpo: { valor },
      });
      assert.equal(r.json.sequencia, i + 1);
    }
  });

  test('vendedor no próprio leilão é recusado', async () => {
    const { json: l } = await leilao();
    const r = await s.post(`/leiloes/${l.id}/lances`, {
      token: token(VENDEDOR), corpo: { valor: 1000 },
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'vendedor_nao_pode_lancar');
  });

  test('abaixo do incremento é 409 e diz qual é o mínimo', async () => {
    const { json: l } = await leilao();
    await s.post(`/leiloes/${l.id}/lances`, { token: token(COMPRADOR), corpo: { valor: 1000 } });

    const r = await s.post(`/leiloes/${l.id}/lances`, {
      token: token(OUTRO), corpo: { valor: 1050 },
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'lance_abaixo_do_minimo');
    assert.match(r.json.mensagem, /1100/, 'a mensagem tem de dizer o valor que serve');
  });

  test('recusa por regra NÃO é falha do sistema', async () => {
    // o RNF-004 diz isso com todas as letras; um 5xx aqui faria o
    // painel de erros acusar problema onde a regra está funcionando
    const { json: l } = await leilao();
    const r = await s.post(`/leiloes/${l.id}/lances`, {
      token: token(VENDEDOR), corpo: { valor: 1000 },
    });
    assert.ok(r.status < 500, `regra de negócio não pode virar 5xx, veio ${r.status}`);
  });

  test('valor ausente ou não numérico é 400, não 409', async () => {
    const { json: l } = await leilao();
    assert.equal((await s.post(`/leiloes/${l.id}/lances`, {
      token: token(COMPRADOR), corpo: {},
    })).status, 400);
    assert.equal((await s.post(`/leiloes/${l.id}/lances`, {
      token: token(COMPRADOR), corpo: { valor: '1000' },
    })).status, 400);
  });

  test('lance em leilão inexistente é 404', async () => {
    const r = await s.post('/leiloes/44444444-4444-4444-4444-444444444444/lances', {
      token: token(COMPRADOR), corpo: { valor: 1000 },
    });
    assert.equal(r.status, 404);
    assert.equal(r.json.codigo, 'leilao_inexistente');
  });

  test('lance depois do prazo é recusado pelo relógio do banco', async () => {
    const { json: l } = await leilao({ encerraEm: await daquiA(300) });
    await new Promise((ok) => setTimeout(ok, 500));

    const r = await s.post(`/leiloes/${l.id}/lances`, {
      token: token(COMPRADOR), corpo: { valor: 5000 },
    });
    assert.equal(r.status, 409);
    assert.equal(r.json.codigo, 'leilao_encerrado');
  });
});
