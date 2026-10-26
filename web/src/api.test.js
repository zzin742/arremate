/**
 * Cliente HTTP do frontend.
 *
 * O que vale provar aqui não é que `fetch` funciona — é a tradução do
 * erro do servidor. O backend responde com `codigo` e `mensagem`
 * próprios, e é isso que permite a tela dizer "lance abaixo do mínimo"
 * em vez de "erro 409". Perder esse campo no caminho é um erro que não
 * quebra nada e piora tudo.
 *
 * `App.jsx` fica de fora: renderizar componente exige DOM e
 * transformação de JSX, ou seja, um segundo executor de testes no
 * projeto. Está contado no denominador da cobertura como não coberto,
 * que é o honesto — a lacuna aparece em vez de sumir.
 */

import { test, beforeEach, afterEach, describe } from 'node:test';
import assert from 'node:assert/strict';

import { sessao, entrar, cadastrar, verLeilao, abrirLeilao, darLance } from './api.js';

const fetchOriginal = globalThis.fetch;
let chamadas;

/** Responde o que o teste mandar e guarda como foi chamado. */
function responder(status, corpo) {
  globalThis.fetch = async (url, opcoes) => {
    chamadas.push({ url, ...opcoes });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => corpo,
    };
  };
}

beforeEach(() => {
  chamadas = [];
  // `localStorage` não existe no Node; o módulo usa para o token
  const guardado = new Map();
  globalThis.localStorage = {
    getItem: (k) => guardado.get(k) ?? null,
    setItem: (k, v) => guardado.set(k, v),
    removeItem: (k) => guardado.delete(k),
  };
});

afterEach(() => { globalThis.fetch = fetchOriginal; });

describe('token da sessão', () => {
  test('guarda e devolve', () => {
    sessao.token = 'abc123';
    assert.equal(sessao.token, 'abc123');
  });

  test('atribuir vazio APAGA em vez de guardar vazio', () => {
    // guardar string vazia faria o `Authorization: Bearer ` ser enviado
    // como cabeçalho válido, e o servidor responderia 401 sem explicar
    sessao.token = 'abc123';
    sessao.token = null;
    assert.equal(sessao.token, null);
  });
});

describe('tradução do erro do servidor', () => {
  test('preserva código e status', async () => {
    responder(409, { codigo: 'lance_abaixo_do_minimo', mensagem: 'Lance mínimo é 1100.00' });

    await assert.rejects(
      () => darLance('leilao-1', 1050),
      (e) => {
        assert.equal(e.codigo, 'lance_abaixo_do_minimo');
        assert.equal(e.status, 409);
        assert.match(e.message, /1100/);
        return true;
      },
    );
  });

  test('resposta de erro sem corpo não vira "undefined" na tela', async () => {
    responder(500, {});
    await assert.rejects(
      () => verLeilao('leilao-1'),
      (e) => {
        assert.equal(e.message, 'Falha na requisição');
        assert.equal(e.codigo, undefined);
        return true;
      },
    );
  });

  test('corpo que não é JSON não derruba o cliente', async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new SyntaxError('não é JSON'); },
    });

    await assert.rejects(
      () => verLeilao('leilao-1'),
      (e) => e.status === 502,
    );
  });
});

describe('autenticação por rota', () => {
  test('dar lance envia o token', async () => {
    sessao.token = 'tok-1';
    responder(201, { id: 'lance-1' });

    await darLance('leilao-1', 2000);
    assert.equal(chamadas[0].headers.Authorization, 'Bearer tok-1');
  });

  test('abrir leilão envia o token', async () => {
    sessao.token = 'tok-1';
    responder(201, { id: 'leilao-1' });

    await abrirLeilao({ descricaoEquipamento: 'Torno' });
    assert.equal(chamadas[0].headers.Authorization, 'Bearer tok-1');
  });

  test('entrar e cadastrar NÃO enviam token', async () => {
    // mandar token no login é inofensivo mas confuso; o servidor o
    // ignora, e um cabeçalho que não significa nada atrapalha quem lê
    sessao.token = 'tok-1';
    responder(200, { token: 'novo' });

    await entrar('a@b.com', 'senha12345');
    await cadastrar({ cnpj: '11222333000181' });

    assert.ok(!('Authorization' in chamadas[0].headers));
    assert.ok(!('Authorization' in chamadas[1].headers));
  });

  test('consultar leilão é público', async () => {
    sessao.token = 'tok-1';
    responder(200, { id: 'leilao-1' });

    await verLeilao('leilao-1');
    assert.ok(!('Authorization' in chamadas[0].headers));
  });
});

describe('montagem da requisição', () => {
  test('GET não manda corpo', async () => {
    responder(200, {});
    await verLeilao('leilao-1');
    assert.equal(chamadas[0].method, 'GET');
    assert.equal(chamadas[0].body, undefined);
  });

  test('o lance vai para a rota do leilão certo', async () => {
    responder(201, {});
    await darLance('leilao-42', 500);
    assert.match(chamadas[0].url, /\/leiloes\/leilao-42\/lances$/);
    assert.deepEqual(JSON.parse(chamadas[0].body), { valor: 500 });
  });

  test('cada serviço tem a sua base', async () => {
    responder(200, {});
    await entrar('a@b.com', 'x');
    await verLeilao('l1');
    assert.match(chamadas[0].url, /:3001\//, 'sessão vai para o AUTH');
    assert.match(chamadas[1].url, /:3002\//, 'leilão vai para o LEI');
  });
});
