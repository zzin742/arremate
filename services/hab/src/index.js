import express from 'express';
import { z } from 'zod';
import {
  verificarHabilitacao, reprocessarPendentes, emitirToken,
} from './habilitacao.js';
import {
  AUDIENCIA_SESSAO, criarConsumidor, criarMetricas, tirarPrefixo, verificar,
} from '@arremate/shared';

export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar
app.use(tirarPrefixo('hab'));

const metricas = criarMetricas();
app.use(metricas.middleware);
app.get('/metricas', metricas.handler);
app.use(express.json());

app.get('/saude', (_req, res) => res.json({ servico: 'hab', ok: true }));

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';

/**
 * Só a própria empresa pede o seu token.
 *
 * A rota entregava a credencial a quem soubesse o UUID da empresa, sem
 * pedir nada. Com ela, abrir leilão em nome de terceiro era um `curl` —
 * verificado, HTTP 201. Duas coisas consertam isso, e as duas são
 * necessárias: o `aud` no token (um de habilitação não vale como
 * sessão) e a autenticação aqui.
 */
function exigirDonoDaSessao(req, res, next) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');

  try {
    const sessao = verificar(token, SEGREDO, AUDIENCIA_SESSAO);

    // 404, e não 403: para quem não é dono, esta empresa não existe.
    // Um 403 confirmaria que o UUID é de uma empresa de verdade.
    if (sessao.sub !== req.params.id) {
      return res.status(404).json({ codigo: 'empresa_nao_encontrada' });
    }

    return next();
  } catch {
    return res.status(401).json({ codigo: 'nao_autenticado' });
  }
}

/** Token que o LEI verifica por assinatura, sem chamada de rede (RF-004). */
app.get('/empresas/:id/token', exigirDonoDaSessao, async (req, res, next) => {
  try {
    const r = await emitirToken(req.params.id);
    if (!r.emitido) return res.status(409).json({ codigo: r.motivo });
    res.json(r);
  } catch (e) { next(e); }
});

/** Reprocessa as que ficaram pendentes por indisponibilidade (RF-005). */
app.post('/reprocessar', async (_req, res, next) => {
  try {
    res.json(await reprocessarPendentes());
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }
  console.error(erro);
  res.status(500).json({ codigo: 'erro_interno' });
});

// Não sobe servidor quando o arquivo é importado por um teste.
//
// `NODE_TEST_CONTEXT` é posto pelo próprio runner do Node e não depende
// de ninguém lembrar de exportar `NODE_ENV=test`. Esquecer isso não dava
// erro: o `app.listen` subia, o servidor escutando segurava o processo
// vivo, e a medição de cobertura ficava parada em `kevent` até o limite
// — sem erro, sem log, idêntica a "ainda trabalhando".
if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
  const porta = Number(process.env.PORTA ?? 3003);
  app.listen(porta, () => console.log(`hab ouvindo em :${porta}`));

  // Consome `conta-criada` e verifica o CNPJ. Só liga quando há fila
  // configurada: no CI a imagem sobe sem AWS, e o /saude tem de
  // responder mesmo assim.
  if (process.env.FILA_HABILITACAO) {
    criarConsumidor({
      urlFila: process.env.FILA_HABILITACAO,
      tratar: async ({ idEvento, corpo }) => {
        await verificarHabilitacao({
          idEvento, idEmpresa: corpo.id_empresa, cnpj: corpo.cnpj,
        });
      },
    }).iniciar();
    console.log('consumindo habilitacao-verificar');
  }

  // varredor do RF-005
  setInterval(() => {
    reprocessarPendentes().catch((e) => console.error('reprocessar:', e.message));
  }, 60_000).unref();
}
