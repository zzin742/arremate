/**
 * Adaptador do provedor de pagamento.
 *
 * O projeto usa **sandbox**, nunca dinheiro real — está declarado como
 * restrição no documento 01, junto com a ressalva de que operar pagamento
 * de verdade tem exigência regulatória que o trabalho não conclui.
 *
 * A interface existe para que trocar de provedor não vaze para o resto do
 * CAU. A máquina de estados da caução conversa com `cobrar`, `consultar` e
 * `devolver`, e não com Stripe, Mercado Pago ou qualquer outro nome.
 */

export class ProvedorIndisponivel extends Error {
  constructor(motivo) {
    super(`Provedor indisponível: ${motivo}`);
    this.temporario = true;
  }
}

/**
 * Provedor falso, para desenvolvimento e teste.
 *
 * Imita o que importa do comportamento real: identificador próprio,
 * confirmação assíncrona por webhook, e consulta de estado — que é o que
 * a reconciliação do RF-022 usa.
 */
export function criarProvedorSandbox({ aprovarAutomaticamente = false } = {}) {
  const cobrancas = new Map();
  let contador = 0;

  return {
    nome: 'sandbox',

    async cobrar({ valor, referencia }) {
      const id = `sb_${Date.now()}_${++contador}`;
      cobrancas.set(id, {
        id, valor, referencia,
        estado: aprovarAutomaticamente ? 'aprovada' : 'aguardando',
      });
      return { idCobranca: id, estado: cobrancas.get(id).estado };
    },

    async consultar(idCobranca) {
      const c = cobrancas.get(idCobranca);
      if (!c) return { estado: 'inexistente' };
      return { estado: c.estado, valor: c.valor };
    },

    async devolver(idCobranca) {
      const c = cobrancas.get(idCobranca);
      if (!c) throw new Error(`cobrança ${idCobranca} não existe`);
      c.estado = 'devolvida';
      return { estado: 'devolvida' };
    },

    // ── só para teste: simula o que o provedor real faria ──────────
    _aprovar(idCobranca) {
      const c = cobrancas.get(idCobranca);
      if (c) c.estado = 'aprovada';
    },
    _recusar(idCobranca) {
      const c = cobrancas.get(idCobranca);
      if (c) c.estado = 'recusada';
    },
    _derrubar() {
      this.cobrar = async () => { throw new ProvedorIndisponivel('conexão recusada'); };
      this.consultar = async () => { throw new ProvedorIndisponivel('tempo esgotado'); };
    },
  };
}
