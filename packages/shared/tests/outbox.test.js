import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { SNSClient, ListTopicsCommand } from '@aws-sdk/client-sns';
import {
  SQSClient, GetQueueUrlCommand, ReceiveMessageCommand, DeleteMessageCommand,
} from '@aws-sdk/client-sqs';
import { criarPublicador, idadeDaPendenciaMaisAntiga } from '../src/outbox.js';
import { criarConsumidor } from '../src/consumidor.js';

pg.types.setTypeParser(20, Number);

const cfg = {
  region: 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};
const sns = new SNSClient(cfg);
const sqs = new SQSClient(cfg);

const pool = new pg.Pool({
  host: 'localhost', port: 5432, user: 'arremate',
  password: 'arremate', database: 'arremate_auth',
});

let topicos = {};
let urlFila;

before(async () => {
  const { Topics } = await sns.send(new ListTopicsCommand({}));
  // o publicador mapeia tipo_evento -> ARN; aqui montamos esse mapa a
  // partir do que o LocalStack criou
  topicos = Object.fromEntries(
    Topics.map((t) => [t.TopicArn.split(':').pop().replace(/-/g, '_'), t.TopicArn]),
  );
  assert.ok(topicos.conta_criada, 'o tópico conta-criada precisa existir no LocalStack');

  const { QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: 'habilitacao-verificar' }));
  urlFila = QueueUrl;
});

/**
 * Esvazia a fila lendo e apagando.
 *
 * Nada de PurgeQueue: a AWS permite uma chamada a cada 60 segundos por
 * fila, e o LocalStack respeita isso. Com `beforeEach` em sete testes, o
 * segundo em diante ficava preso no limite — um teste levou 102 s e falhou
 * por timeout, não por bug no código.
 */
async function esvaziarFila() {
  for (let i = 0; i < 10; i++) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: urlFila, MaxNumberOfMessages: 10, WaitTimeSeconds: 0,
    }));
    if (Messages.length === 0) return;
    for (const m of Messages) {
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: urlFila, ReceiptHandle: m.ReceiptHandle,
      }));
    }
  }
}

beforeEach(async () => {
  await pool.query('TRUNCATE outbox');
  await esvaziarFila();
});

after(async () => { await pool.end(); });

const gravarEvento = (tipo = 'conta_criada', payload = { teste: true }) =>
  pool.query(
    `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
     VALUES ('empresa', gen_random_uuid(), $1, $2) RETURNING id`,
    [tipo, JSON.stringify(payload)],
  ).then((r) => r.rows[0].id);

describe('publicador da outbox (RNF-007b)', () => {
  test('publica o pendente e marca publicado_em', async () => {
    const id = await gravarEvento();
    const pub = criarPublicador({ pool, topicos, cliente: sns });

    const r = await pub.publicarPendentes();
    assert.deepEqual(r.publicados, [id]);
    assert.deepEqual(r.falhas, []);

    const { rows } = await pool.query('SELECT publicado_em FROM outbox WHERE id = $1', [id]);
    assert.ok(rows[0].publicado_em, 'tem de sair da fila de pendentes');
  });

  test('não republica o que já foi publicado', async () => {
    await gravarEvento();
    const pub = criarPublicador({ pool, topicos, cliente: sns });

    await pub.publicarPendentes();
    const segunda = await pub.publicarPendentes();
    assert.equal(segunda.pendentesLidos, 0, 'o publicador só olha publicado_em nulo');
  });

  test('tipo de evento sem tópico vira falha, não some em silêncio', async () => {
    const id = await gravarEvento('evento_que_nao_existe');
    const pub = criarPublicador({ pool, topicos, cliente: sns });

    const r = await pub.publicarPendentes();
    assert.equal(r.publicados.length, 0);
    assert.equal(r.falhas.length, 1);
    assert.match(r.falhas[0].motivo, /sem tópico/);

    const { rows } = await pool.query('SELECT publicado_em FROM outbox WHERE id = $1', [id]);
    assert.equal(rows[0].publicado_em, null, 'falha tem de continuar pendente');
  });

  test('falha do SNS deixa o evento pendente para a próxima rodada', async () => {
    const id = await gravarEvento();
    const snsQuebrado = { send: async () => { throw new Error('rede caiu'); } };
    const pub = criarPublicador({ pool, topicos, cliente: snsQuebrado });

    const r = await pub.publicarPendentes();
    assert.equal(r.falhas.length, 1);

    const { rows } = await pool.query('SELECT publicado_em FROM outbox WHERE id = $1', [id]);
    assert.equal(rows[0].publicado_em, null, 'nada se perde: sai na próxima rodada');
  });

  test('idade da pendência mais antiga alimenta o painel do RNF-007c', async () => {
    assert.equal(await idadeDaPendenciaMaisAntiga(pool), 0, 'sem pendência, idade zero');
    await gravarEvento();
    assert.ok(await idadeDaPendenciaMaisAntiga(pool) >= 0);

    const pub = criarPublicador({ pool, topicos, cliente: sns });
    await pub.publicarPendentes();
    assert.equal(await idadeDaPendenciaMaisAntiga(pool), 0, 'publicado sai da conta');
  });
});

describe('ponta a ponta: outbox → SNS → SQS → consumidor', () => {
  test('o evento sai da outbox e chega na fila do HAB', async () => {
    const id = await gravarEvento('conta_criada', { cnpj: '11222333000181' });
    const pub = criarPublicador({ pool, topicos, cliente: sns });
    await pub.publicarPendentes();

    // o SNS entrega à assinatura de forma assíncrona
    let recebida = null;
    for (let i = 0; i < 20 && !recebida; i++) {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
        QueueUrl: urlFila, MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1, MessageAttributeNames: ['All'],
      }));
      recebida = Messages[0] ?? null;
    }

    assert.ok(recebida, 'a mensagem tem de chegar na fila assinante');
    const envelope = JSON.parse(recebida.Body);
    const corpo = JSON.parse(envelope.Message ?? recebida.Body);
    assert.equal(corpo.cnpj, '11222333000181');

    const atrib = envelope.MessageAttributes ?? {};
    assert.equal(atrib.id_evento?.Value, id, 'o id do evento viaja para o consumidor deduplicar');
    assert.ok(atrib.pendente_desde?.Value, 'pendente_desde viaja junto (arquitetura §3.4)');
  });

  test('consumidor só apaga a mensagem DEPOIS de tratar', async () => {
    await gravarEvento('conta_criada', { marca: 'confirmacao-tardia' });
    const pub = criarPublicador({ pool, topicos, cliente: sns });
    await pub.publicarPendentes();
    await new Promise((r) => setTimeout(r, 1500));

    // primeira passada: o tratamento falha, a mensagem NÃO pode sumir
    let tentativas = 0;
    const comFalha = criarConsumidor({
      urlFila, cliente: sqs, esperaSegundos: 2,
      tratar: async () => { tentativas++; throw new Error('falha simulada'); },
    });
    const tratadas = await comFalha.consumirLote();
    assert.equal(tratadas, 0);
    assert.ok(tentativas >= 1, 'o tratamento foi tentado');

    // a mensagem volta para a fila após o prazo de visibilidade
    await new Promise((r) => setTimeout(r, 1000));

    let vista = 0;
    const comSucesso = criarConsumidor({
      urlFila, cliente: sqs, esperaSegundos: 5,
      tratar: async ({ idEvento }) => { assert.ok(idEvento); vista++; },
    });
    for (let i = 0; i < 25 && vista === 0; i++) await comSucesso.consumirLote();

    assert.equal(vista, 1, 'a mensagem continuava na fila — apagar antes de tratar a teria perdido');
  });
});
