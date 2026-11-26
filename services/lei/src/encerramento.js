/**
 * Encerramento do leilão (RF-018), prorrogação (RF-017) e anulação do
 * arremate por reverificação negativa (RF-004b).
 *
 * O encerrador relê `encerra_em` **sob a mesma trava** que o lance usa.
 * Sem isso existe a janela clássica: o encerrador decide que venceu, um
 * lance entra no mesmo instante, e o leilão fecha com um lance a mais do
 * que o arremate registrou — ou com um arremate que não é o maior.
 *
 * O que este módulo NÃO faz: devolver ou abater caução. Isso é do CAU.
 * Aqui a decisão é persistida e publicada em `leilao_liquidar`; quem age
 * sobre o dinheiro é o outro serviço. A divisão importa porque abater e
 * devolver chamam um provedor externo, e nada disso pode acontecer
 * dentro da trava da linha do leilão.
 */

import { emTransacao } from './db.js';

export class ErroDeEncerramento extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

/**
 * Encerra o leilão se o prazo venceu. Idempotente.
 *
 * Devolve o que foi feito, para quem chamou poder distinguir "encerrei"
 * de "ainda não venceu" sem ter de consultar de novo.
 */
export async function encerrarLeilao(idLeilao) {
  return emTransacao(async (cx) => {
    // Mesma trava do lance. É o que faz o encerramento e o lance
    // concorrente se enfileirarem em vez de se cruzarem.
    const { rows: [leilao] } = await cx.query(
      `SELECT id, id_empresa, encerra_em, status
         FROM leilao
        WHERE id = $1
          FOR UPDATE`,
      [idLeilao],
    );

    if (!leilao) {
      throw new ErroDeEncerramento('leilao_inexistente', 'Leilão não encontrado');
    }

    // Já encerrado: nada a fazer. O encerrador roda por tempo, então vai
    // encontrar o mesmo leilão de novo; repetir não pode gravar outro
    // arremate.
    if (leilao.status !== 'aberto') {
      return { encerrado: false, motivo: `status_${leilao.status}`, leilao };
    }

    // Relê o prazo com `clock_timestamp()`, dentro da trava. O `now()`
    // congela no início da transação e daria o relógio de ANTES da
    // espera pelo lock — exatamente o erro que a prorrogação pode
    // introduzir, porque ela muda `encerra_em` enquanto o encerrador
    // espera.
    const { rows: [{ venceu }] } = await cx.query(
      'SELECT $1::timestamptz <= clock_timestamp() AS venceu',
      [leilao.encerra_em],
    );

    if (!venceu) {
      // Prorrogado enquanto este encerrador esperava a trava.
      return { encerrado: false, motivo: 'prazo_estendido', leilao };
    }

    const { rows: [maior] } = await cx.query(
      `SELECT id, id_empresa, valor, sequencia
         FROM lance
        WHERE id_leilao = $1
        ORDER BY sequencia DESC
        LIMIT 1`,
      [idLeilao],
    );

    // Sem lance: deserto, e NENHUM registro em ARREMATE (RF-018).
    if (!maior) {
      const { rows: [atualizado] } = await cx.query(
        "UPDATE leilao SET status = 'deserto' WHERE id = $1 RETURNING *",
        [idLeilao],
      );
      await publicarEncerramento(cx, { leilao: atualizado, arremate: null });
      return { encerrado: true, deserto: true, leilao: atualizado, arremate: null };
    }

    const { rows: [arremate] } = await cx.query(
      `INSERT INTO arremate (id_leilao, id_lance)
       VALUES ($1, $2)
       RETURNING *`,
      [idLeilao, maior.id],
    );

    const { rows: [atualizado] } = await cx.query(
      "UPDATE leilao SET status = 'encerrado' WHERE id = $1 RETURNING *",
      [idLeilao],
    );

    await publicarEncerramento(cx, { leilao: atualizado, arremate, lance: maior });

    return {
      encerrado: true, deserto: false, leilao: atualizado, arremate, lance: maior,
    };
  });
}

/**
 * Anula o arremate por reverificação negativa (RF-004b).
 *
 * A reprovação é impeditiva: o arremate é anulado com motivo, o leilão
 * vai para `arremate_anulado`, e a decisão de liquidação é publicada
 * para o CAU devolver TODAS as cauções — inclusive a do arrematante.
 *
 * O segundo colocado **não** é promovido. O requisito é explícito: quem
 * decide reofertar é o vendedor. Promover aqui pareceria prestativo e
 * mudaria a regra.
 */
export async function anularArremate(idLeilao, motivo) {
  if (!motivo) {
    throw new ErroDeEncerramento('motivo_obrigatorio', 'Anulação exige motivo registrado');
  }

  return emTransacao(async (cx) => {
    const { rows: [leilao] } = await cx.query(
      'SELECT id, status FROM leilao WHERE id = $1 FOR UPDATE',
      [idLeilao],
    );

    if (!leilao) {
      throw new ErroDeEncerramento('leilao_inexistente', 'Leilão não encontrado');
    }

    const { rows: [arremate] } = await cx.query(
      'SELECT * FROM arremate WHERE id_leilao = $1',
      [idLeilao],
    );

    if (!arremate) {
      throw new ErroDeEncerramento('sem_arremate', 'Este leilão não tem arremate a anular');
    }

    // Já anulado: repetir não muda nada nem publica de novo. A
    // reverificação pode ser disparada duas vezes para o mesmo
    // arrematante.
    if (arremate.anulado_em) {
      return { anulado: false, motivo: 'ja_anulado', arremate };
    }

    const { rows: [atualizado] } = await cx.query(
      `UPDATE arremate
          SET anulado_em = now(), motivo_anulacao = $2
        WHERE id_leilao = $1
       RETURNING *`,
      [idLeilao, motivo],
    );

    await cx.query(
      "UPDATE leilao SET status = 'arremate_anulado' WHERE id = $1",
      [idLeilao],
    );

    // `devolver_todas` dito em campo, não deduzido do status pelo CAU.
    // Quando o arremate é anulado NENHUMA caução é abatida (RF-023), e
    // deixar o CAU inferir isso poria a mesma regra em dois serviços.
    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('arremate', $1, 'leilao_liquidar', $2)`,
      [atualizado.id, JSON.stringify({
        id_leilao: idLeilao,
        id_arremate: atualizado.id,
        anulado: true,
        motivo,
        devolver_todas: true,
        abater_do_arrematante: null,
      })],
    );

    return { anulado: true, arremate: atualizado };
  });
}

/**
 * Aprova o arremate na reverificação e manda liquidar (RF-023).
 *
 * É o caminho feliz que faltava. A anulação já publicava
 * `leilao_liquidar` com `devolver_todas`, mas a aprovação não publicava
 * nada — então o CAU nunca recebia ordem de abater a caução do
 * arrematante, e o dinheiro ficava parado em `confirmada` para sempre.
 *
 * O `abater_do_arrematante` vai dito em campo, pelo mesmo motivo que o
 * `devolver_todas`: quem decide o destino de cada caução é o LEI, que
 * tem o arremate. Deixar o CAU deduzir "o arrematante é quem deu o maior
 * lance" poria a regra de negócio em dois serviços, e os dois poderiam
 * discordar.
 */
export async function aprovarArremate(idLeilao) {
  return emTransacao(async (cx) => {
    const { rows: [leilao] } = await cx.query(
      'SELECT id, status FROM leilao WHERE id = $1 FOR UPDATE',
      [idLeilao],
    );

    if (!leilao) {
      throw new ErroDeEncerramento('leilao_inexistente', 'Leilão não encontrado');
    }

    const { rows: [arremate] } = await cx.query(
      'SELECT * FROM arremate WHERE id_leilao = $1',
      [idLeilao],
    );

    if (!arremate) {
      throw new ErroDeEncerramento('sem_arremate', 'Este leilão não tem arremate a aprovar');
    }

    // Anulado não volta. A reverificação já foi decidida contra, e
    // reabrir por outra rota transformaria a anulação em opinião.
    if (arremate.anulado_em) {
      throw new ErroDeEncerramento('arremate_anulado', 'Arremate anulado não pode ser aprovado');
    }

    // Idempotente: aprovar de novo não publica outra liquidação, que
    // mandaria o CAU abater uma caução já abatida.
    if (arremate.aprovado_em) {
      return { aprovado: false, motivo: 'ja_aprovado', arremate };
    }

    const { rows: [atualizado] } = await cx.query(
      'UPDATE arremate SET aprovado_em = now() WHERE id_leilao = $1 RETURNING *',
      [idLeilao],
    );

    // De quem abater: o dono do lance vencedor. Lido aqui, do lance que
    // o arremate aponta, e não recalculado — o maior lance de hoje pode
    // não ser o que venceu, se algo entrou depois.
    const { rows: [lance] } = await cx.query(
      'SELECT id_empresa FROM lance WHERE id = $1',
      [atualizado.id_lance],
    );

    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('arremate', $1, 'leilao_liquidar', $2)`,
      [atualizado.id, JSON.stringify({
        id_leilao: idLeilao,
        id_arremate: atualizado.id,
        anulado: false,
        motivo: null,
        devolver_todas: false,
        abater_do_arrematante: lance.id_empresa,
      })],
    );

    return { aprovado: true, arremate: atualizado, idArrematante: lance.id_empresa };
  });
}

/** Evento de encerramento, na mesma transação da mudança de status. */
async function publicarEncerramento(cx, { leilao, arremate, lance }) {
  await cx.query(
    `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
     VALUES ('leilao', $1, 'leilao_encerrado', $2)`,
    [leilao.id, JSON.stringify({
      id_leilao: leilao.id,
      status: leilao.status,
      deserto: arremate === null,
      id_arremate: arremate?.id ?? null,
      id_arrematante: lance?.id_empresa ?? null,
      valor: lance?.valor ?? null,
    })],
  );
}

/**
 * Encerra todos os leilões vencidos. É o laço que roda por tempo.
 *
 * Um por transação, de propósito: uma transação só para todos faria um
 * leilão com problema impedir o encerramento dos outros, e manteria a
 * trava de todos eles aberta ao mesmo tempo.
 */
export async function encerrarVencidos(cx) {
  const { rows } = await cx.query(
    `SELECT id FROM leilao
      WHERE status = 'aberto' AND encerra_em <= clock_timestamp()
      ORDER BY encerra_em`,
  );

  const resultados = [];

  for (const { id } of rows) {
    try {
      resultados.push(await encerrarLeilao(id));
    } catch (e) {
      // Um leilão que falha não para a fila. O erro é registrado e o
      // próximo ciclo tenta de novo, porque o status não mudou.
      console.error(`encerrar ${id}:`, e.message);
      resultados.push({ encerrado: false, motivo: 'erro', id, erro: e.message });
    }
  }

  return resultados;
}
