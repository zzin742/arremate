import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

import { criarMetricas } from './metricas.js';

/**
 * Sobe um Express de verdade numa porta livre.
 *
 * O rótulo de rota sai de `req.route`, que só existe porque o Express
 * casou a rota — com `req` falso o teste provaria a função de rótulo e
 * não o middleware, que é onde o erro de cardinalidade mora.
 */
async function comApp(montar) {
  const metricas = criarMetricas();
  const app = express();
  app.use(metricas.middleware);
  app.get('/metricas', metricas.handler);
  montar(app, metricas);

  const servidor = app.listen(0);
  await new Promise((ok) => servidor.once('listening', ok));
  const base = `http://127.0.0.1:${servidor.address().port}`;

  return {
    base,
    pegar: (caminho) => fetch(base + caminho),
    texto: async () => (await fetch(`${base}/metricas`)).text(),
    fechar: () => new Promise((ok) => servidor.close(ok)),
  };
}

describe('métricas HTTP (RNF-021)', () => {
  test('o rótulo de rota é o padrão, não a URL', async () => {
    const t = await comApp((app) => {
      app.get('/leiloes/:id/lances', (_req, res) => res.json({ ok: true }));
    });

    await t.pegar('/leiloes/7/lances');
    await t.pegar('/leiloes/8/lances');
    const saida = await t.texto();
    await t.fechar();

    assert.match(saida, /rota="\/leiloes\/:id\/lances"/);
    assert.doesNotMatch(saida, /rota="\/leiloes\/7\/lances"/,
      'uma série por leilão derrubaria o Prometheus antes de medir nada');

    // os dois pedidos caíram na mesma série
    const conta = saida.match(
      /^http_requisicao_duracao_segundos_count\{.*rota="\/leiloes\/:id\/lances".*\} (\d+)$/m);
    assert.equal(conta?.[1], '2');
  });

  test('requisição sem rota casada não abre série nova', async () => {
    const t = await comApp(() => {});

    await t.pegar('/nao-existe');
    await t.pegar('/tambem-nao');
    const saida = await t.texto();
    await t.fechar();

    assert.match(saida, /rota="desconhecida"/);
    assert.doesNotMatch(saida, /rota="\/nao-existe"/);
  });

  test('o status entra no rótulo', async () => {
    const t = await comApp((app) => {
      app.get('/quebra', (_req, res) => res.status(500).json({ erro: true }));
    });

    await t.pegar('/quebra');
    const saida = await t.texto();
    await t.fechar();

    assert.match(saida, /status="500"/);
  });

  test('a propria rota de metricas nao se mede', async () => {
    const t = await comApp(() => {});

    await t.texto();
    const saida = await t.texto();
    await t.fechar();

    assert.doesNotMatch(saida, /rota="\/metricas"/,
      'medir a raspagem encheria o histograma com o monitoramento');
  });

  test('em andamento volta a zero depois da resposta', async () => {
    const t = await comApp((app) => {
      app.get('/ok', (_req, res) => res.json({ ok: true }));
    });

    await t.pegar('/ok');
    const saida = await t.texto();
    await t.fechar();

    assert.match(saida, /^http_requisicoes_em_andamento 0$/m);
  });

  test('cliente que desiste no meio nao deixa requisicao pendurada', async () => {
    // o handler segura a resposta para sempre; quem encerra e o cliente
    let presa;
    const t = await comApp((app) => {
      app.get('/devagar', (_req, res) => { presa = res; });
    });

    const cancelar = new AbortController();
    const pedido = fetch(`${t.base}/devagar`, { signal: cancelar.signal }).catch(() => {});
    await new Promise((ok) => setTimeout(ok, 50)); // deixa chegar no handler
    cancelar.abort();
    await pedido;
    await new Promise((ok) => setTimeout(ok, 50)); // deixa o `close` disparar

    const saida = await t.texto();
    presa?.end();
    await t.fechar();

    const atual = saida.match(/^http_requisicoes_em_andamento (\d+)$/m)?.[1];
    assert.equal(atual, '0', 'sem o close, a conexao abandonada ficaria somada para sempre');
  });
});

describe('métrica da outbox (RNF-007b)', () => {
  test('publica a idade da pendencia mais antiga', async () => {
    const t = await comApp((_app, metricas) => {
      metricas.medirOutbox(async () => 420);
    });

    const saida = await t.texto();
    await t.fechar();

    assert.match(saida, /^outbox_pendencia_mais_antiga_segundos 420$/m);
  });

  test('banco fora nao derruba a raspagem inteira', async () => {
    const t = await comApp((_app, metricas) => {
      metricas.medirOutbox(async () => { throw new Error('conexao recusada'); });
    });

    const r = await fetch(`${t.base}/metricas`);
    const saida = await r.text();
    await t.fechar();

    assert.equal(r.status, 200);
    assert.match(saida, /process_cpu_seconds_total/,
      'as metricas que nao dependem do banco tem de sobreviver a ele');
  });
});
