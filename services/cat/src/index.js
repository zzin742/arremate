import express from 'express';
import { z } from 'zod';
import {
  cadastrar, buscar, porId, prepararUpload, confirmarUpload,
  registrarConversao, ErroDeCatalogo,
} from './catalogo.js';
import { criarS3 } from './s3.js';
import { criarConsumidor } from '@arremate/shared';

const s3 = criarS3();
export const app = express();
app.use(express.json());

app.get('/saude', (_req, res) => res.json({ servico: 'cat', ok: true }));

const esquemaEquipamento = z.object({
  idEmpresa: z.string().uuid(),
  nome: z.string().min(3).max(150),
  categoria: z.string().min(2).max(60),
  ano: z.number().int().min(1900).max(2100).optional(),
  estadoConservacao: z.enum(['novo', 'seminovo', 'usado', 'sucata']),
  localizacao: z.string().min(2).max(120),
  fichaTecnica: z.record(z.unknown()).optional(),
});

app.post('/equipamentos', async (req, res, next) => {
  try {
    res.status(201).json(await cadastrar(esquemaEquipamento.parse(req.body)));
  } catch (e) { next(e); }
});

app.get('/equipamentos', async (req, res, next) => {
  try {
    res.json(await buscar(req.query));
  } catch (e) { next(e); }
});

app.get('/equipamentos/:id', async (req, res, next) => {
  try {
    const eq = await porId(req.params.id);
    if (!eq) return res.status(404).json({ codigo: 'equipamento_inexistente' });
    res.json(eq);
  } catch (e) { next(e); }
});

/** Devolve a URL para o navegador enviar direto ao S3 (RF-008). */
app.post('/equipamentos/:id/midias', async (req, res, next) => {
  try {
    const { tipo } = z.object({ tipo: z.enum(['foto', 'video']) }).parse(req.body);
    const r = await prepararUpload({ idEquipamento: req.params.id, tipo }, { s3 });
    res.status(201).json(r);
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }
  if (erro instanceof ErroDeCatalogo) {
    return res.status(erro.status).json({ codigo: erro.codigo, mensagem: erro.message });
  }
  console.error(erro);
  res.status(500).json({ codigo: 'erro_interno' });
});

if (process.env.NODE_ENV !== 'test') {
  const porta = Number(process.env.PORTA ?? 3007);
  app.listen(porta, () => console.log(`cat ouvindo em :${porta}`));

  // O S3 avisa que o objeto chegou. A mensagem só é apagada depois de
  // publicar `midia_enviada`: apagar antes abriria janela de perda
  // (arquitetura, §3.4).
  if (process.env.FILA_UPLOAD) {
    criarConsumidor({
      urlFila: process.env.FILA_UPLOAD,
      tratar: async ({ corpo }) => {
        for (const r of corpo.Records ?? []) {
          await confirmarUpload({ chave: decodeURIComponent(r.s3.object.key) });
        }
      },
    }).iniciar();
  }

  // retorno do MID: ele não escreve no banco do CAT (MER §7)
  if (process.env.FILA_CONVERSAO) {
    criarConsumidor({
      urlFila: process.env.FILA_CONVERSAO,
      tratar: async ({ corpo }) => registrarConversao({
        idMidia: corpo.id_midia,
        chaveProcessada: corpo.chave_processada,
        erro: corpo.erro ?? null,
      }),
    }).iniciar();
  }
}
