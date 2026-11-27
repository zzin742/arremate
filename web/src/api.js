// `import.meta.env` é coisa do Vite: fora dele a propriedade não
// existe, e o acesso direto quebra na importação. O `?.` deixa este
// módulo ser importado por um teste em Node puro, sem empacotador.
const AUTH = import.meta.env?.VITE_AUTH ?? 'http://localhost:3001';
const LEI = import.meta.env?.VITE_LEI ?? 'http://localhost:3002';
const HAB = import.meta.env?.VITE_HAB ?? 'http://localhost:3003';

/** Guarda o token da sessão. Em produção isso vira cookie httpOnly. */
export const sessao = {
  get token() { return localStorage.getItem('arremate_token'); },
  set token(v) {
    if (v) localStorage.setItem('arremate_token', v);
    else localStorage.removeItem('arremate_token');
  },
};

/**
 * Token de habilitação: a outra credencial.
 *
 * Sessão responde "quem é você"; habilitação responde "você está apto a
 * operar" — CNPJ ativo, verificado pelo HAB contra a BrasilAPI. O LEI
 * exige as duas e as confere separadamente (RF-004, RF-012), e é por
 * isso que viajam em cabeçalhos diferentes.
 *
 * Dura 15 minutos. Guardar junto com o instante de emissão evita mandar
 * token vencido e levar 403 — o LEI trataria vencido como ausente, e a
 * tela diria "sem habilitação" para quem acabou de entrar.
 */
const habilitacao = {
  get valor() {
    try {
      const bruto = localStorage.getItem('arremate_habilitacao');
      if (!bruto) return null;
      const { token, em } = JSON.parse(bruto);
      // margem de 60 s: token que vence no caminho não serve
      if (Date.now() - em > (15 * 60 - 60) * 1000) return null;
      return token;
    } catch { return null; }
  },
  set valor(token) {
    try {
      if (token) {
        localStorage.setItem('arremate_habilitacao', JSON.stringify({ token, em: Date.now() }));
      } else {
        localStorage.removeItem('arremate_habilitacao');
      }
    } catch { /* navegador sem storage: segue sem cache */ }
  },
};

/** Id da empresa, que vem dentro do token de sessão. */
function empresaDaSessao() {
  try {
    const [, carga] = sessao.token.split('.');
    return JSON.parse(window.atob(carga.replace(/-/g, '+').replace(/_/g, '/'))).sub;
  } catch { return null; }
}

/**
 * Pede a habilitação ao HAB, reaproveitando a que ainda vale.
 *
 * Devolve `null` quando a empresa não está apta: o HAB responde 409 com
 * o motivo, e quem chamou decide o que mostrar. Lançar aqui faria a tela
 * tratar "CNPJ ainda em verificação" como falha de rede.
 */
export async function obterHabilitacao() {
  if (habilitacao.valor) return habilitacao.valor;

  const id = empresaDaSessao();
  if (!id) return null;

  try {
    const r = await pedir(`${HAB}/empresas/${id}/token`, { autenticado: true });
    habilitacao.valor = r.token;
    return r.token;
  } catch {
    return null;
  }
}

/** Esquece as duas credenciais. Chamado ao sair. */
export function limparCredenciais() {
  sessao.token = null;
  habilitacao.valor = null;
}

async function pedir(url, { metodo = 'GET', corpo, autenticado = false, habilitado = null } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(autenticado ? { Authorization: `Bearer ${sessao.token}` } : {}),
      ...(habilitado ? { 'X-Habilitacao': habilitado } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });

  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    // o erro do servidor vem com código próprio; preservar isso é o que
    // deixa a tela dizer "lance abaixo do mínimo" em vez de "erro 409"
    const e = new Error(dados.mensagem ?? 'Falha na requisição');
    e.codigo = dados.codigo;
    e.status = r.status;
    throw e;
  }
  return dados;
}

export const entrar = (email, senha) =>
  pedir(`${AUTH}/sessoes`, { metodo: 'POST', corpo: { email, senha } });

export const cadastrar = (dados) =>
  pedir(`${AUTH}/empresas`, { metodo: 'POST', corpo: dados });

export const verLeilao = (id) => pedir(`${LEI}/leiloes/${id}`);

export const abrirLeilao = async (dados) =>
  pedir(`${LEI}/leiloes`, {
    metodo: 'POST', corpo: dados, autenticado: true,
    habilitado: await obterHabilitacao(),
  });

export const darLance = async (idLeilao, valor) =>
  pedir(`${LEI}/leiloes/${idLeilao}/lances`, {
    metodo: 'POST', corpo: { valor }, autenticado: true,
    habilitado: await obterHabilitacao(),
  });
