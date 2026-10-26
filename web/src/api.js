// `import.meta.env` é coisa do Vite: fora dele a propriedade não
// existe, e o acesso direto quebra na importação. O `?.` deixa este
// módulo ser importado por um teste em Node puro, sem empacotador.
const AUTH = import.meta.env?.VITE_AUTH ?? 'http://localhost:3001';
const LEI = import.meta.env?.VITE_LEI ?? 'http://localhost:3002';

/** Guarda o token da sessão. Em produção isso vira cookie httpOnly. */
export const sessao = {
  get token() { return localStorage.getItem('arremate_token'); },
  set token(v) {
    if (v) localStorage.setItem('arremate_token', v);
    else localStorage.removeItem('arremate_token');
  },
};

async function pedir(url, { metodo = 'GET', corpo, autenticado = false } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(autenticado ? { Authorization: `Bearer ${sessao.token}` } : {}),
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

export const abrirLeilao = (dados) =>
  pedir(`${LEI}/leiloes`, { metodo: 'POST', corpo: dados, autenticado: true });

export const darLance = (idLeilao, valor) =>
  pedir(`${LEI}/leiloes/${idLeilao}/lances`, {
    metodo: 'POST', corpo: { valor }, autenticado: true,
  });
