import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { consultarCnpj, ApiExternaIndisponivel } from './brasilapi.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';

/**
 * Validade do token de habilitação.
 *
 * A janela é declarada de propósito no documento 02 (RF-004): uma empresa
 * descredenciada durante a validade participa até o token expirar. Encurtar
 * demais obrigaria o LEI a consultar o HAB com frequência, o que colocaria
 * chamada de rede no caminho do lance.
 */
const VALIDADE = '15m';

/**
 * Processa o evento `conta_criada`: consulta o CNPJ e registra a habilitação.
 *
 * **Idempotente por id de evento.** A entrega é ao menos uma vez (ADR-007),
 * então o mesmo evento pode chegar duas vezes — e processar duas vezes não
 * pode mudar o resultado.
 */
export async function verificarHabilitacao({ idEvento, idEmpresa, cnpj }, deps = {}) {
  const jaFeito = await pool.query(
    'SELECT id, situacao FROM habilitacao WHERE id_evento_origem = $1',
    [idEvento],
  );
  if (jaFeito.rows[0]) return { ...jaFeito.rows[0], repetido: true };

  let situacao;
  let detalhe;
  try {
    const r = await consultarCnpj(cnpj, deps);
    situacao = r.situacao === 'ativa' ? 'aprovada' : 'recusada';
    detalhe = r.descricao;
  } catch (e) {
    if (!(e instanceof ApiExternaIndisponivel)) throw e;
    // RF-005: a API fora não rejeita o cadastro. Fica pendente e um
    // varredor tenta de novo depois, sem o usuário fazer nada.
    situacao = 'pendente';
    detalhe = e.message;
  }

  const { rows: [hab] } = await pool.query(
    `INSERT INTO habilitacao (id_empresa, cnpj, situacao, detalhe, id_evento_origem)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (id_evento_origem) DO UPDATE SET situacao = EXCLUDED.situacao
     RETURNING id, id_empresa, situacao, detalhe`,
    [idEmpresa, cnpj, situacao, detalhe, idEvento],
  );
  return { ...hab, repetido: false };
}

/** Reprocessa as que ficaram pendentes por indisponibilidade (RF-005). */
export async function reprocessarPendentes(deps = {}) {
  const { rows } = await pool.query(
    `SELECT id, id_empresa, cnpj FROM habilitacao
      WHERE situacao = 'pendente' ORDER BY criado_em LIMIT 50`,
  );

  const resultado = { resolvidas: 0, aindaPendentes: 0 };
  for (const h of rows) {
    try {
      const r = await consultarCnpj(h.cnpj, deps);
      await pool.query(
        'UPDATE habilitacao SET situacao = $1, detalhe = $2, atualizado_em = now() WHERE id = $3',
        [r.situacao === 'ativa' ? 'aprovada' : 'recusada', r.descricao, h.id],
      );
      resultado.resolvidas++;
    } catch (e) {
      if (!(e instanceof ApiExternaIndisponivel)) throw e;
      resultado.aindaPendentes++;
    }
  }
  return resultado;
}

/**
 * Emite o token de habilitação.
 *
 * **O LEI verifica este token por assinatura, sem chamada de rede** (MER §7,
 * C4 §4.1). Colocar uma chamada ao HAB no caminho do lance mataria a meta
 * de latência do RNF-001.
 */
export async function emitirToken(idEmpresa) {
  const { rows: [hab] } = await pool.query(
    `SELECT situacao FROM habilitacao
      WHERE id_empresa = $1 ORDER BY criado_em DESC LIMIT 1`,
    [idEmpresa],
  );

  if (!hab) return { emitido: false, motivo: 'sem_habilitacao' };
  if (hab.situacao !== 'aprovada') return { emitido: false, motivo: hab.situacao };

  return {
    emitido: true,
    token: jwt.sign({ sub: idEmpresa, hab: 'aprovada' }, SEGREDO, { expiresIn: VALIDADE }),
    validade: VALIDADE,
  };
}

/** Verificação local, usada pelo LEI. Nenhuma chamada de rede. */
export function verificarTokenHabilitacao(token) {
  try {
    const c = jwt.verify(token, SEGREDO);
    return { valido: c.hab === 'aprovada', idEmpresa: c.sub };
  } catch {
    return { valido: false, idEmpresa: null };
  }
}
