import express from 'express';
import { z } from 'zod';
import { registrarLance, abrirLeilao, consultarLeilao, LanceRecusado } from './lances.js';
import {
  AUDIENCIA_SESSAO, criarConsumidor, criarMetricas, idadeDaPendenciaMaisAntiga,
  tirarPrefixo, verificar, verificarTokenHabilitacao,
} from '@arremate/shared';
import { emTransacao, pool } from './db.js';
import { espelharCaucao } from './caucoes.js';

const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';
export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar
app.use(tirarPrefixo('lei'));

const metricas = criarMetricas();
app.use(metricas.middleware);
app.get('/metricas', metricas.handler);
metricas.medirOutbox(() => idadeDaPendenciaMaisAntiga(pool));
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
    // A audiência é o que impede o token de habilitação de passar por
    // aqui. Os dois são assinados com o mesmo segredo e os dois trazem
    // `sub`; sem conferir para quem o token foi emitido, pedir o de
    // habilitação de uma empresa bastava para agir como ela.
    req.empresa = verificar(token, SEGREDO, AUDIENCIA_SESSAO).sub;
    next();
  } catch {
    next(new LanceRecusado('nao_autenticado', 'Token ausente, inválido ou expirado'));
  }
}

/**
 * Exige a prova de habilitação, verificada por assinatura (RF-004).
 *
 * Vem no cabeçalho `X-Habilitacao`, separado do de sessão: são duas
 * afirmações diferentes — quem você é, e que você está apto. O LEI não
 * chama o HAB; a arquitetura (§3) proíbe rede no caminho do lance, e o
 * RNF-001 dá 300 ms para a resposta inteira.
 *
 * O token tem de ser da MESMA empresa da sessão. Sem essa conferência,
 * bastaria apresentar a habilitação de uma empresa qualquer que
 * estivesse aprovada.
 */
function exigirHabilitacao(req, _res, next) {
  const token = req.headers['x-habilitacao'] ?? '';
  const { valido, idEmpresa } = verificarTokenHabilitacao(token, SEGREDO);

  if (!valido) {
    return next(new LanceRecusado(
      'sem_habilitacao',
      'Habilitação ausente, vencida ou não aprovada',
    ));
  }

  if (idEmpresa !== req.empresa) {
    return next(new LanceRecusado(
      'habilitacao_de_outra_empresa',
      'O token de habilitação não é desta empresa',
    ));
  }

  return next();
}

const esquemaLeilao = z.object({
  descricaoEquipamento: z.string().min(3).max(200),
  lanceInicial: z.number().positive(),
  incrementoMin: z.number().positive(),
  encerraEm: z.string().datetime(),
});

app.get('/saude', (_req, res) => res.json({ servico: 'lei', ok: true }));

app.post('/leiloes', exigirSessao, exigirHabilitacao, async (req, res, next) => {
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

app.post('/leiloes/:id/lances', exigirSessao, exigirHabilitacao, async (req, res, next) => {
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
    // 403 para habilitação e caução porque o RF-012 pede esse código
    // com todas as letras. Não é capricho: 401 diria "identifique-se"
    // a quem já está identificado, e 409 diria que o estado do leilão
    // recusou, quando o que falta é credencial de quem pede.
    const SEM_PERMISSAO = ['sem_habilitacao', 'habilitacao_de_outra_empresa', 'sem_caucao'];

    const status = erro.codigo === 'nao_autenticado' ? 401
                 : erro.codigo === 'leilao_inexistente' ? 404
                 : SEM_PERMISSAO.includes(erro.codigo) ? 403 : 409;
    return res.status(status).json({ codigo: erro.codigo, mensagem: erro.message });
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
  const porta = Number(process.env.PORTA ?? 3002);
  app.listen(porta, () => console.log(`lei ouvindo em :${porta}`));

  // Espelha a caução que o CAU confirmou. Só liga quando há fila
  // configurada: no CI a imagem sobe sem AWS, e o /saude tem de
  // responder mesmo assim.
  if (process.env.FILA_ESPELHAR_CAUCAO) {
    criarConsumidor({
      urlFila: process.env.FILA_ESPELHAR_CAUCAO,
      tratar: async ({ corpo }) => {
        await emTransacao((cx) => espelharCaucao(cx, {
          idCaucao: corpo.id_caucao,
          idLeilao: corpo.id_leilao,
          idEmpresa: corpo.id_empresa,
          status: corpo.status,
        }));
      },
    }).iniciar();
    console.log('consumindo leilao-espelhar-caucao');
  }
}
