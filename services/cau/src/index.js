import express from 'express';
import { z } from 'zod';
import { solicitar, processarWebhook, temCaucaoAtiva, reconciliar, liquidar, daLiquidacao, ErroDeCaucao } from './caucoes.js';
import { criarProvedorSandbox } from './provedor.js';
import { criarConsumidor, criarMetricas, tirarPrefixo } from '@arremate/shared';

const provedor = criarProvedorSandbox();
export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar
app.use(tirarPrefixo('cau'));

const metricas = criarMetricas();
app.use(metricas.middleware);
app.get('/metricas', metricas.handler);
app.use(express.json());

app.get('/saude', (_req, res) => res.json({ servico: 'cau', ok: true }));

const esquemaCaucao = z.object({
  idLeilao: z.string().uuid(),
  idEmpresa: z.string().uuid(),
  valor: z.number().positive(),
});

app.post('/caucoes', async (req, res, next) => {
  try {
    const d = esquemaCaucao.parse(req.body);
    const c = await solicitar(d, { provedor });
    res.status(c.repetida ? 200 : 201).json(c);
  } catch (e) { next(e); }
});

/** O LEI pergunta isto antes de aceitar o lance (RF-012). */
app.get('/caucoes/ativa', async (req, res, next) => {
  try {
    const { leilao, empresa } = req.query;
    res.json({ ativa: await temCaucaoAtiva(leilao, empresa) });
  } catch (e) { next(e); }
});

/**
 * Webhook do provedor (RF-020, RF-021).
 *
 * Responde 200 inclusive para evento repetido: o provedor reenvia
 * enquanto não receber 2xx, e insistir em algo já processado só geraria
 * mais chamadas.
 */
app.post('/webhooks/:provedor', async (req, res, next) => {
  try {
    const { id_evento: idEvento, id_cobranca: idCobranca, tipo } = req.body;
    const r = await processarWebhook({
      provedor: req.params.provedor, idEvento, idCobranca, tipo, payload: req.body,
    });
    res.json({ recebido: true, aplicado: r.aplicado, repetido: r.repetido });
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }
  if (erro instanceof ErroDeCaucao) {
    return res.status(erro.status).json({ codigo: erro.codigo, mensagem: erro.message });
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
  const porta = Number(process.env.PORTA ?? 3004);
  app.listen(porta, () => console.log(`cau ouvindo em :${porta}`));

  // reconciliação periódica (RF-022): webhook se perde, e sem isto a
  // caução paga ficaria pendente para sempre
  setInterval(() => {
    reconciliar({ provedor }).catch((e) => console.error('reconciliar:', e.message));
  }, 120_000).unref();

  // Liquidação do leilão (RF-023): o LEI decide quem é abatido e quem é
  // devolvido, e publica. Sem este consumidor a decisão ficava na outbox
  // do LEI sem ninguém do outro lado — era o estado anterior a T-025.
  if (process.env.FILA_LIQUIDACAO) {
    criarConsumidor({
      urlFila: process.env.FILA_LIQUIDACAO,
      tratar: async ({ idEvento, corpo }) => {
        await liquidar(daLiquidacao({ idEvento, corpo }), { provedor });
      },
    }).iniciar();
    console.log('consumindo leilao-liquidar');
  }
}
