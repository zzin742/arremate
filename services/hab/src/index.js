import express from 'express';
import { z } from 'zod';
import {
  verificarHabilitacao, reprocessarPendentes, emitirToken,
} from './habilitacao.js';
import { criarConsumidor, tirarPrefixo } from '@arremate/shared';

export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar
app.use(tirarPrefixo('hab'));
app.use(express.json());

app.get('/saude', (_req, res) => res.json({ servico: 'hab', ok: true }));

/** Token que o LEI verifica por assinatura, sem chamada de rede (RF-004). */
app.get('/empresas/:id/token', async (req, res, next) => {
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

if (process.env.NODE_ENV !== 'test') {
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
