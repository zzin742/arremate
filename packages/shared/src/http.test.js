import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tirarPrefixo } from './http.js';

/** Roda o middleware e devolve a URL que o Express veria. */
function passar(nome, url) {
  const req = { url };
  let seguiu = false;
  tirarPrefixo(nome)(req, {}, () => { seguiu = true; });
  assert.ok(seguiu, 'o middleware tem de chamar next()');
  return req.url;
}

test('tira o prefixo que o ALB encaminha', () => {
  assert.equal(passar('auth', '/api/auth/saude'), '/saude');
  assert.equal(passar('lei', '/api/lei/leiloes/7/lances'), '/leiloes/7/lances');
});

test('preserva a query', () => {
  assert.equal(passar('cat', '/api/cat/equipamentos?pagina=2'), '/equipamentos?pagina=2');
  assert.equal(passar('cat', '/api/cat?pagina=2'), '/?pagina=2');
});

test('o prefixo sozinho vira a raiz', () => {
  assert.equal(passar('auth', '/api/auth'), '/');
});

test('nao mexe no caminho local, que vem sem prefixo', () => {
  assert.equal(passar('auth', '/saude'), '/saude');
  assert.equal(passar('auth', '/'), '/');
});

test('nao confunde o prefixo de outro servico', () => {
  // o ALB nunca manda isto para o AUTH, mas trocar /api/autheticar por
  // /eticar seria um erro silencioso se o teste fosse so de prefixo
  assert.equal(passar('auth', '/api/authenticacao'), '/api/authenticacao');
  assert.equal(passar('cau', '/api/cat/equipamentos'), '/api/cat/equipamentos');
});
