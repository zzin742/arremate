import { test, before, beforeEach, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pool } from '../src/db.js';
import {
  cadastrar, buscar, porId, prepararUpload, confirmarUpload,
  registrarConversao,
} from '../src/catalogo.js';

const EMPRESA = '11111111-1111-1111-1111-111111111111';

/**
 * Dublê do S3. A URL assinada é gerada pelo SDK contra o endpoint, e o
 * que este teste precisa verificar é a **chave** e o estado da mídia —
 * não a assinatura da AWS, que é responsabilidade do SDK.
 */
const s3 = { urlDeUpload: async (chave) => `https://falso/${chave}?assinatura=x` };

const torno = (extra = {}) => ({
  idEmpresa: EMPRESA, nome: 'Torno mecânico Nardini', categoria: 'torno',
  ano: 1998, estadoConservacao: 'usado', localizacao: 'Atibaia-SP', ...extra,
});

before(async () => { await pool.query('SELECT 1'); });
beforeEach(async () => { await pool.query('TRUNCATE midia, equipamento, outbox CASCADE'); });
after(async () => { await pool.end(); });

describe('cadastro (RF-006)', () => {
  test('guarda a ficha técnica como JSON consultável', async () => {
    const eq = await cadastrar(torno({ fichaTecnica: { potencia: '5cv', voltagem: 220 } }));
    assert.equal(eq.ficha_tecnica.potencia, '5cv');
    assert.equal(eq.ficha_tecnica.voltagem, 220);
  });

  test('o banco recusa estado de conservação fora da lista', async () => {
    await assert.rejects(
      () => cadastrar(torno({ estadoConservacao: 'perfeito' })),
      (e) => e.code === '23514',   // check_violation
      'a lista é CHECK no banco, não só validação na borda',
    );
  });

  test('o banco recusa ano absurdo', async () => {
    await assert.rejects(() => cadastrar(torno({ ano: 1500 })), (e) => e.code === '23514');
  });
});

describe('busca (RF-007)', () => {
  beforeEach(async () => {
    await cadastrar(torno());
    await cadastrar(torno({ nome: 'Prensa hidráulica', categoria: 'prensa', estadoConservacao: 'seminovo' }));
    await cadastrar(torno({ nome: 'Empilhadeira Hyster', categoria: 'empilhadeira', localizacao: 'Jundiaí-SP' }));
  });

  test('sem filtro devolve tudo', async () => {
    assert.equal((await buscar()).length, 3);
  });

  test('filtra por categoria, estado e localização', async () => {
    assert.equal((await buscar({ categoria: 'prensa' })).length, 1);
    assert.equal((await buscar({ estadoConservacao: 'seminovo' })).length, 1);
    assert.equal((await buscar({ localizacao: 'Jundiaí' })).length, 1);
  });

  test('combina filtros', async () => {
    assert.equal((await buscar({ categoria: 'torno', estadoConservacao: 'usado' })).length, 1);
    assert.equal((await buscar({ categoria: 'torno', estadoConservacao: 'novo' })).length, 0);
  });

  test('busca por texto no nome, sem diferenciar maiúscula', async () => {
    assert.equal((await buscar({ texto: 'HYSTER' })).length, 1);
  });

  test('valor de filtro não entra no SQL', async () => {
    // se o filtro fosse concatenado, isto derrubaria a tabela
    const r = await buscar({ categoria: "'; DROP TABLE equipamento; --" });
    assert.deepEqual(r, []);
    assert.equal((await buscar()).length, 3, 'a tabela continua lá');
  });
});

describe('upload por URL pré-assinada (RF-008)', () => {
  test('a chave vai para originais/, não para processados/', async () => {
    const eq = await cadastrar(torno());
    const { midia, chave } = await prepararUpload({ idEquipamento: eq.id, tipo: 'video' }, { s3 });

    assert.match(chave, /^originais\//,
      'a separação por prefixo é o que impede o derivado disparar nova conversão');
    assert.match(chave, /\.mp4$/);
    assert.equal(midia.status, 'aguardando_upload',
      'a URL pode nunca ser usada; só o aviso do S3 põe na fila');
  });

  test('não publica evento antes do arquivo existir', async () => {
    const eq = await cadastrar(torno());
    await prepararUpload({ idEquipamento: eq.id, tipo: 'foto' }, { s3 });

    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
    assert.equal(rows[0].n, 0, 'pedir a URL não é enviar o arquivo');
  });

  test('recusa tipo inválido e equipamento inexistente', async () => {
    const eq = await cadastrar(torno());
    await assert.rejects(
      () => prepararUpload({ idEquipamento: eq.id, tipo: 'pdf' }, { s3 }),
      (e) => e.codigo === 'tipo_invalido',
    );
    await assert.rejects(
      () => prepararUpload({
        idEquipamento: '99999999-9999-9999-9999-999999999999', tipo: 'foto',
      }, { s3 }),
      (e) => e.codigo === 'equipamento_inexistente' && e.status === 404,
    );
  });
});

describe('confirmação do upload', () => {
  test('o aviso do S3 põe na fila e publica o evento, na mesma transação', async () => {
    const eq = await cadastrar(torno());
    const { chave } = await prepararUpload({ idEquipamento: eq.id, tipo: 'video' }, { s3 });

    const m = await confirmarUpload({ chave });
    assert.equal(m.status, 'na_fila');
    assert.equal(m.repetido, false);

    const { rows } = await pool.query('SELECT * FROM outbox');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tipo_evento, 'midia_enviada');
    assert.equal(rows[0].payload.chave_original, chave);
  });

  test('IDEMPOTÊNCIA: o S3 avisando duas vezes não publica dois eventos', async () => {
    const eq = await cadastrar(torno());
    const { chave } = await prepararUpload({ idEquipamento: eq.id, tipo: 'video' }, { s3 });

    await confirmarUpload({ chave });
    const segunda = await confirmarUpload({ chave });

    assert.equal(segunda.repetido, true);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM outbox');
    assert.equal(rows[0].n, 1, 'converter duas vezes o mesmo arquivo é desperdício puro');
  });

  test('chave desconhecida dá 404', async () => {
    await assert.rejects(
      () => confirmarUpload({ chave: 'originais/nao/existe.mp4' }),
      (e) => e.codigo === 'midia_inexistente' && e.status === 404,
    );
  });
});

describe('retorno da conversão (RF-009, RF-010)', () => {
  async function midiaNaFila() {
    const eq = await cadastrar(torno());
    const { midia, chave } = await prepararUpload({ idEquipamento: eq.id, tipo: 'video' }, { s3 });
    await confirmarUpload({ chave });
    return midia;
  }

  test('sucesso marca pronta e guarda a chave do derivado', async () => {
    const m = await midiaNaFila();
    const r = await registrarConversao({
      idMidia: m.id, chaveProcessada: `processados/${m.id}.mp4`,
    });

    assert.equal(r.status, 'pronta');
    assert.match(r.chave_processada, /^processados\//);
    assert.equal(r.tentativas, 0, 'sucesso não conta tentativa');
  });

  test('falha marca erro e conta a tentativa (RF-010)', async () => {
    const m = await midiaNaFila();

    let r = await registrarConversao({ idMidia: m.id, chaveProcessada: null, erro: 'codec' });
    assert.equal(r.status, 'erro');
    assert.equal(r.tentativas, 1);

    r = await registrarConversao({ idMidia: m.id, chaveProcessada: null, erro: 'codec' });
    assert.equal(r.tentativas, 2, 'a contagem é o que sustenta o limite de 3 tentativas');
  });

  test('a ficha mostra a mídia e seu estado', async () => {
    const m = await midiaNaFila();
    await registrarConversao({ idMidia: m.id, chaveProcessada: `processados/${m.id}.mp4` });

    const eq = await porId(m.id_equipamento);
    assert.equal(eq.midias.length, 1);
    assert.equal(eq.midias[0].status, 'pronta');
  });
});
