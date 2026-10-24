import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { emTransacao, pool } from './db.js';
import { cnpjValido, soDigitos } from './cnpj.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';
const EXPIRA_EM = '1h';   // RNF-011

export class ErroDeRegra extends Error {
  constructor(codigo, mensagem, status = 400) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

/**
 * Cadastra a empresa e grava `conta_criada` na outbox — **na mesma
 * transação** (RF-001).
 *
 * Esse é o ponto da tarefa. Gravar a empresa e publicar o evento são duas
 * operações que podem falhar entre si: se o processo cair no meio, a conta
 * existe e o HAB nunca fica sabendo que precisa verificar o CNPJ. Gravando
 * o evento na mesma transação, ou os dois existem ou nenhum.
 *
 * A outbox garante **ao menos uma publicação**, nunca exatamente uma — o
 * consumidor precisa ser idempotente, deduplicando pelo id do evento
 * (RNF-007b).
 */
export async function cadastrar({ cnpj, razaoSocial, email, senha }) {
  const cnpjLimpo = soDigitos(cnpj);
  if (!cnpjValido(cnpjLimpo)) {
    throw new ErroDeRegra('cnpj_invalido', 'CNPJ com dígito verificador inválido');
  }

  const senhaHash = await bcrypt.hash(senha, 10);

  return emTransacao(async (cx) => {
    let empresa;
    try {
      const r = await cx.query(
        `INSERT INTO empresa (cnpj, razao_social, email, senha_hash)
         VALUES ($1, $2, $3, $4)
         RETURNING id, cnpj, razao_social, email, criado_em`,
        [cnpjLimpo, razaoSocial, email.toLowerCase(), senhaHash],
      );
      empresa = r.rows[0];
    } catch (e) {
      if (e.code === '23505') {                           // unique_violation
        const campo = e.constraint?.includes('email') ? 'email' : 'cnpj';
        throw new ErroDeRegra(`${campo}_ja_cadastrado`, `Já existe empresa com esse ${campo}`, 409);
      }
      throw e;
    }

    // mesma transação: ou a empresa e o evento existem, ou nenhum dos dois
    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('empresa', $1, 'conta_criada', $2)`,
      [empresa.id, JSON.stringify({
        id_empresa: empresa.id,
        cnpj: empresa.cnpj,          // sem credencial no payload (DFD, fluxo 1.0 → 2.0)
        criado_em: empresa.criado_em,
      })],
    );

    return empresa;
  });
}

/** Autentica e emite o token de sessão (RF-002). */
export async function autenticar({ email, senha }) {
  const { rows } = await pool.query(
    'SELECT id, cnpj, email, senha_hash FROM empresa WHERE email = $1',
    [String(email ?? '').toLowerCase()],
  );
  const empresa = rows[0];

  // compara o hash mesmo quando o e-mail não existe, para o tempo de
  // resposta não revelar quais e-mails estão cadastrados
  const hashAlvo = empresa?.senha_hash ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const confere = await bcrypt.compare(senha, hashAlvo);

  if (!empresa || !confere) {
    throw new ErroDeRegra('credenciais_invalidas', 'E-mail ou senha incorretos', 401);
  }

  const token = jwt.sign(
    { sub: empresa.id, cnpj: empresa.cnpj },
    SEGREDO,
    { expiresIn: EXPIRA_EM },
  );
  return { token, expiraEm: EXPIRA_EM, empresa: { id: empresa.id, email: empresa.email } };
}

/** Verifica o token; devolve o conteúdo ou lança 401 (RF-002). */
export function verificarToken(token) {
  try {
    return jwt.verify(token, SEGREDO);
  } catch {
    throw new ErroDeRegra('token_invalido', 'Token ausente, inválido ou expirado', 401);
  }
}
