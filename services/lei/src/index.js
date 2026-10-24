import express from 'express';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { registrarLance, abrirLeilao, consultarLeilao, LanceRecusado } from './lances.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';
export const app = express();
app.use(express.json());

// O frontend roda em outra porta (5173), então o navegador trata como
// origem diferente e exige CORS. Em produção o CloudFront serve os dois
// sob o mesmo domínio e isso deixa de ser necessário (ADR-011).
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': process.env.ORIGEM_PERMITIDA ?? 'http://localhost:5173',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/** Exige token emitido pelo AUTH; verificado por assinatura, sem chamada de rede. */
function exigirSessao(req, _res, next) {
  try {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    req.empresa = jwt.verify(token, SEGREDO).sub;
    next();
  } catch {
    next(new LanceRecusado('nao_autenticado', 'Token ausente, inválido ou expirado'));
  }
}

const esquemaLeilao = z.object({
  descricaoEquipamento: z.string().min(3).max(200),
  lanceInicial: z.number().positive(),
  incrementoMin: z.number().positive(),
  encerraEm: z.string().datetime(),
});

app.get('/saude', (_req, res) => res.json({ servico: 'lei', ok: true }));

app.post('/leiloes', exigirSessao, async (req, res, next) => {
  try {
    const d = esquemaLeilao.parse(req.body);
    res.status(201).json(await abrirLeilao({ idEmpresa: req.empresa, ...d }));
  } catch (e) { next(e); }
});

app.get('/leiloes/:id', async (req, res, next) => {
  try {
    const l = await consultarLeilao(req.params.id);
    if (!l) return res.status(404).json({ codigo: 'leilao_inexistente' });
    res.json(l);
  } catch (e) { next(e); }
});

app.post('/leiloes/:id/lances', exigirSessao, async (req, res, next) => {
  try {
    const { valor } = z.object({ valor: z.number().positive() }).parse(req.body);
    const lance = await registrarLance({
      idLeilao: req.params.id, idEmpresa: req.empresa, valor,
    });
    res.status(201).json(lance);
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }
  if (erro instanceof LanceRecusado) {
    // 409: o pedido estava bem formado, mas o estado do leilão o recusa
    const status = erro.codigo === 'nao_autenticado' ? 401
                 : erro.codigo === 'leilao_inexistente' ? 404 : 409;
    return res.status(status).json({ codigo: erro.codigo, mensagem: erro.message });
  }
  console.error(erro);
  res.status(500).json({ codigo: 'erro_interno' });
});

if (process.env.NODE_ENV !== 'test') {
  const porta = Number(process.env.PORTA ?? 3002);
  app.listen(porta, () => console.log(`lei ouvindo em :${porta}`));
}
