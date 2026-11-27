import express from 'express';
import { z } from 'zod';
import { criarMetricas, idadeDaPendenciaMaisAntiga, tirarPrefixo, SemConexao } from '@naregua/shared';
import { cadastrar, autenticar, verificarToken, consultar, ErroDeRegra } from './contas.js';
import { pool } from './db.js';

export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar.
app.use(tirarPrefixo('auth'));

const metricas = criarMetricas();
app.use(metricas.middleware);
app.get('/metricas', metricas.handler);
metricas.medirOutbox(() => idadeDaPendenciaMaisAntiga(pool));
app.use(express.json());

// O frontend roda em outra porta, então o navegador trata como origem
// diferente e exige CORS. Em produção o CloudFront serve os dois sob o
// mesmo domínio e isto deixa de ser necessário.
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': process.env.ORIGEM_PERMITIDA ?? 'http://localhost:5173',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const esquemaCadastro = z.object({
  nome: z.string().min(2).max(120),
  email: z.string().email().max(160),
  senha: z.string().min(8, 'a senha precisa de ao menos 8 caracteres'),
  whatsapp: z.string().max(20).optional(),
});

const esquemaLogin = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

app.get('/saude', (_req, res) => res.json({ servico: 'auth', ok: true }));

app.post('/contas', async (req, res, next) => {
  try {
    res.status(201).json(await cadastrar(esquemaCadastro.parse(req.body)));
  } catch (e) { next(e); }
});

app.post('/sessoes', async (req, res, next) => {
  try {
    res.json(await autenticar(esquemaLogin.parse(req.body)));
  } catch (e) { next(e); }
});

/** Quem sou eu. A tela usa para saber se a sessão ainda vale. */
app.get('/eu', async (req, res, next) => {
  try {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const { sub } = verificarToken(token);
    const conta = await consultar(sub);
    if (!conta) {
      // Token válido para conta que não existe mais: 401, não 404. Quem
      // pergunta é a sessão, e a resposta é "esta sessão não vale".
      throw new ErroDeRegra('token_invalido', 'Sessão não corresponde a uma conta', 401);
    }
    res.json(conta);
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }
  if (erro instanceof ErroDeRegra) {
    return res.status(erro.status).json({ codigo: erro.codigo, mensagem: erro.message });
  }
  // Carga, não defeito: o pool não tinha vaga a tempo. 503 diz ao cliente
  // que tentar de novo adianta; 500 mandaria desistir.
  if (erro instanceof SemConexao) {
    res.set('Retry-After', '1');
    return res.status(503).json({ codigo: erro.codigo, mensagem: 'Serviço ocupado, tente novamente' });
  }
  console.error(erro);
  res.status(500).json({ codigo: 'erro_interno' });
});

// Não sobe servidor quando o arquivo é importado por um teste.
if (process.env.NODE_ENV !== 'test' && !process.env.NODE_TEST_CONTEXT) {
  const porta = Number(process.env.PORTA ?? 3001);
  app.listen(porta, () => console.log(`auth ouvindo em :${porta}`));
}
