import { pool } from './db.js';

/**
 * Registra a notificação (RF-027, RF-028).
 *
 * **Idempotente pelo id do evento.** A entrega é ao menos uma vez
 * (ADR-007): sem o UNIQUE em `id_evento_origem`, a mesma pessoa seria
 * avisada duas vezes do mesmo lance superado.
 *
 * O canal é o painel do usuário, não e-mail. O envio por e-mail depende
 * de provedor externo e ficou no escopo adicional do planejamento; o que
 * o RF-027 exige — que o participante **seja avisado** em até 1 minuto —
 * o painel atende, e sem depender de terceiro no dia da defesa.
 */
export async function registrar({ idEvento, idEmpresa, tipo, titulo, corpo }) {
  const { rows: [n] } = await pool.query(
    `INSERT INTO notificacao (id_empresa, tipo, titulo, corpo, id_evento_origem)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id_evento_origem) DO NOTHING
     RETURNING *`,
    [idEmpresa, tipo, titulo, corpo, idEvento],
  );

  if (!n) {
    const { rows: [ja] } = await pool.query(
      'SELECT * FROM notificacao WHERE id_evento_origem = $1', [idEvento],
    );
    return { ...ja, repetida: true };
  }
  return { ...n, repetida: false };
}

/** Monta a notificação a partir do evento de domínio. */
export function daEvento({ idEvento, tipo, corpo }) {
  const dinheiro = (v) =>
    Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

  switch (tipo) {
    case 'lance_superado':
      return {
        idEvento, idEmpresa: corpo.id_empresa_superada, tipo,
        titulo: 'Seu lance foi superado',
        corpo: `Alguém ofereceu ${dinheiro(corpo.valor)}. Dê um novo lance para voltar à frente.`,
      };
    case 'leilao_encerrado':
      return {
        idEvento, idEmpresa: corpo.id_empresa, tipo,
        titulo: corpo.venceu ? 'Você arrematou!' : 'Leilão encerrado',
        corpo: corpo.venceu
          ? `Arremate confirmado por ${dinheiro(corpo.valor)}.`
          : 'O leilão que você acompanhava foi encerrado.',
      };
    default:
      return null;   // evento que não vira aviso
  }
}

export async function listar(idEmpresa, { apenasNaoLidas = false } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM notificacao
      WHERE id_empresa = $1 ${apenasNaoLidas ? 'AND lida_em IS NULL' : ''}
      ORDER BY criado_em DESC LIMIT 50`,
    [idEmpresa],
  );
  return rows;
}

export async function marcarLida(id, idEmpresa) {
  const { rows: [n] } = await pool.query(
    `UPDATE notificacao SET lida_em = now()
      WHERE id = $1 AND id_empresa = $2 AND lida_em IS NULL RETURNING *`,
    [id, idEmpresa],
  );
  return n ?? null;
}
