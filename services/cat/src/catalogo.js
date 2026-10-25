import { randomUUID } from 'node:crypto';
import { emTransacao, pool } from './db.js';

export class ErroDeCatalogo extends Error {
  constructor(codigo, mensagem, status = 400) {
    super(mensagem);
    this.codigo = codigo;
    this.status = status;
  }
}

/** Cadastra o equipamento (RF-006). */
export async function cadastrar({
  idEmpresa, nome, categoria, ano, estadoConservacao, localizacao, fichaTecnica = {},
}) {
  const { rows: [eq] } = await pool.query(
    `INSERT INTO equipamento
       (id_empresa, nome, categoria, ano, estado_conservacao, localizacao, ficha_tecnica)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [idEmpresa, nome, categoria, ano, estadoConservacao, localizacao, JSON.stringify(fichaTecnica)],
  );
  return eq;
}

/**
 * Busca combinando filtros (RF-007).
 *
 * Os filtros são montados por lista, não por concatenação de string: é o
 * que garante que todo valor vai como parâmetro e nenhum entra no SQL.
 */
export async function buscar({ categoria, estadoConservacao, localizacao, texto } = {}) {
  const onde = [];
  const valores = [];
  const p = (v) => { valores.push(v); return `$${valores.length}`; };

  if (categoria) onde.push(`categoria = ${p(categoria)}`);
  if (estadoConservacao) onde.push(`estado_conservacao = ${p(estadoConservacao)}`);
  if (localizacao) onde.push(`localizacao ILIKE ${p(`%${localizacao}%`)}`);
  if (texto) onde.push(`nome ILIKE ${p(`%${texto}%`)}`);

  const { rows } = await pool.query(
    `SELECT * FROM equipamento
      ${onde.length ? `WHERE ${onde.join(' AND ')}` : ''}
      ORDER BY criado_em DESC LIMIT 100`,
    valores,
  );
  return rows;
}

export async function porId(id) {
  const { rows: [eq] } = await pool.query('SELECT * FROM equipamento WHERE id = $1', [id]);
  if (!eq) return null;
  const { rows: midias } = await pool.query(
    `SELECT id, tipo, status, chave_processada, criado_em
       FROM midia WHERE id_equipamento = $1 ORDER BY criado_em`,
    [id],
  );
  return { ...eq, midias };
}

const EXTENSAO = { foto: 'jpg', video: 'mp4' };

/**
 * Prepara o upload e devolve a URL pré-assinada (RF-008).
 *
 * **O arquivo não passa pelo contêiner.** O navegador envia direto ao S3
 * com a URL assinada — vídeo de 200 MB atravessando o serviço consumiria
 * memória e tempo de uma tarefa que deveria estar respondendo requisição
 * (ADR-005, decisão 8 do DFD).
 *
 * A mídia nasce `aguardando_upload`. Ela só vira `na_fila` quando o S3
 * avisa que o objeto chegou — porque a URL assinada pode nunca ser usada.
 */
export async function prepararUpload({ idEquipamento, tipo }, { s3 }) {
  if (!EXTENSAO[tipo]) {
    throw new ErroDeCatalogo('tipo_invalido', 'Tipo precisa ser foto ou video');
  }

  const { rows: [eq] } = await pool.query(
    'SELECT id FROM equipamento WHERE id = $1', [idEquipamento],
  );
  if (!eq) throw new ErroDeCatalogo('equipamento_inexistente', 'Equipamento não encontrado', 404);

  const idMidia = randomUUID();
  const chave = `originais/${idEquipamento}/${idMidia}.${EXTENSAO[tipo]}`;

  const { rows: [midia] } = await pool.query(
    `INSERT INTO midia (id, id_equipamento, tipo, chave_original, status)
     VALUES ($1, $2, $3, $4, 'aguardando_upload')
     RETURNING *`,
    [idMidia, idEquipamento, tipo, chave],
  );

  return { midia, url: await s3.urlDeUpload(chave), chave };
}

/**
 * O S3 avisou que o objeto chegou. Marca a mídia e publica o evento que
 * põe o MID para trabalhar.
 *
 * **Idempotente**: a notificação do S3 pode chegar duas vezes, e o evento
 * de conversão não pode ser publicado em duplicata por causa disso.
 */
export async function confirmarUpload({ chave }) {
  return emTransacao(async (cx) => {
    const { rows: [midia] } = await cx.query(
      `UPDATE midia SET status = 'na_fila', atualizado_em = now()
        WHERE chave_original = $1 AND status = 'aguardando_upload'
        RETURNING *`,
      [chave],
    );

    if (!midia) {
      // ou a chave não existe, ou já foi confirmada antes
      const { rows: [ja] } = await cx.query(
        'SELECT * FROM midia WHERE chave_original = $1', [chave],
      );
      if (!ja) throw new ErroDeCatalogo('midia_inexistente', `Sem mídia para ${chave}`, 404);
      return { ...ja, repetido: true };
    }

    // mesma transação: ou a mídia entra na fila e o evento existe, ou nenhum
    await cx.query(
      `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
       VALUES ('midia', $1, 'midia_enviada', $2)`,
      [midia.id, JSON.stringify({
        id_midia: midia.id,
        id_equipamento: midia.id_equipamento,
        tipo: midia.tipo,
        chave_original: midia.chave_original,
      })],
    );

    return { ...midia, repetido: false };
  });
}

/**
 * O MID terminou a conversão e avisou por evento.
 *
 * O MID **não escreve no banco do CAT** (MER §7) — por isso o retorno vem
 * por fila e é tratado aqui.
 */
export async function registrarConversao({ idMidia, chaveProcessada, erro = null }) {
  const { rows: [midia] } = await pool.query(
    `UPDATE midia
        SET status = $2,
            chave_processada = $3,
            erro = $4::varchar,
            -- o cast não é decoração: sem ele o Postgres não consegue
            -- inferir o tipo de $4 dentro do CASE e recusa a consulta
            tentativas = tentativas + CASE WHEN $4::varchar IS NULL THEN 0 ELSE 1 END,
            atualizado_em = now()
      WHERE id = $1
      RETURNING *`,
    [idMidia, erro ? 'erro' : 'pronta', chaveProcessada, erro],
  );
  if (!midia) throw new ErroDeCatalogo('midia_inexistente', 'Mídia não encontrada', 404);
  return midia;
}
