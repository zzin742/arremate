import {
  SQSClient, ReceiveMessageCommand, DeleteMessageCommand,
} from '@aws-sdk/client-sqs';

/**
 * Consumidor de fila SQS.
 *
 * **O ponto de confirmação importa** (arquitetura, §3.4). A mensagem só é
 * apagada da fila **depois** que o trabalho terminou. Apagar antes abriria
 * janela de perda; processar e cair antes de apagar gera repetição — que é
 * tolerável, porque `tratar` recebe o `id_evento` e deve ser idempotente.
 *
 * A entrega é **ao menos uma vez**. Quem consome precisa deduplicar.
 */
export function criarConsumidor({ urlFila, tratar, cliente, esperaSegundos = 5 }) {
  const sqs = cliente ?? new SQSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  /** Lê e processa um lote. Devolve quantas foram tratadas. */
  async function consumirLote() {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: urlFila,
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: esperaSegundos,     // long polling: menos chamada vazia
      MessageAttributeNames: ['All'],
    }));

    let tratadas = 0;
    for (const msg of Messages) {
      // O SNS entrega envelopado quando a fila assina um tópico; a mensagem
      // crua chega direto. Os dois formatos são aceitos para o mesmo código
      // funcionar com LocalStack e com a AWS.
      let corpo;
      let atributos;
      try {
        const bruto = JSON.parse(msg.Body);
        if (bruto.Type === 'Notification') {
          corpo = JSON.parse(bruto.Message);
          atributos = bruto.MessageAttributes ?? {};
        } else {
          corpo = bruto;
          atributos = msg.MessageAttributes ?? {};
        }
      } catch {
        // corpo ilegível não melhora com repetição: deixa estourar as
        // tentativas e ir para a DLQ, que é onde isso tem de ser visto
        continue;
      }

      const idEvento = atributos.id_evento?.Value ?? atributos.id_evento?.StringValue;

      try {
        await tratar({ idEvento, corpo, atributos });
      } catch (e) {
        // não apaga: volta para a fila depois do prazo de visibilidade e,
        // após 3 recebimentos, cai na DLQ (RF-010)
        console.error(`falha ao tratar ${idEvento}:`, e.message);
        continue;
      }

      // só agora — o trabalho terminou
      await sqs.send(new DeleteMessageCommand({
        QueueUrl: urlFila, ReceiptHandle: msg.ReceiptHandle,
      }));
      tratadas++;
    }
    return tratadas;
  }

  let rodando = false;
  return {
    consumirLote,
    async iniciar() {
      rodando = true;
      while (rodando) {
        try {
          await consumirLote();
          // Cede o controle entre as voltas.
          //
          // O `await` de uma promessa que já resolveu só agenda uma
          // microtask, e microtask não deixa o laço de eventos
          // respirar: o `while` roda milhões de voltas sem que nenhum
          // `setTimeout` chegue a disparar. Medido — cinco milhões de
          // voltas e um timer de 200 ms ainda não tinha vencido.
          //
          // Com o long polling de 5 s isso não aparece, porque cada
          // chamada demora. Some o atraso (fila vazia respondendo na
          // hora, `esperaSegundos = 0`, dublê em teste) e o serviço
          // passa a queimar um núcleo sem atender mais nada — nem o
          // `parar()`, que depende de um timer para ser chamado.
          await new Promise((r) => setImmediate(r));
        } catch (e) {
          console.error('consumidor:', e.message);
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    },
    parar() { rodando = false; },
  };
}
