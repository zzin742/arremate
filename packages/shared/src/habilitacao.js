/**
 * Contrato do token de habilitação, entre o HAB e o LEI.
 *
 * O HAB emite; o LEI confere. Nenhum dos dois chama o outro: a prova
 * viaja com o pedido, assinada, e vale pela assinatura. É o que a
 * arquitetura (§3) exige com todas as letras — **no caminho do lance
 * não há chamada de rede ao HAB** —, porque consulta remota dentro do
 * registro de lance estouraria os 300 ms do RNF-001 e acoplaria a
 * disponibilidade do leilão à do serviço de habilitação.
 *
 * O preço está declarado no RF-004: uma empresa descredenciada durante
 * a validade participa até o token expirar. Por isso a janela é curta,
 * e por isso o encerramento reverifica o vencedor no HAB — ali a
 * chamada de rede cabe.
 *
 * Mora aqui, e não copiado nos dois serviços, porque é um contrato: se
 * o formato mudar de um lado e não do outro, nenhum teste de serviço
 * isolado acusaria.
 */

import {
  AUDIENCIA_HABILITACAO, VALIDADE_HABILITACAO, assinar, verificar,
} from './tokens.js';

export { VALIDADE_HABILITACAO };

/** Emite a prova de que a empresa está habilitada. Só o HAB usa. */
export function assinarTokenHabilitacao(idEmpresa, segredo) {
  return assinar({ sub: idEmpresa, hab: 'aprovada' }, segredo, {
    audiencia: AUDIENCIA_HABILITACAO,
    expiraEm: VALIDADE_HABILITACAO,
  });
}

/**
 * Confere a prova. Só por assinatura, sem rede e sem banco.
 *
 * Devolve objeto em vez de lançar: quem chama decide o status HTTP, e
 * para o LEI token ausente, vencido e de audiência errada são a mesma
 * resposta.
 *
 * A conferência de `hab` fica além da audiência porque são coisas
 * diferentes: a audiência diz que o token é de habilitação, o campo
 * diz que o veredito foi favorável.
 */
export function verificarTokenHabilitacao(token, segredo) {
  try {
    const conteudo = verificar(token, segredo, AUDIENCIA_HABILITACAO);
    return { valido: conteudo.hab === 'aprovada', idEmpresa: conteudo.sub ?? null };
  } catch {
    return { valido: false, idEmpresa: null };
  }
}
