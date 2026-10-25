import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import { registrarLance, abrirLeilao, consultarLeilao, LanceRecusado } from '../src/lances.js';

const VENDEDOR = '11111111-1111-1111-1111-111111111111';
const compradores = (n) =>
  Array.from({ length: n }, (_, i) => `22222222-2222-2222-2222-${String(i).padStart(12, '0')}`);

/**
 * Prazo medido pelo relógio do BANCO, não pelo do Node.
 *
 * `registrarLance` julga o vencimento com `clock_timestamp()`, isto é,
 * com o relógio do Postgres. Marcar o prazo com `Date.now()` punha dois
 * relógios na mesma conta, e o teste passava a medir a diferença entre
 * eles: o Postgres em contêiner no macOS ficou 1,7 s atrasado em relação
 * ao host, e o leilão de 300 ms "ainda estava aberto" meio segundo
 * depois de vencer. Falhava em cerca de metade das execuções, sempre com
 * aparência de corrida.
 */
async function daquiA(ms) {
  const { rows } = await pool.query(
    "SELECT clock_timestamp() + ($1 || ' milliseconds')::interval AS t", [ms],
  );
  return rows[0].t.toISOString();
}

async function leilaoAberto({ inicial = 1000, incremento = 100, duracaoMs = 60_000 } = {}) {
  return abrirLeilao({
    idEmpresa: VENDEDOR,
    descricaoEquipamento: 'Torno mecânico 1998',
    lanceInicial: inicial,
    incrementoMin: incremento,
    encerraEm: await daquiA(duracaoMs),
  });
}

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => { await pool.query('TRUNCATE arremate, lance, leilao, outbox CASCADE'); });
after(async () => { await pool.end(); });

describe('abertura de leilão (RF-011)', () => {
  test('abre com descrição livre, sem depender do catálogo', async () => {
    const l = await leilaoAberto();
    assert.equal(l.status, 'aberto');
    assert.equal(l.descricao_equipamento, 'Torno mecânico 1998');
    assert.equal(l.id_equipamento, null, 'no MVP o CAT ainda não existe');
  });

  test('recusa valores não positivos e prazo no passado', async () => {
    for (const mudanca of [{ inicial: 0 }, { incremento: 0 }]) {
      await assert.rejects(() => leilaoAberto(mudanca), (e) => e.codigo === 'valores_invalidos');
    }
    await assert.rejects(
      () => leilaoAberto({ duracaoMs: -1000 }),
      (e) => e.codigo === 'prazo_no_passado',
    );
  });

  test('quem decide o prazo é o relógio do banco, não o da aplicação', async () => {
    // Prazo curtíssimo, medido pelo relógio do banco. Se a abertura
    // conferisse com `new Date()`, bastaria a aplicação estar adiantada
    // para este leilão ser recusado como vencido — ou, no sentido
    // contrário, para nascer aberto e já vencido, devolvendo 201 e nunca
    // aceitando lance.
    //
    // Com os dois relógios iguais o teste passa dos dois jeitos; ele
    // morde quando há desvio, que é exatamente quando o erro aparece.
    const l = await abrirLeilao({
      idEmpresa: VENDEDOR,
      descricaoEquipamento: 'Prensa hidráulica',
      lanceInicial: 1000,
      incrementoMin: 100,
      encerraEm: await daquiA(5_000),
    });

    assert.equal(l.status, 'aberto');
    const lance = await registrarLance({
      idLeilao: l.id, idEmpresa: compradores(1)[0], valor: 1000,
    });
    assert.ok(lance, 'leilão recém-aberto tem de aceitar lance');
  });
});

describe('regras do lance', () => {
  test('primeiro lance precisa alcançar o inicial (RN04)', async () => {
    const l = await leilaoAberto({ inicial: 1000 });
    const [c] = compradores(1);

    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: c, valor: 999 }),
      (e) => e.codigo === 'lance_abaixo_do_minimo',
    );
    const ok = await registrarLance({ idLeilao: l.id, idEmpresa: c, valor: 1000 });
    assert.equal(ok.sequencia, 1);
  });

  test('demais lances precisam do incremento (RN05)', async () => {
    const l = await leilaoAberto({ inicial: 1000, incremento: 100 });
    const [a, b] = compradores(2);
    await registrarLance({ idLeilao: l.id, idEmpresa: a, valor: 1000 });

    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: b, valor: 1099 }),
      (e) => e.codigo === 'lance_abaixo_do_minimo',
    );
    const ok = await registrarLance({ idLeilao: l.id, idEmpresa: b, valor: 1100 });
    assert.equal(ok.sequencia, 2);
  });

  test('vendedor não pode dar lance no próprio leilão (RN02)', async () => {
    const l = await leilaoAberto();
    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: VENDEDOR, valor: 5000 }),
      (e) => e.codigo === 'vendedor_nao_pode_lancar',
    );
  });

  test('leilão inexistente', async () => {
    await assert.rejects(
      () => registrarLance({
        idLeilao: '99999999-9999-9999-9999-999999999999',
        idEmpresa: compradores(1)[0], valor: 1000,
      }),
      (e) => e.codigo === 'leilao_inexistente',
    );
  });

  test('lance após o prazo é recusado (RN01)', async () => {
    const l = await leilaoAberto({ duracaoMs: 300 });
    const [c] = compradores(1);
    await new Promise((r) => setTimeout(r, 500));

    await assert.rejects(
      () => registrarLance({ idLeilao: l.id, idEmpresa: c, valor: 5000 }),
      (e) => e.codigo === 'leilao_encerrado',
    );
  });
});

describe('RF-014 — concorrência', () => {
  test('(a) 50 lances de VALOR IGUAL: exatamente um aceito', async () => {
    const l = await leilaoAberto({ inicial: 1000, incremento: 100 });
    const quem = compradores(50);

    // dispara todos juntos; a trava do leilão serializa
    const r = await Promise.allSettled(
      quem.map((c) => registrarLance({ idLeilao: l.id, idEmpresa: c, valor: 1000 })),
    );

    const aceitos = r.filter((x) => x.status === 'fulfilled');
    const recusados = r.filter((x) => x.status === 'rejected');

    assert.equal(aceitos.length, 1, 'exatamente um lance de valor igual pode ser aceito');
    assert.equal(recusados.length, 49);
    assert.ok(
      recusados.every((x) => x.reason instanceof LanceRecusado
        && x.reason.codigo === 'lance_abaixo_do_minimo'),
      'os demais são recusados por regra de negócio, não por erro do sistema',
    );

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM lance WHERE id_leilao = $1', [l.id]);
    assert.equal(rows[0].n, 1, 'nada além do aceito pode ter sido persistido');
  });

  test('(b) valores crescentes em ordem controlada: todos aceitos', async () => {
    const l = await leilaoAberto({ inicial: 1000, incremento: 100 });
    const quem = compradores(10);

    // "em ordem controlada" é parte do critério: sob concorrência livre, o
    // lance de 1200 pode pegar a trava antes do de 1100, e aí recusar o de
    // 1100 é o comportamento CORRETO. A trava serializa o acesso; ela não
    // ordena as requisições por valor.
    for (let i = 0; i < quem.length; i++) {
      const lance = await registrarLance({
        idLeilao: l.id, idEmpresa: quem[i], valor: 1000 + i * 100,
      });
      assert.equal(lance.sequencia, i + 1);
    }

    const { rows } = await pool.query(
      'SELECT valor, sequencia FROM lance WHERE id_leilao = $1 ORDER BY sequencia', [l.id],
    );
    assert.equal(rows.length, 10);
    for (let i = 1; i < rows.length; i++) {
      assert.ok(Number(rows[i].valor) > Number(rows[i - 1].valor), 'valores estritamente crescentes');
    }
  });

  test('(c) sequência sem buraco e sem repetição sob concorrência', async () => {
    const l = await leilaoAberto({ inicial: 1000, incremento: 1 });
    const quem = compradores(40);

    // valores bem espalhados: vários conseguem passar, em ordem imprevisível
    const r = await Promise.allSettled(
      quem.map((c, i) => registrarLance({ idLeilao: l.id, idEmpresa: c, valor: 1000 + i * 50 })),
    );
    const aceitos = r.filter((x) => x.status === 'fulfilled').length;
    const recusados = r.filter((x) => x.status === 'rejected').length;

    assert.equal(aceitos + recusados, 40, 'toda requisição termina aceita ou recusada');
    assert.ok(aceitos >= 1);

    const { rows } = await pool.query(
      'SELECT valor, sequencia FROM lance WHERE id_leilao = $1 ORDER BY sequencia', [l.id],
    );

    assert.equal(rows.length, aceitos, 'persistido = confirmado ao cliente, nem mais nem menos');

    // sequência contígua, começando em 1
    rows.forEach((linha, i) => {
      assert.equal(Number(linha.sequencia), i + 1, `buraco ou repetição na sequência em ${i + 1}`);
    });

    // cada lance supera o anterior pelo incremento
    for (let i = 1; i < rows.length; i++) {
      assert.ok(
        Number(rows[i].valor) >= Number(rows[i - 1].valor) + 1,
        'lance aceito tem de superar o anterior',
      );
    }
  });

  test('o maior lance disparado está entre os aceitos', async () => {
    const l = await leilaoAberto({ inicial: 1000, incremento: 1 });
    const quem = compradores(30);
    const valores = quem.map((_, i) => 1000 + i * 10);

    const r = await Promise.allSettled(
      quem.map((c, i) => registrarLance({ idLeilao: l.id, idEmpresa: c, valor: valores[i] })),
    );
    const aceitosValores = r.filter((x) => x.status === 'fulfilled').map((x) => Number(x.value.valor));

    assert.ok(
      aceitosValores.includes(Math.max(...valores)),
      'o maior valor disparado nunca pode ser recusado — ele supera qualquer anterior',
    );
  });

  test('leilões diferentes não disputam a mesma trava', async () => {
    const [a, b] = [await leilaoAberto(), await leilaoAberto()];
    const [c1, c2] = compradores(2);

    const [r1, r2] = await Promise.all([
      registrarLance({ idLeilao: a.id, idEmpresa: c1, valor: 1000 }),
      registrarLance({ idLeilao: b.id, idEmpresa: c2, valor: 1000 }),
    ]);
    assert.equal(r1.sequencia, 1);
    assert.equal(r2.sequencia, 1, 'a sequência é por leilão, não global');
  });
});

describe('a trava existe de fato', () => {
  // Os testes de concorrência acima passam MESMO SEM o FOR UPDATE —
  // verifiquei removendo a trava. As transações são rápidas o bastante
  // para se serializarem sozinhas, e o UNIQUE (id_leilao, sequencia)
  // segura o resto. Eles mostram que o resultado está certo; não provam
  // que a trava está no nosso código.
  //
  // Estes provam: o teste segura a linha do leilão numa conexão própria e
  // exige que `registrarLance` FIQUE ESPERANDO. Se o código não pedir a
  // trava, ele passa direto e o teste falha.

  test('registrarLance espera a linha do leilão ser liberada', async () => {
    const l = await leilaoAberto();
    const [c] = compradores(1);
    const seguro = await pool.connect();

    try {
      await seguro.query('BEGIN');
      // FOR SHARE, e não FOR UPDATE, de propósito. Pela matriz de conflito
      // do PostgreSQL, FOR SHARE conflita com FOR UPDATE mas NÃO com
      // FOR KEY SHARE — que é a trava que o próprio INSERT em `lance` pega
      // na linha do leilão por causa da chave estrangeira.
      //
      // Com FOR UPDATE aqui, o teste passava mesmo sem a trava no código:
      // quem bloqueava era a FK, não o nosso SELECT. Com FOR SHARE, só
      // bloqueia se o código realmente pedir FOR UPDATE.
      await seguro.query('SELECT id FROM leilao WHERE id = $1 FOR SHARE', [l.id]);

      let terminou = false;
      const lance = registrarLance({ idLeilao: l.id, idEmpresa: c, valor: 1000 })
        .then((r) => { terminou = true; return r; });

      await new Promise((r) => setTimeout(r, 600));
      assert.equal(terminou, false,
        'registrarLance completou com a linha travada — ou seja, não pediu a trava');

      await seguro.query('COMMIT');          // solta
      const r = await lance;                  // agora destrava e conclui
      assert.equal(r.sequencia, 1);
    } finally {
      seguro.release();
    }
  });

  test('a trava é por linha: outro leilão não espera', async () => {
    const [x, y] = [await leilaoAberto(), await leilaoAberto()];
    const [c] = compradores(1);
    const seguro = await pool.connect();

    try {
      await seguro.query('BEGIN');
      await seguro.query('SELECT id FROM leilao WHERE id = $1 FOR UPDATE', [x.id]);

      // lance no leilão Y não pode ser afetado pela trava do X
      const r = await Promise.race([
        registrarLance({ idLeilao: y.id, idEmpresa: c, valor: 1000 }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('travou sem motivo')), 2000)),
      ]);
      assert.equal(r.sequencia, 1, 'leilões diferentes não disputam a mesma trava');
      await seguro.query('COMMIT');
    } finally {
      seguro.release();
    }
  });
});

describe('evento de lance superado (RF-027)', () => {
  test('primeiro lance não gera evento; o segundo gera', async () => {
    const l = await leilaoAberto();
    const [a, b] = compradores(2);

    await registrarLance({ idLeilao: l.id, idEmpresa: a, valor: 1000 });
    let { rows } = await pool.query('SELECT * FROM outbox');
    assert.equal(rows.length, 0, 'não há ninguém para avisar no primeiro lance');

    await registrarLance({ idLeilao: l.id, idEmpresa: b, valor: 1100 });
    ({ rows } = await pool.query('SELECT * FROM outbox'));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tipo_evento, 'lance_superado');
    assert.equal(rows[0].publicado_em, null, 'nasce pendente');
  });

  test('lance recusado não deixa evento', async () => {
    const l = await leilaoAberto({ inicial: 1000 });
    const [c] = compradores(1);
    await assert.rejects(() => registrarLance({ idLeilao: l.id, idEmpresa: c, valor: 1 }));

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
    assert.equal(rows[0].n, 0);
  });
});

describe('consulta do leilão (RF-008)', () => {
  test('devolve lance atual e histórico', async () => {
    const l = await leilaoAberto();
    const [a, b] = compradores(2);
    await registrarLance({ idLeilao: l.id, idEmpresa: a, valor: 1000 });
    await registrarLance({ idLeilao: l.id, idEmpresa: b, valor: 1100 });

    const estado = await consultarLeilao(l.id);
    assert.equal(estado.total_lances, 2);
    assert.equal(Number(estado.lance_atual.valor), 1100);
    assert.equal(estado.lance_atual.sequencia, 2);
    assert.equal(await consultarLeilao('99999999-9999-9999-9999-999999999999'), null);
  });
});
