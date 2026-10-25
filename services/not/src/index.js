import express from 'express';
import { registrar, daEvento, listar, marcarLida } from './notificacoes.js';
import { criarConsumidor, tirarPrefixo } from '@arremate/shared';

export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar
app.use(tirarPrefixo('not'));
app.use(express.json());

app.get('/saude', (_req, res) => res.json({ servico: 'not', ok: true }));

app.get('/empresas/:id/notificacoes', async (req, res, next) => {
  try {
    res.json(await listar(req.params.id, { apenasNaoLidas: req.query.naoLidas === '1' }));
  } catch (e) { next(e); }
});

app.post('/notificacoes/:id/lida', async (req, res, next) => {
  try {
    const n = await marcarLida(req.params.id, req.body.idEmpresa);
    if (!n) return res.status(404).json({ codigo: 'notificacao_nao_encontrada' });
    res.json(n);
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  console.error(erro);
  res.status(500).json({ codigo: 'erro_interno' });
});

if (process.env.NODE_ENV !== 'test') {
  const porta = Number(process.env.PORTA ?? 3006);
  app.listen(porta, () => console.log(`not ouvindo em :${porta}`));

  if (process.env.FILA_NOTIFICACAO) {
    criarConsumidor({
      urlFila: process.env.FILA_NOTIFICACAO,
      tratar: async ({ idEvento, corpo, atributos }) => {
        const tipo = atributos.tipo_evento?.Value ?? atributos.tipo_evento?.StringValue;
        const aviso = daEvento({ idEvento, tipo, corpo });
        // evento que não vira aviso é apagado da fila do mesmo jeito:
        // deixá-lo voltando para sempre encheria a DLQ sem motivo
        if (aviso) await registrar(aviso);
      },
    }).iniciar();
    console.log('consumindo notificacao-enviar');
  }
}
