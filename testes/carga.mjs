/**
 * Teste de carga contra RNF-001 e RNF-004 (T-031).
 *
 * Os dois requisitos estão escritos com número no documento 02, e nunca
 * tinham sido medidos. O teste de concorrência do LEI prova **correção**
 * — 50 lances iguais, um aceito — e não diz nada sobre **capacidade**.
 * São perguntas diferentes, e a banca vai fazer a segunda.
 *
 *   RNF-001  latência P95 do registro de lance < 300 ms,
 *            com 20 clientes simultâneos, 70% de lances válidos
 *   RNF-004  > 50 RPS sustentado, 20 conexões, sem lance confirmado
 *            perdido. Rejeição por regra de negócio NÃO conta como falha
 *
 * O caso é deliberadamente o pior: todos os clientes disputam **o mesmo
 * leilão**. É onde o `SELECT ... FOR UPDATE` serializa, e portanto onde
 * a capacidade é menor. Espalhar por vários leilões daria um número
 * maior e responderia outra pergunta.
 *
 * A medição é na borda HTTP: `subir()` escuta numa porta real e o
 * cliente usa `fetch`. É loopback, não rede de verdade — o número exclui
 * latência de rede e de balanceador, e isso está dito no relatório.
 *
 *   node testes/carga.mjs                      30 s, 20 clientes
 *   node testes/carga.mjs --segundos 300       a medição que o RNF pede
 *   node testes/carga.mjs --clientes 40
 */

import { AUDIENCIA_SESSAO, assinar, assinarTokenHabilitacao } from '@arremate/shared';
import { subir } from './servidor.js';

// Marcado ANTES de importar o serviço: `services/lei/src/index.js` chama
// `app.listen(3002)` e liga o laço do encerrador quando não está em
// teste. Sem isto a carga subia dois servidores — o de medição e o de
// produção — e colidia com a porta do `scripts/demo.sh`.
//
// O import é dinâmico pelo mesmo motivo: `import` estático é içado para
// antes de qualquer atribuição no corpo do módulo, então marcar a
// variável aqui em cima não teria efeito.
process.env.NODE_ENV = 'test';
const { pool } = await import('../services/lei/src/db.js');
const { app } = await import('../services/lei/src/index.js');

const argumento = (nome, padrao) => {
  const i = process.argv.indexOf(`--${nome}`);
  return i === -1 ? padrao : Number(process.argv[i + 1]);
};

const SEGUNDOS = argumento('segundos', 30);
const CLIENTES = argumento('clientes', 20);
const FRACAO_VALIDA = argumento('validos', 0.7);
const SEGREDO = process.env.JWT_SEGREDO ?? 'segredo-de-desenvolvimento';
const INCREMENTO = 100;

const META_P95_MS = 300;
const META_RPS = 50;

const VENDEDOR = '10000000-0000-0000-0000-000000000000';
const comprador = (i) => `20000000-0000-0000-0000-${String(i).padStart(12, '0')}`;

const sessao = (sub) => assinar({ sub }, SEGREDO, { audiencia: AUDIENCIA_SESSAO, expiraEm: '2h' });
const habilitacao = (sub) => assinarTokenHabilitacao(sub, SEGREDO);

/** Percentil por interpolação não: posição inteira, que é o que se reporta. */
function percentil(ordenado, p) {
  if (ordenado.length === 0) return NaN;
  const i = Math.min(ordenado.length - 1, Math.ceil((p / 100) * ordenado.length) - 1);
  return ordenado[i];
}

const ms = (n) => `${n.toFixed(1)} ms`;

async function main() {
  const s = await subir(app);

  console.log(`\n== carga: ${CLIENTES} clientes, ${SEGUNDOS}s, mesmo leilão ==\n`);

  // ── preparo ────────────────────────────────────────────────────────
  await pool.query('TRUNCATE arremate, lance, leilao, outbox, caucao_ativa CASCADE');

  const { rows: [{ t }] } = await pool.query(
    "SELECT clock_timestamp() + interval '1 hour' AS t",
  );
  const abertura = await s.post('/leiloes', {
    token: sessao(VENDEDOR), cabecalhos: { 'X-Habilitacao': habilitacao(VENDEDOR) },
    corpo: {
      descricaoEquipamento: 'Torno mecânico — carga',
      lanceInicial: 1000, incrementoMin: INCREMENTO, encerraEm: t.toISOString(),
    },
  });
  if (abertura.status !== 201) {
    throw new Error(`não abriu o leilão: ${abertura.status} ${abertura.texto}`);
  }
  const idLeilao = abertura.json.id;

  // Caução para todos: é condição do lance (RF-012) e sem ela a medição
  // seria de quanto o serviço responde 403, que é outro caminho de código.
  await Promise.all(Array.from({ length: CLIENTES }, (_, i) => pool.query(
    `INSERT INTO caucao_ativa (id_leilao, id_empresa, id_caucao)
     VALUES ($1, $2, gen_random_uuid()) ON CONFLICT DO NOTHING`,
    [idLeilao, comprador(i)],
  )));

  // ── execução ───────────────────────────────────────────────────────
  const latencias = [];
  const confirmados = [];           // sequências que o serviço disse ter aceito
  const contagem = { aceitos: 0, recusados: 0, descartados: 0, erros: 0 };
  const porCodigo = new Map();

  // Contador compartilhado: garante que o lance "válido" nasça acima do
  // atual mesmo com 20 clientes em corrida. Sem ele quase tudo viraria
  // `abaixo_do_minimo` e a fração de válidos não seria a pedida.
  let proximo = 1000 + INCREMENTO;

  const fim = Date.now() + SEGUNDOS * 1000;
  const inicio = Date.now();

  async function cliente(i) {
    const token = sessao(comprador(i));
    const cabecalhos = { 'X-Habilitacao': habilitacao(comprador(i)) };

    while (Date.now() < fim) {
      const valido = Math.random() < FRACAO_VALIDA;
      // inválido de propósito: abaixo do mínimo. O RNF diz que rejeição
      // por regra de negócio não conta como falha — ela faz parte da carga
      const valor = valido ? (proximo += INCREMENTO) : 500;

      const t0 = performance.now();
      let r;
      try {
        r = await s.post(`/leiloes/${idLeilao}/lances`, { token, cabecalhos, corpo: { valor } });
      } catch (e) {
        contagem.erros++;
        porCodigo.set(`rede:${e.code ?? e.message}`, (porCodigo.get(`rede:${e.code ?? e.message}`) ?? 0) + 1);
        continue;
      }
      latencias.push(performance.now() - t0);

      if (r.status === 201 || r.status === 200) {
        contagem.aceitos++;
        confirmados.push(r.json.sequencia);
      } else if (r.status === 409 || r.status === 403) {
        contagem.recusados++;
        porCodigo.set(r.json?.codigo ?? r.status, (porCodigo.get(r.json?.codigo ?? r.status) ?? 0) + 1);
      } else if (r.status === 503) {
        // Descarte por carga: o serviço disse "ocupado, tente de novo".
        // Não é defeito nem lance perdido — é a resposta honesta quando
        // a contenção passa do que o pool aguenta. Contado à parte para
        // aparecer no relatório sem poluir a conta de erro.
        contagem.descartados++;
        porCodigo.set(r.json?.codigo ?? '503', (porCodigo.get(r.json?.codigo ?? '503') ?? 0) + 1);
      } else {
        // 5xx e 4xx inesperados SÃO falha: não são regra de negócio
        contagem.erros++;
        porCodigo.set(`http:${r.status}`, (porCodigo.get(`http:${r.status}`) ?? 0) + 1);
      }
    }
  }

  await Promise.all(Array.from({ length: CLIENTES }, (_, i) => cliente(i)));
  const duracao = (Date.now() - inicio) / 1000;

  // ── conferência: nenhum lance confirmado perdido ───────────────────
  const { rows: [{ n: noBanco }] } = await pool.query(
    'SELECT count(*)::int AS n FROM lance WHERE id_leilao = $1', [idLeilao],
  );
  const { rows: [{ max, distintas }] } = await pool.query(
    `SELECT max(sequencia)::int AS max, count(DISTINCT sequencia)::int AS distintas
       FROM lance WHERE id_leilao = $1`, [idLeilao],
  );

  const perdidos = contagem.aceitos - noBanco;
  const buracoNaSequencia = max !== distintas;

  // ── relatório ──────────────────────────────────────────────────────
  const ordenado = latencias.slice().sort((a, b) => a - b);
  const p50 = percentil(ordenado, 50);
  const p95 = percentil(ordenado, 95);
  const p99 = percentil(ordenado, 99);
  const rps = latencias.length / duracao;
  const fracaoAceita = contagem.aceitos / (contagem.aceitos + contagem.recusados || 1);

  console.log(`duração real        ${duracao.toFixed(1)} s`);
  console.log(`requisições         ${latencias.length}  (${contagem.aceitos} aceitas, ${contagem.recusados} recusadas por regra, ${contagem.descartados} descartadas por carga, ${contagem.erros} erro)`);
  console.log(`fração aceita       ${(fracaoAceita * 100).toFixed(1)}%`);
  console.log(`\nlatência na borda HTTP (loopback)`);
  console.log(`  P50               ${ms(p50)}`);
  console.log(`  P95               ${ms(p95)}`);
  console.log(`  P99               ${ms(p99)}`);
  console.log(`  máx               ${ms(ordenado[ordenado.length - 1] ?? NaN)}`);
  console.log(`\nvazão               ${rps.toFixed(1)} RPS`);
  console.log(`\nintegridade`);
  console.log(`  confirmados       ${contagem.aceitos}`);
  console.log(`  gravados          ${noBanco}`);
  console.log(`  perdidos          ${perdidos}`);
  console.log(`  sequência         ${buracoNaSequencia ? 'COM BURACO' : 'sem buraco e sem repetição'}`);

  if (porCodigo.size) {
    console.log(`\nrecusas por código`);
    for (const [c, n] of [...porCodigo].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(c).padEnd(24)} ${n}`);
    }
  }

  const vereditos = [
    ['RNF-001  P95 < 300 ms', p95 < META_P95_MS, `${ms(p95)}`],
    ['RNF-004  > 50 RPS', rps > META_RPS, `${rps.toFixed(1)} RPS`],
    ['RNF-004  nenhum confirmado perdido', perdidos === 0 && !buracoNaSequencia, `${perdidos} perdido(s)`],
    ['sem erro inesperado (5xx)', contagem.erros === 0, `${contagem.erros} erro(s)`],
  ];

  console.log('');
  let tudoOk = true;
  for (const [nome, ok, valor] of vereditos) {
    console.log(`  ${ok ? 'OK  ' : 'FALHA'}  ${nome.padEnd(36)} ${valor}`);
    tudoOk = tudoOk && ok;
  }

  if (SEGUNDOS < 300) {
    console.log(`\n  Aviso: o RNF pede 5 minutos sustentados. Esta rodada teve ${SEGUNDOS}s.`);
    console.log('  Para a medição que vale: node testes/carga.mjs --segundos 300');
  }

  await s.fechar();
  await pool.end();
  process.exit(tudoOk ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  process.exit(1);
});
