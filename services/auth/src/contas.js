import bcrypt from 'bcryptjs';
import { AUDIENCIA_SESSAO, assinar, verificar } from '@naregua/shared';
import { emTransacao, pool } from './db.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';
const EXPIRA_EM = '12h';

/**
 * Doze horas, e não uma.
 *
 * O cliente marca o corte de manhã e volta à tela de tarde para conferir
 * o horário. Token de uma hora o derrubaria no meio do dia, e a tela não
 * tem renovação silenciosa. A troca é consciente: sessão mais longa em um
 * sistema onde o dano de uma sessão roubada é um agendamento indevido,
 * não uma transferência de dinheiro.
 */

export class ErroDeRegra extends Error {
  constructor(codigo, mensagem, status = 400) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

const normalizar = (email) => String(email ?? '').trim().toLowerCase();

/**
 * Cria a conta e grava `conta_criada` na outbox — **na mesma transação**.
 *
 * Gravar a conta e publicar o evento são duas operações que podem falhar
 * entre si: se o processo cair no meio, a conta existe e ninguém fica
 * sabendo. Na mesma transação, ou os dois existem ou nenhum.
 *
 * A outbox garante **ao menos uma** publicação, nunca exatamente uma — o
 * consumidor precisa ser idempotente pelo id do evento.
 */
export async function cadastrar({ nome, email, senha, whatsapp = null }) {
  if (String(senha ?? '').length < 8) {
    throw new ErroDeRegra('senha_curta', 'A senha precisa de pelo menos 8 caracteres');
  }

  // O custo 10 é deliberado: a 12 o cadastro passa de 300 ms no t3.micro
  // do Learner Lab, e o ganho não compensa num sistema sem dado financeiro.
  const senhaHash = await bcrypt.hash(senha, 10);

  return emTransacao(async (cx) => {
    let conta;
    try {
      const r = await cx.query(
        `INSERT INTO conta (nome, email, senha_hash, whatsapp)
         VALUES ($1, $2, $3, $4)
         RETURNING id, nome, email, whatsapp, criado_em`,
        [nome, normalizar(email), senhaHash, whatsapp],
      );
      conta = r.rows[0];
    } catch (e) {
      if (e.code === '23505') {
        throw new ErroDeRegra('email_ja_cadastrado', 'Já existe conta com esse e-mail', 409);
      }
      if (e.code === '23514') {
        throw new ErroDeRegra('email_invalido', 'E-mail inválido');
      }
      throw e;
    }

    // Sem credencial no payload: o evento atravessa SNS e SQS, e tudo o
    // que entra nele passa a existir fora do banco do AUTH.
    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('conta', $1, 'conta_criada', $2)`,
      [conta.id, JSON.stringify({
        id_conta: conta.id,
        nome: conta.nome,
        email: conta.email,
        criado_em: conta.criado_em,
      })],
    );

    return conta;
  });
}

/** Autentica e emite o token de sessão. */
export async function autenticar({ email, senha }) {
  const { rows } = await pool.query(
    `SELECT c.id, c.nome, c.email, c.senha_hash, b.motivo AS motivo_bloqueio
       FROM conta c
       LEFT JOIN bloqueio_conta b ON b.id_conta = c.id
      WHERE c.email = $1`,
    [normalizar(email)],
  );
  const conta = rows[0];

  // Compara o hash mesmo quando o e-mail não existe, para o tempo de
  // resposta não revelar quais e-mails estão cadastrados.
  const hashAlvo = conta?.senha_hash
    ?? '$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinv';
  const confere = await bcrypt.compare(String(senha ?? ''), hashAlvo);

  if (!conta || !confere) {
    throw new ErroDeRegra('credenciais_invalidas', 'E-mail ou senha incorretos', 401);
  }

  // Conta bloqueada não entra. O motivo é privado: dizer "bloqueado por
  // não comparecimento" na tela de login entregaria à pessoa errada o
  // registro interno da plataforma.
  if (conta.motivo_bloqueio) {
    throw new ErroDeRegra('conta_bloqueada', 'Esta conta está bloqueada', 403);
  }

  const token = assinar({ sub: conta.id, nome: conta.nome }, SEGREDO, {
    audiencia: AUDIENCIA_SESSAO,
    expiraEm: EXPIRA_EM,
  });

  return {
    token,
    expiraEm: EXPIRA_EM,
    conta: { id: conta.id, nome: conta.nome, email: conta.email },
  };
}

/** Verifica o token; devolve o conteúdo ou lança 401. */
export function verificarToken(token) {
  try {
    return verificar(token, SEGREDO, AUDIENCIA_SESSAO);
  } catch {
    throw new ErroDeRegra('token_invalido', 'Token ausente, inválido ou expirado', 401);
  }
}

/** Dados públicos da conta, para os outros serviços e para a tela. */
export async function consultar(idConta) {
  const { rows } = await pool.query(
    'SELECT id, nome, email, whatsapp, criado_em FROM conta WHERE id = $1',
    [idConta],
  );
  return rows[0] ?? null;
}
