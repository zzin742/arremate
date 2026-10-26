import express from 'express';
import { z } from 'zod';
import { agendar, cancelar, agendaDoEquipamento, ErroDeVisita } from './visitas.js';
import { criarMetricas, tirarPrefixo } from '@arremate/shared';

export const app = express();
// O ALB casa /api/<servico>/* e encaminha sem reescrever o caminho;
// o prefixo sai aqui para as rotas serem as mesmas em qualquer lugar
app.use(tirarPrefixo('vis'));

const metricas = criarMetricas();
app.use(metricas.middleware);
app.get('/metricas', metricas.handler);
app.use(express.json());

app.get('/saude', (_req, res) => res.json({ servico: 'vis', ok: true }));

const esquema = z.object({
  idEquipamento: z.string().uuid(),
  idEmpresa: z.string().uuid(),
  inicio: z.string().datetime(),
  fim: z.string().datetime(),
});

app.post('/visitas', async (req, res, next) => {
  try {
    res.status(201).json(await agendar(esquema.parse(req.body)));
  } catch (e) { next(e); }
});

app.delete('/visitas/:id', async (req, res, next) => {
  try {
    const { idEmpresa } = z.object({ idEmpresa: z.string().uuid() }).parse(req.body);
    res.json(await cancelar(req.params.id, idEmpresa));
  } catch (e) { next(e); }
});

app.get('/equipamentos/:id/agenda', async (req, res, next) => {
  try {
    res.json(await agendaDoEquipamento(req.params.id));
  } catch (e) { next(e); }
});

app.use((erro, _req, res, _next) => {
  if (erro instanceof z.ZodError) {
    return res.status(400).json({ codigo: 'dados_invalidos', detalhes: erro.issues });
  }
  if (erro instanceof ErroDeVisita) {
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
  const porta = Number(process.env.PORTA ?? 3005);
  app.listen(porta, () => console.log(`vis ouvindo em :${porta}`));
}
