/**
 * Todo pacote importado está declarado no `package.json` de quem o usa?
 *
 * O npm iça as dependências para o `node_modules` da raiz. Um pacote
 * que importa `jsonwebtoken` sem declará-lo funciona aqui, porque outro
 * workspace o instalou — e quebra no contêiner, onde o
 * `npm ci --workspace <x>` instala só o que `<x>` declara.
 *
 * Já aconteceu três vezes:
 *
 *   zod no HAB                  pegou no CI, na etapa que sobe a imagem
 *   jsonwebtoken no shared      idem, e derrubou quatro imagens de uma vez
 *                               (cat, cau, vis, not -- justamente os que
 *                               não declaravam o pacote por conta própria)
 *
 * Nas três o `npm test` passou. É um erro que só a imagem revela, e
 * descobrir isso leva um build inteiro de CI; esta verificação custa
 * menos de um segundo.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const RAIZ = new URL('..', import.meta.url).pathname;

/** Pacotes que o Node traz consigo; não precisam ser declarados. */
const EMBUTIDO = /^(node:|assert$|fs$|path$|url$|crypto$|http$|https$|os$|util$|events$|stream$|child_process$|timers$|zlib$|buffer$|string_decoder$|perf_hooks$)/;

function arquivosJs(pasta) {
  if (!existsSync(pasta)) return [];
  return readdirSync(pasta).flatMap((nome) => {
    const caminho = join(pasta, nome);
    if (statSync(caminho).isDirectory()) return arquivosJs(caminho);
    return nome.endsWith('.js') || nome.endsWith('.jsx') ? [caminho] : [];
  });
}

/** Nome do pacote a partir do que foi importado: `@a/b/c` -> `@a/b`. */
function nomeDoPacote(especificador) {
  const partes = especificador.split('/');
  return especificador.startsWith('@') ? partes.slice(0, 2).join('/') : partes[0];
}

function importados(arquivo) {
  const texto = readFileSync(arquivo, 'utf8');
  const achados = new Set();

  // `import ... from 'x'` e `import('x')`
  for (const m of texto.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
    const alvo = m[1];
    // relativo não é pacote
    if (alvo.startsWith('.') || alvo.startsWith('/')) continue;
    if (EMBUTIDO.test(alvo)) continue;
    achados.add(nomeDoPacote(alvo));
  }

  return achados;
}

const pacotes = [
  ...readdirSync(join(RAIZ, 'services')).map((n) => join('services', n)),
  ...readdirSync(join(RAIZ, 'packages')).map((n) => join('packages', n)),
  'web',
];

let problemas = 0;

for (const pacote of pacotes) {
  const manifesto = join(RAIZ, pacote, 'package.json');
  if (!existsSync(manifesto)) continue;

  const json = JSON.parse(readFileSync(manifesto, 'utf8'));
  const declarados = new Set([
    ...Object.keys(json.dependencies ?? {}),
    ...Object.keys(json.devDependencies ?? {}),
  ]);

  // Só o código que VAI para a imagem. Teste pode usar o que estiver
  // içado: ele nunca roda no contêiner.
  for (const arquivo of arquivosJs(join(RAIZ, pacote, 'src'))) {
    if (/\.test\.jsx?$/.test(arquivo)) continue;

    for (const usado of importados(arquivo)) {
      if (declarados.has(usado)) continue;
      const relativo = arquivo.slice(RAIZ.length);
      console.error(`${relativo}: importa "${usado}", que ${pacote}/package.json não declara`);
      problemas += 1;
    }
  }
}

if (problemas > 0) {
  console.error(
    `\n${problemas} importação(ões) sem declaração.`
    + '\nO `npm test` passa assim mesmo — o npm iça do workspace vizinho.'
    + '\nA imagem é que quebra: `npm ci --workspace <x>` instala só o declarado.',
  );
  process.exit(1);
}

console.log(`ok: ${pacotes.length} pacotes, toda importação declarada`);
