/** Ajustes de HTTP comuns aos serviços. */

/**
 * Tira o prefixo `/api/<nome>` que o ALB encaminha sem reescrever.
 *
 * A regra de roteamento do ALB casa `/api/auth/*` e manda para o grupo
 * de destino do AUTH, mas **não remove o prefixo**: o contêiner recebe
 * `/api/auth/saude`, e o Express, que registra `/saude`, responde 404.
 * O ALB não sabe reescrever caminho — quem tem de se entender é o
 * serviço.
 *
 * Tirar o prefixo aqui, e não montar as rotas sob ele, mantém o caminho
 * único dentro do serviço: o teste, o `docker compose` local e a
 * verificação de saúde do grupo de destino continuam falando `/saude`,
 * enquanto o navegador fala `/api/auth/saude` pelo ALB.
 */
export function tirarPrefixo(nome) {
  const prefixo = `/api/${nome}`;
  return (req, _res, next) => {
    const url = req.url;
    if (url === prefixo) {
      req.url = '/';
    } else if (url.startsWith(`${prefixo}/`)) {
      req.url = url.slice(prefixo.length);
    } else if (url.startsWith(`${prefixo}?`)) {
      // `/api/auth?x=1` — raro, mas cairia no 404 sem este caso
      req.url = `/${url.slice(prefixo.length)}`;
    }
    next();
  };
}
