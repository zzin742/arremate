/**
 * Agendamento — o núcleo do sistema.
 *
 * A regra que o produto existe para garantir é uma só: **nunca dois
 * atendimentos vivos na mesma cadeira ao mesmo tempo.**
 *
 * Ela NÃO está aqui. Está na constraint `cadeira_ocupada_uma_vez`, em
 * `db/migrations/agd/002`. Este módulo faz três coisas em volta dela:
 *
 *   1. confere o que a constraint não cobre — expediente do barbeiro,
 *      bloqueio, e se o horário já passou;
 *   2. traduz a recusa do Postgres em resposta de negócio, com código
 *      próprio, em vez de deixar vazar um 500;
 *   3. publica o evento do agendamento na mesma transação.
 *
 * ## Por que não verificar antes e inserir depois
 *
 * A tentação é consultar "existe agendamento nesse horário?" e, se não
 * existir, inserir. Entre a consulta e o INSERT existe uma janela. Com
 * dois clientes tocando "agendar" no mesmo segundo — que é o caso comum
 * num horário disputado — os dois leem "livre" e os dois inserem.
 *
 * A constraint não tem janela: o Postgres avalia a exclusão no momento
 * do INSERT, sob o mesmo lock da página do índice. O segundo recebe
 * `exclusion_violation`, sempre, e é isso que este módulo traduz.
 *
 * ## Por que as conferências de expediente ficam na aplicação
 *
 * Expediente e bloqueio vêm do CAT por evento e vivem aqui como espelho.
 * Poderiam virar constraint, mas a regra depende de dado replicado: uma
 * constraint sobre espelho recusaria agendamento legítimo durante os
 * segundos em que o espelho está atrasado. Conferir na aplicação deixa a
 * decisão explícita e o erro legível.
 */

import { emTransacao, pool } from './db.js';

export class AgendamentoRecusado extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
  }
}

/** Fim do atendimento a partir do início e da duração do serviço. */
const somarMinutos = (hora, minutos) => {
  const [h, m] = hora.split(':').map(Number);
  const total = h * 60 + m + minutos;
  if (total >= 24 * 60) return null;      // atravessaria a meia-noite
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/**
 * Marca o atendimento.
 *
 * `duracaoMin` vem de quem chama, não do CAT: o AGD não consulta outro
 * serviço dentro da transação. Quem chama é a borda, que já leu o
 * serviço para montar a tela.
 */
export async function agendar({
  idBarbearia, idBarbeiro, idServico, idCliente = null,
  nomeEncaixe = null, whatsappEncaixe = null,
  dia, comecaEm, duracaoMin, valorCentavos = 0,
  origem = 'site', idAssinatura = null,
}) {
  if (!idCliente && !nomeEncaixe) {
    throw new AgendamentoRecusado('sem_dono', 'Informe o cliente ou o nome do encaixe');
  }

  const terminaEm = somarMinutos(comecaEm, duracaoMin);
  if (!terminaEm) {
    throw new AgendamentoRecusado('atravessa_a_meia_noite', 'O atendimento não cabe antes da meia-noite');
  }

  return emTransacao(async (cx) => {
    // ── 1. o horário já passou? ───────────────────────────────────────
    //
    // Pelo relógio do BANCO, com `clock_timestamp()`. Em JavaScript seria
    // outro relógio decidindo a mesma coisa, e um desvio de segundos entre
    // a aplicação e o Postgres faz nascer agendamento no passado ou recusar
    // um legítimo. É o mesmo motivo de o `now()` não servir: ele congela no
    // início da transação, e esta pode esperar na fila.
    const { rows: [{ passou }] } = await cx.query(
      `SELECT ($1::date + $2::time) <= clock_timestamp() AT TIME ZONE 'America/Sao_Paulo' AS passou`,
      [dia, comecaEm],
    );
    if (passou) {
      throw new AgendamentoRecusado('horario_no_passado', 'Esse horário já passou');
    }

    // ── 2. o barbeiro trabalha nesse dia e nessa faixa? ───────────────
    const { rows: [expediente] } = await cx.query(
      `SELECT 1 FROM expediente_espelho
        WHERE id_barbeiro = $1
          AND dia_da_semana = EXTRACT(DOW FROM $2::date)
          AND comeca_em <= $3::time
          AND termina_em >= $4::time
        LIMIT 1`,
      [idBarbeiro, dia, comecaEm, terminaEm],
    );
    if (!expediente) {
      throw new AgendamentoRecusado('fora_do_expediente', 'O barbeiro não atende nesse horário');
    }

    // ── 3. há bloqueio? ──────────────────────────────────────────────
    const { rows: [bloqueio] } = await cx.query(
      `SELECT motivo FROM bloqueio_espelho
        WHERE id_barbeiro = $1
          AND tstzrange(comeca_em, termina_em, '[)')
              && tstzrange(($2::date + $3::time) AT TIME ZONE 'America/Sao_Paulo',
                           ($2::date + $4::time) AT TIME ZONE 'America/Sao_Paulo', '[)')
        LIMIT 1`,
      [idBarbeiro, dia, comecaEm, terminaEm],
    );
    if (bloqueio) {
      throw new AgendamentoRecusado('horario_bloqueado', 'O barbeiro bloqueou esse horário');
    }

    // ── 4. a cadeira ─────────────────────────────────────────────────
    //
    // Aqui não há conferência: o INSERT é a conferência. A constraint
    // decide, e quem perder a corrida recebe `exclusion_violation`.
    let agendamento;
    try {
      const r = await cx.query(
        `INSERT INTO agendamento
           (id_barbearia, id_barbeiro, id_servico, id_cliente, nome_encaixe,
            whatsapp_encaixe, dia, comeca_em, termina_em, valor_centavos,
            origem, por_assinatura, id_assinatura)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         RETURNING *`,
        [idBarbearia, idBarbeiro, idServico, idCliente, nomeEncaixe,
         whatsappEncaixe, dia, comecaEm, terminaEm, valorCentavos,
         origem, idAssinatura !== null, idAssinatura],
      );
      agendamento = r.rows[0];
    } catch (e) {
      if (e.code === '23P01') {           // exclusion_violation
        throw new AgendamentoRecusado('horario_ocupado', 'Esse horário acabou de ser preenchido');
      }
      throw e;
    }

    // ── 5. o evento, na mesma transação ──────────────────────────────
    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('agendamento', $1, 'agendamento_criado', $2)`,
      [agendamento.id, JSON.stringify({
        id_agendamento: agendamento.id,
        id_barbearia: agendamento.id_barbearia,
        id_barbeiro: agendamento.id_barbeiro,
        id_servico: agendamento.id_servico,
        id_cliente: agendamento.id_cliente,
        dia: agendamento.dia,
        comeca_em: agendamento.comeca_em,
        por_assinatura: agendamento.por_assinatura,
        id_assinatura: agendamento.id_assinatura,
      })],
    );

    return agendamento;
  });
}

/**
 * Cancela. Quem cancela importa: cliente e barbearia geram status
 * diferentes, e o relatório do dono separa um do outro.
 */
export async function cancelar(idAgendamento, { por, idQuemPede }) {
  const status = por === 'cliente' ? 'cancelado_pelo_cliente' : 'cancelado_pela_barbearia';

  return emTransacao(async (cx) => {
    const { rows: [atual] } = await cx.query(
      'SELECT * FROM agendamento WHERE id = $1 FOR UPDATE',
      [idAgendamento],
    );
    if (!atual) {
      throw new AgendamentoRecusado('nao_encontrado', 'Agendamento não encontrado');
    }

    // Cliente só cancela o próprio. Sem isto, qualquer sessão válida
    // cancelaria o corte de qualquer pessoa sabendo o id.
    if (por === 'cliente' && atual.id_cliente !== idQuemPede) {
      throw new AgendamentoRecusado('nao_e_seu', 'Este agendamento não é seu');
    }

    // Idempotente: cancelar duas vezes não publica dois eventos nem muda
    // quem cancelou primeiro.
    if (atual.status !== 'agendado') {
      return { cancelado: false, motivo: `ja_estava_${atual.status}`, agendamento: atual };
    }

    const { rows: [novo] } = await cx.query(
      'UPDATE agendamento SET status = $2 WHERE id = $1 RETURNING *',
      [idAgendamento, status],
    );

    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('agendamento', $1, 'agendamento_cancelado', $2)`,
      [novo.id, JSON.stringify({
        id_agendamento: novo.id,
        id_barbearia: novo.id_barbearia,
        id_cliente: novo.id_cliente,
        status: novo.status,
        por,
      })],
    );

    return { cancelado: true, agendamento: novo };
  });
}

/** Conclui o atendimento. É daqui que nasce o direito de avaliar. */
export async function concluir(idAgendamento) {
  return emTransacao(async (cx) => {
    const { rows: [atual] } = await cx.query(
      'SELECT * FROM agendamento WHERE id = $1 FOR UPDATE',
      [idAgendamento],
    );
    if (!atual) {
      throw new AgendamentoRecusado('nao_encontrado', 'Agendamento não encontrado');
    }
    if (atual.status === 'concluido') {
      return { concluido: false, motivo: 'ja_concluido', agendamento: atual };
    }
    if (atual.status !== 'agendado') {
      throw new AgendamentoRecusado('nao_esta_agendado', `Não dá para concluir um atendimento ${atual.status}`);
    }

    const { rows: [novo] } = await cx.query(
      "UPDATE agendamento SET status = 'concluido' WHERE id = $1 RETURNING *",
      [idAgendamento],
    );

    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('agendamento', $1, 'atendimento_concluido', $2)`,
      [novo.id, JSON.stringify({
        id_agendamento: novo.id,
        id_barbearia: novo.id_barbearia,
        id_barbeiro: novo.id_barbeiro,
        id_cliente: novo.id_cliente,
        id_servico: novo.id_servico,
        valor_centavos: novo.valor_centavos,
        por_assinatura: novo.por_assinatura,
        id_assinatura: novo.id_assinatura,
      })],
    );

    return { concluido: true, agendamento: novo };
  });
}

/** Marca falta. Libera a cadeira, porque ela esteve vaga de verdade. */
export async function marcarFalta(idAgendamento) {
  const { rows: [novo] } = await pool.query(
    `UPDATE agendamento SET status = 'faltou'
      WHERE id = $1 AND status = 'agendado'
     RETURNING *`,
    [idAgendamento],
  );
  if (!novo) {
    throw new AgendamentoRecusado('nao_esta_agendado', 'Só um atendimento agendado pode virar falta');
  }
  return novo;
}

/** Agenda do dia, para o painel da barbearia. */
export async function agendaDoDia(idBarbearia, dia) {
  const { rows } = await pool.query(
    `SELECT * FROM agendamento
      WHERE id_barbearia = $1 AND dia = $2
      ORDER BY comeca_em, id_barbeiro`,
    [idBarbearia, dia],
  );
  return rows;
}

/** Os agendamentos de um cliente, do mais recente para trás. */
export async function meusAgendamentos(idCliente, { limite = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM agendamento
      WHERE id_cliente = $1
      ORDER BY dia DESC, comeca_em DESC
      LIMIT $2`,
    [idCliente, limite],
  );
  return rows;
}

/**
 * Horários livres de um barbeiro num dia.
 *
 * Calculado a partir do expediente, dos bloqueios e do que já está
 * marcado. É consulta, não garantia: entre ver o horário livre e marcar,
 * outra pessoa pode marcar. Quem garante é a constraint — e é por isso
 * que a tela precisa tratar `horario_ocupado` mesmo tendo acabado de
 * mostrar o horário como livre.
 */
export async function horariosLivres(idBarbeiro, dia, duracaoMin, { passoMin = 15 } = {}) {
  const { rows: faixas } = await pool.query(
    `SELECT comeca_em, termina_em FROM expediente_espelho
      WHERE id_barbeiro = $1 AND dia_da_semana = EXTRACT(DOW FROM $2::date)
      ORDER BY comeca_em`,
    [idBarbeiro, dia],
  );
  if (faixas.length === 0) return [];

  const { rows: ocupados } = await pool.query(
    `SELECT comeca_em, termina_em FROM agendamento
      WHERE id_barbeiro = $1 AND dia = $2
        AND status IN ('agendado', 'concluido')`,
    [idBarbeiro, dia],
  );
  const { rows: bloqueios } = await pool.query(
    `SELECT (comeca_em AT TIME ZONE 'America/Sao_Paulo')::time AS comeca_em,
            (termina_em AT TIME ZONE 'America/Sao_Paulo')::time AS termina_em
       FROM bloqueio_espelho
      WHERE id_barbeiro = $1
        AND (comeca_em AT TIME ZONE 'America/Sao_Paulo')::date = $2::date`,
    [idBarbeiro, dia],
  );

  const emMinutos = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
  const tomados = [...ocupados, ...bloqueios].map((o) => [
    emMinutos(o.comeca_em), emMinutos(o.termina_em),
  ]);

  const livres = [];
  for (const faixa of faixas) {
    const fim = emMinutos(faixa.termina_em);
    for (let i = emMinutos(faixa.comeca_em); i + duracaoMin <= fim; i += passoMin) {
      const conflita = tomados.some(([a, b]) => i < b && i + duracaoMin > a);
      if (!conflita) {
        livres.push(`${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}`);
      }
    }
  }
  return livres;
}

export { somarMinutos };
