import { pool } from './db.js';

export class ErroDeVisita extends Error {
  constructor(codigo, mensagem, status = 409) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

/**
 * Agenda visita técnica (RF-024, RF-025).
 *
 * A regra de não sobrepor **não está aqui**. Ela é uma constraint do
 * PostgreSQL:
 *
 *   EXCLUDE USING gist (id_equipamento WITH =, periodo WITH &&)
 *   WHERE (status = 'agendada')
 *
 * O papel desta função é traduzir a recusa do banco em erro de negócio.
 * Fazer a verificação em código — consultar antes e inserir depois —
 * teria uma janela entre as duas operações onde duas visitas passariam.
 * O banco não tem essa janela.
 */
export async function agendar({ idEquipamento, idEmpresa, inicio, fim }) {
  if (new Date(fim) <= new Date(inicio)) {
    throw new ErroDeVisita('periodo_invalido', 'O fim precisa ser depois do início', 400);
  }
  if (new Date(inicio) <= new Date()) {
    throw new ErroDeVisita('periodo_no_passado', 'Não dá para agendar visita no passado', 400);
  }

  try {
    const { rows: [visita] } = await pool.query(
      `INSERT INTO visita (id_equipamento, id_empresa, periodo)
       VALUES ($1, $2, tstzrange($3, $4))
       RETURNING id, id_equipamento, id_empresa,
                 lower(periodo) AS inicio, upper(periodo) AS fim, status`,
      [idEquipamento, idEmpresa, inicio, fim],
    );
    return visita;
  } catch (e) {
    if (e.code === '23P01') {             // exclusion_violation
      throw new ErroDeVisita(
        'horario_ocupado',
        'Já existe visita agendada para este equipamento nesse período',
      );
    }
    throw e;
  }
}

/** Cancelar libera o horário — é o que o WHERE da constraint permite. */
export async function cancelar(idVisita, idEmpresa) {
  const { rows: [visita] } = await pool.query(
    `UPDATE visita SET status = 'cancelada'
      WHERE id = $1 AND id_empresa = $2 AND status = 'agendada'
      RETURNING id, status`,
    [idVisita, idEmpresa],
  );
  if (!visita) {
    throw new ErroDeVisita('visita_nao_cancelavel',
      'Visita inexistente, de outra empresa ou já encerrada', 404);
  }
  return visita;
}

/** Horários já ocupados, para a interface sugerir outro. */
export async function agendaDoEquipamento(idEquipamento) {
  const { rows } = await pool.query(
    `SELECT id, lower(periodo) AS inicio, upper(periodo) AS fim
       FROM visita
      WHERE id_equipamento = $1 AND status = 'agendada'
        AND upper(periodo) > now()
      ORDER BY lower(periodo)`,
    [idEquipamento],
  );
  return rows;
}
