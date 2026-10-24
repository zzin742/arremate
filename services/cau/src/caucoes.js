import { emTransacao, pool } from './db.js';
import { ProvedorIndisponivel } from './provedor.js';

export class ErroDeCaucao extends Error {
  constructor(codigo, mensagem, status = 409) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

/**
 * Transições válidas da caução.
 *
 * Declarar o mapa em vez de espalhar `if` pelo código tem um motivo: é
 * assim que fica evidente que `abatida` e `devolvida` são **terminais**.
 * Caução devolvida não volta a ser confirmada, e webhook atrasado não
 * pode ressuscitá-la.
 */
const TRANSICOES = {
  pendente: ['confirmada', 'recusada'],
  confirmada: ['abatida', 'devolvida'],
  recusada: [],
  abatida: [],
  devolvida: [],
};

const ehTerminal = (status) => TRANSICOES[status].length === 0;

/** Solicita a caução e dispara a cobrança (RF-019). */
export async function solicitar({ idLeilao, idEmpresa, valor }, { provedor }) {
  const existente = await pool.query(
    'SELECT * FROM caucao WHERE id_leilao = $1 AND id_empresa = $2',
    [idLeilao, idEmpresa],
  );
  if (existente.rows[0]) {
    // pedir duas vezes não cria duas cobranças
    return { ...existente.rows[0], repetida: true };
  }

  let cobranca;
  try {
    cobranca = await provedor.cobrar({ valor, referencia: `${idLeilao}:${idEmpresa}` });
  } catch (e) {
    if (e instanceof ProvedorIndisponivel) {
      throw new ErroDeCaucao('provedor_indisponivel', e.message, 503);
    }
    throw e;
  }

  const { rows: [caucao] } = await pool.query(
    `INSERT INTO caucao (id_leilao, id_empresa, valor, status, provedor, id_cobranca_externa)
     VALUES ($1, $2, $3, 'pendente', $4, $5)
     ON CONFLICT (id_leilao, id_empresa) DO UPDATE SET atualizado_em = now()
     RETURNING *`,
    [idLeilao, idEmpresa, valor, provedor.nome, cobranca.idCobranca],
  );
  return { ...caucao, repetida: false };
}

/**
 * Processa o webhook do provedor (RF-020, RF-021).
 *
 * **Idempotente pelo id do EVENTO, não da transação.** Uma transação de
 * pagamento gera vários eventos — autorizado, capturado, liquidado — e
 * deduplicar por transação descartaria eventos legítimos. A chave única
 * `(provedor, id_evento_externo)` no banco é quem garante isso: se dois
 * webhooks idênticos chegarem ao mesmo tempo, um dos dois falha no
 * `INSERT` e é tratado como repetido.
 */
export async function processarWebhook({ provedor, idEvento, idCobranca, tipo, payload }) {
  return emTransacao(async (cx) => {
    // trava a caução: duas transições simultâneas não podem se cruzar
    const { rows: [caucao] } = await cx.query(
      `SELECT * FROM caucao
        WHERE provedor = $1 AND id_cobranca_externa = $2
          FOR UPDATE`,
      [provedor, idCobranca],
    );

    if (!caucao) {
      throw new ErroDeCaucao('cobranca_desconhecida', 'Nenhuma caução com essa cobrança', 404);
    }

    try {
      await cx.query(
        `INSERT INTO evento_pagamento (id_caucao, provedor, id_evento_externo, tipo, payload)
         VALUES ($1, $2, $3, $4, $5)`,
        [caucao.id, provedor, idEvento, tipo, JSON.stringify(payload ?? {})],
      );
    } catch (e) {
      if (e.code === '23505') {
        // Repetido. Responder sucesso é proposital: o provedor reenvia
        // enquanto não receber 2xx, e insistir num evento já processado
        // só geraria mais chamadas.
        return { ...caucao, repetido: true, aplicado: false };
      }
      throw e;
    }

    const alvo = tipo === 'pagamento.aprovado' ? 'confirmada'
      : tipo === 'pagamento.recusado' ? 'recusada'
        : tipo === 'pagamento.devolvido' ? 'devolvida'
          : null;

    if (!alvo) return { ...caucao, repetido: false, aplicado: false };

    if (!TRANSICOES[caucao.status].includes(alvo)) {
      // RF-021b: confirmação que chega depois do leilão encerrado não
      // ressuscita a participação. O evento fica registrado — ele
      // aconteceu —, mas a transição não se aplica.
      return {
        ...caucao, repetido: false, aplicado: false,
        motivo: `transicao_invalida: ${caucao.status} -> ${alvo}`,
      };
    }

    const { rows: [atualizada] } = await cx.query(
      'UPDATE caucao SET status = $1, atualizado_em = now() WHERE id = $2 RETURNING *',
      [alvo, caucao.id],
    );
    return { ...atualizada, repetido: false, aplicado: true };
  });
}

/** A caução está ativa para este leilão? É o que o LEI pergunta (RF-012). */
export async function temCaucaoAtiva(idLeilao, idEmpresa) {
  const { rows } = await pool.query(
    `SELECT 1 FROM caucao
      WHERE id_leilao = $1 AND id_empresa = $2 AND status = 'confirmada'`,
    [idLeilao, idEmpresa],
  );
  return rows.length > 0;
}

/**
 * Reconciliação periódica (RF-022).
 *
 * Webhook se perde: o provedor tenta, a rede falha, a mensagem some. Sem
 * isto, uma caução paga ficaria `pendente` para sempre e o comprador não
 * conseguiria lançar — e ninguém saberia por quê.
 */
export async function reconciliar({ provedor }) {
  const { rows } = await pool.query(
    `SELECT id, id_cobranca_externa FROM caucao
      WHERE status = 'pendente' AND id_cobranca_externa IS NOT NULL
      ORDER BY criado_em LIMIT 50`,
  );

  const r = { conferidas: 0, corrigidas: 0, indisponivel: 0 };
  for (const c of rows) {
    r.conferidas++;
    let estado;
    try {
      ({ estado } = await provedor.consultar(c.id_cobranca_externa));
    } catch (e) {
      if (e instanceof ProvedorIndisponivel) { r.indisponivel++; continue; }
      throw e;
    }

    const alvo = estado === 'aprovada' ? 'confirmada'
      : estado === 'recusada' ? 'recusada' : null;
    if (!alvo) continue;

    const { rowCount } = await pool.query(
      `UPDATE caucao SET status = $1, atualizado_em = now()
        WHERE id = $2 AND status = 'pendente'`,
      [alvo, c.id],
    );
    if (rowCount) r.corrigidas++;
  }
  return r;
}

export { TRANSICOES, ehTerminal };
