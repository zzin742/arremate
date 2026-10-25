/**
 * Sobe o app de um serviço numa porta livre, para os testes da camada HTTP.
 *
 * Fica fora dos workspaces de propósito: não é código do produto, não
 * entra nas imagens (o Dockerfile copia só `services/<x>/src` e
 * `packages/shared`) e não entra no denominador da cobertura, cuja
 * varredura olha `services/*​/src` e `packages/*​/src`.
 *
 * Porta zero, e não uma fixa por serviço: os arquivos de teste rodam em
 * paralelo e porta fixa faz um derrubar o outro com `EADDRINUSE` — falha
 * que aparece no arquivo errado e parece outra coisa.
 */
export async function subir(app) {
  const servidor = app.listen(0);
  await new Promise((ok, erro) => {
    servidor.once('listening', ok);
    servidor.once('error', erro);
  });
  const base = `http://127.0.0.1:${servidor.address().port}`;

  /** Faz a requisição e devolve status, corpo em JSON e cabeçalhos. */
  async function pedir(metodo, caminho, { corpo, token, cabecalhos = {} } = {}) {
    const r = await fetch(base + caminho, {
      method: metodo,
      headers: {
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...cabecalhos,
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
    });
    const texto = await r.text();
    let json;
    try { json = JSON.parse(texto); } catch { json = undefined; }
    return { status: r.status, json, texto, cabecalhos: r.headers };
  }

  return {
    base,
    get: (c, o) => pedir('GET', c, o),
    post: (c, o) => pedir('POST', c, o),
    put: (c, o) => pedir('PUT', c, o),
    delete: (c, o) => pedir('DELETE', c, o),
    options: (c, o) => pedir('OPTIONS', c, o),
    fechar: () => new Promise((ok) => servidor.close(ok)),
  };
}
