import { emTransacao, pool } from './db.js';

export class LanceRecusado extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.codigo = codigo;
    this.recusado = true;
  }
}

/**
 * Registra um lance (RF-014). **O coração do projeto.**
 *
 * O problema: nos segundos finais, vários compradores lançam ao mesmo
 * tempo. Precisamos de ordem total, sem perder lance confirmado e sem
 * aceitar dois lances do mesmo valor.
 *
 * A solução é travar a linha do leilão com `SELECT ... FOR UPDATE`. Quem
 * chega depois **espera na fila** da trava. Dentro dela, tudo é relido e
 * revalidado — nada que tenha sido lido antes de travar vale, porque pode
 * ter mudado enquanto a requisição esperava.
 *
 * A serialização é **por leilão**, não global: leilões diferentes não
 * disputam a mesma trava.
 */
export async function registrarLance({ idLeilao, idEmpresa, valor }) {
  return emTransacao(async (cx) => {
    // ── 1. trava a linha do leilão ───────────────────────────────────
    const { rows: leiloes } = await cx.query(
      `SELECT id, id_empresa, lance_inicial, incremento_min, encerra_em, status
         FROM leilao
        WHERE id = $1
          FOR UPDATE`,
      [idLeilao],
    );
    const leilao = leiloes[0];
    if (!leilao) throw new LanceRecusado('leilao_inexistente', 'Leilão não encontrado');

    // ── 2. revalida TUDO dentro da trava ─────────────────────────────
    if (leilao.status !== 'aberto') {
      throw new LanceRecusado('leilao_nao_esta_aberto', `Leilão está ${leilao.status}`);
    }

    // clock_timestamp(), nunca now(). O now() é transaction_timestamp():
    // congela no início da transação. Como esta requisição pode ter ficado
    // parada na fila da trava, now() daria o relógio de ANTES da espera, e
    // um lance depois do encerramento seria aceito.
    const { rows: [{ expirou }] } = await cx.query(
      'SELECT $1::timestamptz <= clock_timestamp() AS expirou',
      [leilao.encerra_em],
    );
    if (expirou) throw new LanceRecusado('leilao_encerrado', 'O prazo do leilão já venceu');

    if (leilao.id_empresa === idEmpresa) {
      throw new LanceRecusado('vendedor_nao_pode_lancar', 'O vendedor não pode dar lance no próprio leilão');
    }

    // TODO Sprint 6/7 — exigir caução ativa (RF-012). O CAU ainda não
    // existe; quando existir, a verificação entra aqui, dentro da trava.

    // ── 3. qual o lance atual, e qual a próxima sequência ────────────
    // A leitura é segura porque seguramos a trava do leilão: nenhum outro
    // lance deste leilão pode ser inserido agora.
    const { rows: [atual] } = await cx.query(
      `SELECT valor, sequencia
         FROM lance
        WHERE id_leilao = $1
        ORDER BY sequencia DESC
        LIMIT 1`,
      [idLeilao],
    );

    const minimo = atual
      ? Number(atual.valor) + Number(leilao.incremento_min)   // RN05
      : Number(leilao.lance_inicial);                          // RN04

    if (Number(valor) < minimo) {
      throw new LanceRecusado(
        'lance_abaixo_do_minimo',
        `Lance mínimo é ${minimo.toFixed(2)}`,
      );
    }

    // Number() não é decoração: `sequencia` é BIGINT, e o driver devolve
    // BIGINT como string para não perder precisão. Sem a conversão,
    // '1' + 1 vira '11' — concatenação em vez de soma.
    const sequencia = Number(atual?.sequencia ?? 0) + 1;

    // ── 4. grava o lance e o evento, na MESMA transação ──────────────
    const { rows: [lance] } = await cx.query(
      `INSERT INTO lance (id_leilao, id_empresa, valor, sequencia)
       VALUES ($1, $2, $3, $4)
       RETURNING id, id_leilao, id_empresa, valor, sequencia, criado_em`,
      [idLeilao, idEmpresa, valor, sequencia],
    );

    if (atual) {
      // quem foi superado precisa ser avisado (RF-027) — vai por evento,
      // porque notificação nunca pode bloquear o lance (RF-029)
      await cx.query(
        `INSERT INTO outbox (agregado, id_agregado, tipo_evento, payload)
         VALUES ('lance', $1, 'lance_superado', $2)`,
        [lance.id, JSON.stringify({
          id_leilao: idLeilao,
          id_lance: lance.id,
          valor: lance.valor,
          sequencia: lance.sequencia,
        })],
      );
    }

    return lance;
  });
}

/** Abre um leilão (RF-011). */
export async function abrirLeilao({
  idEmpresa, descricaoEquipamento, idEquipamento = null,
  lanceInicial, incrementoMin, encerraEm,
}) {
  if (Number(lanceInicial) <= 0 || Number(incrementoMin) <= 0) {
    throw new LanceRecusado('valores_invalidos', 'Lance inicial e incremento devem ser maiores que zero');
  }
  try {
    // O prazo é conferido pelo relógio do BANCO, no mesmo INSERT.
    //
    // Antes a conferência era `new Date(encerraEm) <= new Date()`, em
    // JavaScript. Quem julga o vencimento do leilão, porém, é o
    // `clock_timestamp()` lá embaixo em registrarLance — dois relógios
    // decidindo a mesma coisa. Com o relógio da aplicação atrasado em
    // relação ao do banco, o leilão nascia **já vencido**: a abertura
    // devolvia 201 e nenhum lance jamais seria aceito. O desvio entre
    // os dois foi medido em 1,7 s no Postgres em contêiner no macOS.
    //
    // Dentro do INSERT, e não numa consulta antes dele, para não abrir
    // janela entre conferir e gravar.
    const { rows: [leilao] } = await pool.query(
      `INSERT INTO leilao (id_empresa, id_equipamento, descricao_equipamento,
                           lance_inicial, incremento_min, encerra_em, status)
       SELECT $1, $2, $3, $4, $5, $6::timestamptz, 'aberto'
        WHERE $6::timestamptz > clock_timestamp()
       RETURNING *`,
      [idEmpresa, idEquipamento, descricaoEquipamento, lanceInicial, incrementoMin, encerraEm],
    );
    if (!leilao) {
      throw new LanceRecusado('prazo_no_passado', 'O encerramento precisa ser no futuro');
    }
    return leilao;
  } catch (e) {
    if (e.code === '23505') {
      throw new LanceRecusado('leilao_ativo_existente', 'Já existe leilão ativo para este equipamento');
    }
    throw e;
  }
}

/** Estado atual do leilão, para acompanhamento (RF-008). */
export async function consultarLeilao(idLeilao) {
  const { rows: [leilao] } = await pool.query('SELECT * FROM leilao WHERE id = $1', [idLeilao]);
  if (!leilao) return null;

  const { rows: lances } = await pool.query(
    `SELECT id, id_empresa, valor, sequencia, criado_em
       FROM lance WHERE id_leilao = $1 ORDER BY sequencia DESC`,
    [idLeilao],
  );
  return { ...leilao, lance_atual: lances[0] ?? null, total_lances: lances.length, lances };
}
