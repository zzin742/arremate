/**
 * Roda os testes do pacote atual, um arquivo por processo.
 *
 * Os arquivos de um serviço dividem UM banco, e o `TRUNCATE` do
 * `beforeEach` de um zera a mesa do outro. A primeira tentativa de
 * resolver isso foi `--test-concurrency=1`, por leitura do nome da
 * opção — e estava errada: medido, o Node 26 mantém três a quatro
 * processos de arquivo vivos ao mesmo tempo com ela ligada. Passou
 * despercebido enquanto havia dois arquivos por serviço; quebrou,
 * intermitente, no terceiro.
 *
 * Uma invocação por arquivo serializa de fato, porque quem espera é o
 * processo pai — este aqui. É o mesmo caminho que `cobertura.sh` já
 * usava, pelo mesmo motivo.
 *
 * O custo é o start do Node por arquivo, uns 300 ms. Barato perto de
 * uma suíte que falha a cada três execuções por motivo nenhum.
 */

import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const EXTRA = process.argv.slice(2);

/** Arquivos de teste do pacote, nos dois lugares onde o projeto os põe. */
function arquivosDeTeste() {
  const achados = [];

  for (const pasta of ['tests', 'src']) {
    if (!existsSync(pasta)) continue;
    achados.push(
      ...readdirSync(pasta)
        .filter((nome) => nome.endsWith('.test.js'))
        .map((nome) => join(pasta, nome)),
    );
  }

  return achados.sort();
}

const arquivos = arquivosDeTeste();

if (arquivos.length === 0) {
  console.log('nenhum arquivo de teste');
  process.exit(0);
}

let falhou = 0;

for (const arquivo of arquivos) {
  const r = spawnSync(
    process.execPath,
    ['--test', '--test-timeout=60000', ...EXTRA, arquivo],
    { stdio: 'inherit' },
  );

  // `status` é null quando o processo morreu por sinal; tratar como
  // falha, senão um teste morto por timeout passaria por aprovado.
  if (r.status !== 0) falhou += 1;
}

if (falhou > 0) {
  console.error(`\n${falhou} de ${arquivos.length} arquivo(s) de teste falharam`);
  process.exit(1);
}
