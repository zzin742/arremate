/**
 * Consumidor de fila — os caminhos que o teste ponta a ponta não alcança.
 *
 * `outbox.test.js` prova o caminho feliz contra o LocalStack de verdade:
 * publica, assina, consome. O que fica de fora ali é o que acontece
 * quando algo dá errado, e é justamente onde mora a garantia do
 * RNF-007c — evento publicado e não consumido não pode se perder.
 *
 * Aqui o cliente SQS é um dublê, de propósito: os casos são "a mensagem
 * está corrompida" e "o tratamento falhou", que com um serviço de
 * verdade seriam difíceis de produzir sob demanda.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { criarConsumidor } from '../src/consumidor.js';

/**
 * Dublê do SQS.
 *
 * Responde ao Receive com as mensagens dadas e anota cada Delete. O que
 * foi apagado é a prova que interessa: mensagem apagada é mensagem que
 * ninguém vai reprocessar.
 */
function sqsFalso(mensagens) {
  const apagadas = [];
  let recebimentos = 0;
  return {
    apagadas,
    get recebimentos() { return recebimentos; },
    async send(comando) {
      const nome = comando.constructor.name;
      if (nome === 'ReceiveMessageCommand') {
        recebimentos += 1;
        return { Messages: recebimentos === 1 ? mensagens : [] };
      }
      if (nome === 'DeleteMessageCommand') {
        apagadas.push(comando.input.ReceiptHandle);
        return {};
      }
      throw new Error(`comando inesperado: ${nome}`);
    },
  };
}

/**
 * Envelope do SNS.
 *
 * Os atributos vêm DENTRO do envelope e com a chave `Value`; na
 * mensagem crua eles vêm no nível do SQS e com `StringValue`. São dois
 * formatos diferentes para a mesma informação, e é por isso que o
 * consumidor lê os dois.
 */
const envelopeSns = (corpo, idEvento) => ({
  ReceiptHandle: `rh-${idEvento}`,
  Body: JSON.stringify({
    Type: 'Notification',
    Message: JSON.stringify(corpo),
    MessageAttributes: { id_evento: { Value: idEvento } },
  }),
});

const mensagemCrua = (corpo, idEvento) => ({
  ReceiptHandle: `rh-${idEvento}`,
  Body: JSON.stringify(corpo),
  MessageAttributes: { id_evento: { StringValue: idEvento } },
});

describe('formatos de entrega', () => {
  test('aceita o envelope do SNS', async () => {
    const recebidos = [];
    const cliente = sqsFalso([envelopeSns({ id_empresa: 'e1' }, 'ev-1')]);
    const c = criarConsumidor({
      urlFila: 'fila', cliente, tratar: async (m) => recebidos.push(m),
    });

    assert.equal(await c.consumirLote(), 1);
    assert.deepEqual(recebidos[0].corpo, { id_empresa: 'e1' });
    assert.equal(recebidos[0].idEvento, 'ev-1');
  });

  test('aceita a mensagem crua, sem envelope', async () => {
    // A fila assinando um tópico recebe envelopada; enviada direto, não.
    // Os dois formatos existem porque o LocalStack e a AWS diferem aqui,
    // e o mesmo código tem de servir aos dois.
    const recebidos = [];
    const cliente = sqsFalso([mensagemCrua({ id_empresa: 'e2' }, 'ev-2')]);
    const c = criarConsumidor({
      urlFila: 'fila', cliente, tratar: async (m) => recebidos.push(m),
    });

    assert.equal(await c.consumirLote(), 1);
    assert.deepEqual(recebidos[0].corpo, { id_empresa: 'e2' });
  });
});

describe('o que NÃO pode ser apagado (RNF-007c)', () => {
  test('corpo ilegível não é apagado: vai para a DLQ', async () => {
    // Apagar aqui seria perder o evento em silêncio. Deixar na fila faz
    // ele estourar as três tentativas e cair na DLQ, que é onde um
    // corpo corrompido tem de ser visto por alguém.
    const cliente = sqsFalso([{ ReceiptHandle: 'rh-x', Body: 'isto não é json' }]);
    let tratou = false;
    const c = criarConsumidor({
      urlFila: 'fila', cliente, tratar: async () => { tratou = true; },
    });

    assert.equal(await c.consumirLote(), 0);
    assert.equal(tratou, false, 'não dá para tratar o que não dá para ler');
    assert.deepEqual(cliente.apagadas, [], 'mensagem ilegível NÃO pode ser apagada');
  });

  test('tratamento que falha não apaga a mensagem', async () => {
    const cliente = sqsFalso([envelopeSns({ x: 1 }, 'ev-3')]);
    const c = criarConsumidor({
      urlFila: 'fila', cliente, tratar: async () => { throw new Error('banco fora'); },
    });

    assert.equal(await c.consumirLote(), 0);
    assert.deepEqual(cliente.apagadas, [], 'falha temporária tem de poder ser repetida');
  });

  test('uma mensagem ruim não impede as boas do mesmo lote', async () => {
    // Sem o `continue`, uma mensagem corrompida abortaria o lote e
    // seguraria todas as outras atrás dela.
    const cliente = sqsFalso([
      { ReceiptHandle: 'rh-ruim', Body: '{{{' },
      envelopeSns({ x: 1 }, 'ev-boa'),
    ]);
    const c = criarConsumidor({ urlFila: 'fila', cliente, tratar: async () => {} });

    assert.equal(await c.consumirLote(), 1);
    assert.deepEqual(cliente.apagadas, ['rh-ev-boa']);
  });

  test('apaga DEPOIS de tratar, nunca antes', async () => {
    const ordem = [];
    const cliente = sqsFalso([envelopeSns({ x: 1 }, 'ev-4')]);
    const enviarOriginal = cliente.send.bind(cliente);
    cliente.send = async (cmd) => {
      if (cmd.constructor.name === 'DeleteMessageCommand') ordem.push('apagou');
      return enviarOriginal(cmd);
    };

    const c = criarConsumidor({
      urlFila: 'fila', cliente, tratar: async () => { ordem.push('tratou'); },
    });
    await c.consumirLote();

    assert.deepEqual(ordem, ['tratou', 'apagou'],
      'apagar antes de tratar perderia o evento se o tratamento falhasse');
  });
});

describe('laço de consumo', () => {
  test('erro na leitura não derruba o laço, e parar() encerra', async () => {
    // Fila indisponível é temporário. Se o laço morresse no primeiro
    // erro, o serviço pararia de consumir e ninguém saberia — a fila
    // encheria até a mensagem expirar.
    let tentativas = 0;
    const cliente = {
      async send() {
        tentativas += 1;
        if (tentativas === 1) throw new Error('fila indisponível');
        return { Messages: [] };
      },
    };

    const c = criarConsumidor({ urlFila: 'fila', cliente, tratar: async () => {} });
    const laco = c.iniciar();

    // a espera após o erro é de 2 s; depois dela o laço tenta de novo
    await new Promise((ok) => setTimeout(ok, 2300));
    c.parar();
    await laco;

    assert.ok(tentativas >= 2, `o laço tem de ter tentado de novo (tentou ${tentativas}x)`);
  });
});
