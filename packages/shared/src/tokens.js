/**
 * Tokens do sistema: dois tipos, um segredo, e o que os separa.
 *
 * O AUTH emite o token de **sessão** (quem é você). O HAB emite o de
 * **habilitação** (você está apto a participar). Os dois são JWT
 * assinados com o mesmo segredo, e os dois carregam `sub` com o id da
 * empresa.
 *
 * Isso os tornava intercambiáveis, e a consequência foi comprovada:
 * `jwt.sign({ sub: vitima, hab: 'aprovada' })` passava direto no
 * `exigirSessao` do LEI, e o leilão era aberto em nome da vítima —
 * HTTP 201. Como a rota que emite o token de habilitação não pedia
 * autenticação, bastava saber o UUID da empresa.
 *
 * O que separa os dois agora é o `aud`, campo padrão do JWT para
 * exatamente isto: dizer **para quem** o token serve. Cada verificador
 * exige a sua audiência, e o `jsonwebtoken` recusa o que não bate.
 *
 * Por que `aud` e não dois segredos: dois segredos protegem mais (o
 * vazamento de um não vale pelo outro), mas obrigam a distribuir e
 * girar duas chaves em todos os serviços. O `aud` resolve a confusão
 * de propósito, que era a falha. A separação de chaves fica anotada
 * como melhoria, não como feito.
 */

import jwt from 'jsonwebtoken';

export const AUDIENCIA_SESSAO = 'arremate:sessao';
export const AUDIENCIA_HABILITACAO = 'arremate:habilitacao';

/** Validade do token de habilitação. Curta: veja `habilitacao.js`. */
export const VALIDADE_HABILITACAO = '15m';

export function assinar(conteudo, segredo, { audiencia, expiraEm }) {
  return jwt.sign(conteudo, segredo, { audience: audiencia, expiresIn: expiraEm });
}

/**
 * Confere assinatura **e** audiência.
 *
 * Lança, como o `jwt.verify` lançaria: quem chama já tem um `catch`
 * para token vencido, e token com audiência errada é a mesma classe de
 * problema — esta credencial não serve aqui.
 */
export function verificar(token, segredo, audiencia) {
  return jwt.verify(token, segredo, { audience: audiencia });
}
