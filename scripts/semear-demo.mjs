/**
 * Dados de exemplo para a demonstração.
 *
 * Uma tela vazia não demonstra nada: quem assiste precisa ver leilão com
 * história — lance de mais de uma empresa, preço que subiu, sequência
 * numerada. Este script cria isso pelos caminhos reais do sistema:
 * cadastro pelo AUTH, token pelo HAB, leilão e lance pelo LEI, cada um
 * pela sua rota HTTP.
 *
 * Duas coisas são semeadas direto no banco, e vale saber por quê:
 *
 *   habilitação  nasceria do evento `conta_criada` percorrendo
 *                outbox → SNS → SQS até a consulta na BrasilAPI. Numa
 *                demonstração isso é esperar a fila e depender de
 *                internet. O que a semeadura simula é o DESFECHO
 *                aprovado; o resto do caminho — token assinado, conferido
 *                pelo LEI sem chamada de rede — continua igual.
 *
 *   caução       nasceria de uma cobrança no provedor, confirmada por
 *                webhook e espelhada no LEI por evento. A semeadura
 *                escreve no espelho; o que vem depois, a conferência sob
 *                a trava do leilão, é o caminho real.
 *
 * Nada mais é atalho: os lances passam pela mesma trava e pela mesma
 * numeração de sequência que o teste de concorrência exercita.
 *
 *   node scripts/semear-demo.mjs
 */

import pg from 'pg';

const AUTH = process.env.AUTH ?? 'http://localhost:3001';
const LEI = process.env.LEI ?? 'http://localhost:3002';
const HAB = process.env.HAB ?? 'http://localhost:3003';

const SENHA = 'demo12345';

const conectar = (banco) => new pg.Pool({
  host: process.env.PGHOST ?? 'localhost',
  port: Number(process.env.PGPORT ?? 5432),
  user: process.env.PGUSER ?? 'arremate',
  password: process.env.PGPASSWORD ?? 'arremate',
  database: banco,
});

/**
 * CNPJ válido a partir de uma raiz de 8 dígitos.
 *
 * Gerado, e não fixo, porque o cadastro recusa CNPJ repetido: com um
 * valor fixo a segunda semeadura morria em 409. Os dígitos verificadores
 * são calculados de verdade — o AUTH valida o formato na hora (RF-003),
 * e um número inventado seria recusado antes de chegar ao banco.
 */
function cnpjValido(raiz) {
  const base = String(raiz).padStart(8, '0').slice(0, 8) + '0001';
  const digito = (numeros) => {
    const pesos = numeros.length === 12
      ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]
      : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const soma = numeros.split('').reduce((s, n, i) => s + Number(n) * pesos[i], 0);
    const resto = soma % 11;
    return resto < 2 ? 0 : 11 - resto;
  };
  const d1 = digito(base);
  const d2 = digito(base + d1);
  return `${base}${d1}${d2}`;
}

async function pedir(url, { metodo = 'GET', corpo, token, habilitacao } = {}) {
  const r = await fetch(url, {
    method: metodo,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(habilitacao ? { 'X-Habilitacao': habilitacao } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  const dados = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = new Error(`${metodo} ${url} -> ${r.status} ${dados.codigo ?? ''} ${dados.mensagem ?? ''}`);
    e.status = r.status;
    e.codigo = dados.codigo;
    throw e;
  }
  return dados;
}

const EMPRESAS = [
  { apelido: 'vendedor', razao: 'Metalúrgica Cambuí Ltda', raiz: 11222333 },
  { apelido: 'comprador-1', razao: 'Usinagem Atibaia ME', raiz: 22333444 },
  { apelido: 'comprador-2', razao: 'Ferramentaria Jundiaí SA', raiz: 33444555 },
];

const LEILOES = [
  {
    descricao: 'Torno mecânico Nardini ND-250, 1998, revisado',
    lanceInicial: 18000, incremento: 500, horas: 2,
    lances: [{ de: 'comprador-1', valor: 18500 }, { de: 'comprador-2', valor: 19000 },
             { de: 'comprador-1', valor: 20000 }],
  },
  {
    descricao: 'Prensa excêntrica 60 t, com proteção de duas mãos',
    lanceInicial: 42000, incremento: 1000, horas: 3,
    lances: [{ de: 'comprador-2', valor: 43000 }],
  },
  {
    descricao: 'Compressor parafuso 20 cv, 2015',
    lanceInicial: 9500, incremento: 250, horas: 1,
    lances: [],
  },
];

async function main() {
  const bancoHab = conectar('arremate_hab');
  const bancoLei = conectar('arremate_lei');
  const carimbo = Date.now().toString().slice(-6);
  const contas = {};

  console.log('\n== semeando exemplos ==\n');

  // ── empresas ───────────────────────────────────────────────────────
  for (const [i, e] of EMPRESAS.entries()) {
    const cnpj = cnpjValido(e.raiz + Number(carimbo) + i);
    const email = `${e.apelido}-${carimbo}@arremate.local`;

    const criada = await pedir(`${AUTH}/empresas`, {
      metodo: 'POST',
      corpo: { cnpj, razaoSocial: e.razao, email, senha: SENHA },
    });

    // Desfecho aprovado da verificação de CNPJ — ver o cabeçalho.
    await bancoHab.query(
      `INSERT INTO habilitacao (id_empresa, cnpj, situacao, detalhe, id_evento_origem)
       VALUES ($1, $2, 'aprovada', 'semeado para a demonstracao', gen_random_uuid())
       ON CONFLICT DO NOTHING`,
      [criada.id, cnpj],
    );

    const { token: sessao } = await pedir(`${AUTH}/sessoes`, {
      metodo: 'POST', corpo: { email, senha: SENHA },
    });
    const { token: habilitacao } = await pedir(`${HAB}/empresas/${criada.id}/token`, { token: sessao });

    contas[e.apelido] = { id: criada.id, email, sessao, habilitacao, razao: e.razao };
    console.log(`  ${e.razao}`);
    console.log(`    ${email} / ${SENHA}`);
  }

  // ── leilões e lances ───────────────────────────────────────────────
  console.log('');
  const vendedor = contas.vendedor;

  for (const l of LEILOES) {
    const encerraEm = new Date(Date.now() + l.horas * 3600 * 1000).toISOString();
    const leilao = await pedir(`${LEI}/leiloes`, {
      metodo: 'POST', token: vendedor.sessao, habilitacao: vendedor.habilitacao,
      corpo: {
        descricaoEquipamento: l.descricao,
        lanceInicial: l.lanceInicial,
        incrementoMin: l.incremento,
        encerraEm,
      },
    });

    // Espelho da caução para quem vai lançar — ver o cabeçalho.
    for (const apelido of ['comprador-1', 'comprador-2']) {
      await bancoLei.query(
        `INSERT INTO caucao_ativa (id_leilao, id_empresa, id_caucao)
         VALUES ($1, $2, gen_random_uuid())
         ON CONFLICT (id_leilao, id_empresa) DO UPDATE SET atualizado_em = now()`,
        [leilao.id, contas[apelido].id],
      );
    }

    for (const lance of l.lances) {
      const quem = contas[lance.de];
      await pedir(`${LEI}/leiloes/${leilao.id}/lances`, {
        metodo: 'POST', token: quem.sessao, habilitacao: quem.habilitacao,
        corpo: { valor: lance.valor },
      });
    }

    const atual = await pedir(`${LEI}/leiloes/${leilao.id}`);
    const maior = atual.lances?.[0];
    console.log(`  ${l.descricao}`);
    console.log(`    ${leilao.id}`);
    console.log(`    ${l.lances.length} lance(s)` + (maior ? `, atual R$ ${Number(maior.valor).toLocaleString('pt-BR')}` : ', sem lance ainda'));
  }

  console.log('\n  Entre na interface com qualquer um dos e-mails acima.');
  console.log('  Para disputar ao vivo: abra duas abas, entre com compradores diferentes');
  console.log('  e cole o mesmo id de leilão em "Ou entrar num leilão".\n');

  await bancoHab.end();
  await bancoLei.end();
}

main().catch((e) => {
  console.error('\nfalhou:', e.message);
  console.error('os serviços estão no ar? bash scripts/demo.sh\n');
  process.exit(1);
});
