import express from 'express';
import { z } from 'zod';
import { cadastrar, autenticar, verificarToken, ErroDeRegra } from './empresas.js';
import { tirarPrefixo } from '@arremate/shared';

export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar
app.use(tirarPrefixo('auth'));
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

const esquemaCadastro = z.object({
  cnpj: z.string().min(14),
  razaoSocial: z.string().min(3).max(150),
  email: z.string().email().max(150),
  senha: z.string().min(8, 'senha precisa de ao menos 8 caracteres'),
});

const esquemaLogin = z.object({
  email: z.string().email(),
  senha: z.string().min(1),
});

app.get('/saude', (_req, res) => res.json({ servico: 'auth', ok: true }));

app.post('/empresas', async (req, res, next) => {
  try {
    const dados = esquemaCadastro.parse(req.body);
    const empresa = await cadastrar(dados);
    res.status(201).json(empresa);
  } catch (e) { next(e); }
});

app.post('/sessoes', async (req, res, next) => {
  try {
    const dados = esquemaLogin.parse(req.body);
    res.json(await autenticar(dados));
  } catch (e) { next(e); }
});

// rota protegida de exemplo: qualquer rota com token inválido dá 401 (RF-002)
app.get('/eu', (req, res, next) => {
  try {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    const conteudo = verificarToken(token);
    res.json({ id: conteudo.sub, cnpj: conteudo.cnpj });
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }
  if (erro instanceof ErroDeRegra) {
    return res.status(erro.status).json({ codigo: erro.codigo, mensagem: erro.message });
  }
  console.error(erro);
  res.status(500).json({ codigo: 'erro_interno' });
});

if (process.env.NODE_ENV !== 'test') {
  const porta = Number(process.env.PORTA ?? 3001);
  app.listen(porta, () => console.log(`auth ouvindo em :${porta}`));
}
