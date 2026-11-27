import express from 'express';
import { z } from 'zod';
import {
  AUDIENCIA_SESSAO, criarMetricas, idadeDaPendenciaMaisAntiga,
  tirarPrefixo, verificar, SemConexao,
} from '@naregua/shared';
import {
  agendar, cancelar, concluir, marcarFalta,
  agendaDoDia, meusAgendamentos, horariosLivres, AgendamentoRecusado,
} from './agendamentos.js';
import { pool } from './db.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';

export const app = express();
app.use(tirarPrefixo('agd'));

const metricas = criarMetricas();
app.use(metricas.middleware);
app.get('/metricas', metricas.handler);
metricas.medirOutbox(() => idadeDaPendenciaMaisAntiga(pool));
app.use(express.json());

app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': process.env.ORIGEM_PERMITIDA ?? 'http://localhost:5173',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/** Exige token do AUTH; verificado por assinatura, sem chamada de rede. */
function exigirSessao(req, _res, next) {
  try {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    req.conta = verificar(token, SEGREDO, AUDIENCIA_SESSAO).sub;
    return next();
  } catch {
    return next(new AgendamentoRecusado('nao_autenticado', 'Entre para continuar'));
  }
}

app.get('/saude', (_req, res) => res.json({ servico: 'agd', ok: true }));

const esquemaAgendar = z.object({
  idBarbearia: z.string().uuid(),
  idBarbeiro: z.string().uuid(),
  idServico: z.string().uuid(),
  dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'use AAAA-MM-DD'),
  comecaEm: z.string().regex(/^\d{2}:\d{2}$/, 'use HH:MM'),
  duracaoMin: z.number().int().positive().max(480),
  valorCentavos: z.number().int().min(0).default(0),
  idAssinatura: z.string().uuid().nullable().optional(),
});

/** O cliente marca para si. O dono do agendamento sai do token. */
app.post('/agendamentos', exigirSessao, async (req, res, next) => {
  try {
    const d = esquemaAgendar.parse(req.body);
    res.status(201).json(await agendar({ ...d, idCliente: req.conta, origem: 'site' }));
  } catch (e) { next(e); }
});

const esquemaEncaixe = esquemaAgendar.extend({
  nomeEncaixe: z.string().min(2).max(120),
  whatsappEncaixe: z.string().max(20).optional(),
});

/** Encaixe anotado no balcão: ocupa a cadeira igual, sem conta de cliente. */
app.post('/encaixes', exigirSessao, async (req, res, next) => {
  try {
    const d = esquemaEncaixe.parse(req.body);
    res.status(201).json(await agendar({ ...d, idCliente: null, origem: 'painel' }));
  } catch (e) { next(e); }
});

app.post('/agendamentos/:id/cancelar', exigirSessao, async (req, res, next) => {
  try {
    const { por } = z.object({ por: z.enum(['cliente', 'barbearia']) }).parse(req.body);
    res.json(await cancelar(req.params.id, { por, idQuemPede: req.conta }));
  } catch (e) { next(e); }
});

app.post('/agendamentos/:id/concluir', exigirSessao, async (req, res, next) => {
  try {
    res.json(await concluir(req.params.id));
  } catch (e) { next(e); }
});

app.post('/agendamentos/:id/falta', exigirSessao, async (req, res, next) => {
  try {
    res.json(await marcarFalta(req.params.id));
  } catch (e) { next(e); }
});

app.get('/barbearias/:id/agenda', exigirSessao, async (req, res, next) => {
  try {
    const { dia } = z.object({ dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).parse(req.query);
    res.json(await agendaDoDia(req.params.id, dia));
  } catch (e) { next(e); }
});

app.get('/meus-agendamentos', exigirSessao, async (req, res, next) => {
  try {
    res.json(await meusAgendamentos(req.conta));
  } catch (e) { next(e); }
});

/**
 * Horários livres. Não exige sessão: o cliente precisa ver a agenda
 * antes de criar conta, senão a barbearia perde a visita.
 *
 * É consulta, não reserva: entre ver e marcar, outra pessoa pode marcar.
 */
app.get('/barbeiros/:id/livres', async (req, res, next) => {
  try {
    const q = z.object({
      dia: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      duracaoMin: z.coerce.number().int().positive().max(480),
    }).parse(req.query);
    res.json(await horariosLivres(req.params.id, q.dia, q.duracaoMin));
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }

  if (erro instanceof AgendamentoRecusado) {
    // 409 para o horário tomado: o pedido estava bem formado, e foi o
    // estado da agenda que recusou. É a diferença que deixa a tela dizer
    // "esse horário acabou de ser preenchido" em vez de "erro 400".
    const porCodigo = {
      nao_autenticado: 401,
      nao_e_seu: 403,
      nao_encontrado: 404,
      horario_ocupado: 409,
    };
    const status = porCodigo[erro.codigo] ?? 422;
    return res.status(status).json({ codigo: erro.codigo, mensagem: erro.message });
  }

  if (erro instanceof SemConexao) {
    res.set('Retry-After', '1');
    return res.status(503).json({ codigo: erro.codigo, mensagem: 'Serviço ocupado, tente novamente' });
  }

  console.error(erro);
  res.status(500).json({ codigo: 'erro_interno' });
});

if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
  const porta = Number(process.env.PORTA ?? 3004);
  app.listen(porta, () => console.log(`agd ouvindo em :${porta}`));
}
