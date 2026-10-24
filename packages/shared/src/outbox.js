import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

/**
 * Publicador da outbox, reusado por AUTH, CAT, LEI e MID (MER §4.10).
 *
 * O que ele garante — e o que **não** garante:
 *
 * - **RNF-007b, do commit até a publicação:** o evento foi gravado na mesma
 *   transação do dado de domínio. Se o processo cair antes de publicar, a
 *   linha continua com `publicado_em` nulo e sai na próxima rodada.
 * - **Entrega ao menos uma vez, nunca exatamente uma.** Se a publicação
 *   funcionar e a marcação falhar, o evento sai de novo. O consumidor
 *   precisa deduplicar pelo `id_evento`, que é a PK da outbox.
 * - **RNF-007c, da publicação até o consumo, não é problema daqui.** Depois
 *   que o SNS confirma, este código considera entregue. Quem segura dali em
 *   diante é a fila na camada persistente (ADR-010).
 */
export function criarPublicador({ pool, topicos, cliente, lote = 50 }) {
  const sns = cliente ?? new SNSClient({
    region: process.env.AWS_REGION ?? 'us-east-1',
    endpoint: process.env.AWS_ENDPOINT ?? 'http://localhost:4566',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });

  /** Publica os pendentes. Devolve o que saiu e o que falhou. */
  async function publicarPendentes() {
    const { rows: pendentes } = await pool.query(
      `SELECT id, agregado, id_agregado, tipo_evento, payload, pendente_desde
         FROM outbox
        WHERE publicado_em IS NULL
        ORDER BY criado_em
        LIMIT $1`,
      [lote],
    );

    const publicados = [];
    const falhas = [];

    for (const evento of pendentes) {
      const arn = topicos[evento.tipo_evento];
      if (!arn) {
        // tipo de evento sem tópico é erro de configuração, não de dado:
        // falhar alto é melhor que publicar no lugar errado em silêncio
        falhas.push({ id: evento.id, motivo: `sem tópico para "${evento.tipo_evento}"` });
        continue;
      }

      try {
        await sns.send(new PublishCommand({
          TopicArn: arn,
          Message: JSON.stringify(evento.payload),
          MessageAttributes: {
            // o consumidor deduplica por este id; é a PK da outbox
            id_evento: { DataType: 'String', StringValue: evento.id },
            tipo_evento: { DataType: 'String', StringValue: evento.tipo_evento },
            // marca o início da pendência, para o painel medir a idade real
            // em vez da métrica da DLQ, que conta da transferência
            pendente_desde: { DataType: 'String', StringValue: evento.pendente_desde.toISOString() },
          },
        }));
      } catch (e) {
        falhas.push({ id: evento.id, motivo: e.message });
        continue;    // fica pendente e sai na próxima rodada
      }

      // Se cair ENTRE o publish e este UPDATE, o evento sai de novo na
      // próxima rodada. É o lado "ao menos uma vez" do contrato, e é por
      // isso que o consumidor tem de ser idempotente.
      await pool.query('UPDATE outbox SET publicado_em = now() WHERE id = $1', [evento.id]);
      publicados.push(evento.id);
    }

    return { publicados, falhas, pendentesLidos: pendentes.length };
  }

  let timer = null;
  return {
    publicarPendentes,
    iniciar(intervaloMs = 1000) {
      if (timer) return;
      timer = setInterval(() => {
        publicarPendentes().catch((e) => console.error('publicador da outbox:', e.message));
      }, intervaloMs);
      timer.unref?.();
    },
    parar() { clearInterval(timer); timer = null; },
  };
}

/**
 * Idade da pendência mais antiga, em segundos.
 *
 * Alimenta o painel do RNF-007c: a idade é medida de `pendente_desde`, que
 * o evento carrega desde a outbox, e não da métrica da DLQ — lá o relógio
 * reinicia na transferência (arquitetura, §3.4).
 */
export async function idadeDaPendenciaMaisAntiga(pool) {
  const { rows } = await pool.query(
    `SELECT EXTRACT(EPOCH FROM (now() - MIN(pendente_desde)))::int AS segundos
       FROM outbox WHERE publicado_em IS NULL`,
  );
  return rows[0].segundos ?? 0;
}
