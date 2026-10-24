/**
 * Consulta de CNPJ na BrasilAPI (RF-003).
 *
 * Esta é a **integração com API externa** exigida pelo termo. Três coisas
 * que o código precisa tratar, e que a documentação do projeto já previa:
 *
 * - **A API pode estar fora.** Nesse caso a habilitação fica `pendente` e
 *   é reprocessada depois, sem ação do usuário (RF-005). Cadastro não é
 *   rejeitado por indisponibilidade de terceiro.
 * - **CNPJ inexistente não é erro de sistema.** Resulta em habilitação
 *   `recusada`, que é um estado de negócio válido.
 * - **Situação cadastral não prova identidade.** Ela diz que a empresa
 *   existe e está ativa na Receita — não que quem cadastrou é dela. Isso
 *   está declarado como limitação no documento 01.
 */

const BASE = process.env.BRASILAPI ?? 'https://brasilapi.com.br/api/cnpj/v1';
const TEMPO_LIMITE_MS = Number(process.env.BRASILAPI_TIMEOUT_MS ?? 5000);

export class ApiExternaIndisponivel extends Error {
  constructor(motivo) {
    super(`BrasilAPI indisponível: ${motivo}`);
    this.temporario = true;
  }
}

/**
 * @returns {{situacao: 'ativa'|'inativa', razaoSocial: string, descricao: string}}
 * @throws {ApiExternaIndisponivel} quando a falha é temporária e vale repetir
 */
export async function consultarCnpj(cnpj, { fetchImpl = fetch } = {}) {
  const limite = AbortSignal.timeout(TEMPO_LIMITE_MS);
  let r;

  try {
    r = await fetchImpl(`${BASE}/${cnpj}`, { signal: limite });
  } catch (e) {
    // rede caiu, DNS falhou ou estourou o tempo: vale repetir
    throw new ApiExternaIndisponivel(e.name === 'TimeoutError' ? 'tempo esgotado' : e.message);
  }

  if (r.status === 404) {
    return { situacao: 'inativa', razaoSocial: null, descricao: 'CNPJ não encontrado na Receita' };
  }
  if (r.status === 429) {
    throw new ApiExternaIndisponivel('limite de requisições atingido');
  }
  if (r.status >= 500) {
    throw new ApiExternaIndisponivel(`HTTP ${r.status}`);
  }
  if (!r.ok) {
    // 4xx que não é 404 nem 429 é problema do nosso pedido; repetir não resolve
    return { situacao: 'inativa', razaoSocial: null, descricao: `Consulta recusada (HTTP ${r.status})` };
  }

  const d = await r.json();
  const descricao = d.descricao_situacao_cadastral ?? '';
  return {
    situacao: descricao.toUpperCase() === 'ATIVA' ? 'ativa' : 'inativa',
    razaoSocial: d.razao_social ?? null,
    descricao: descricao || 'sem descrição',
  };
}
