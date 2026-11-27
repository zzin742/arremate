#!/usr/bin/env python3
"""Agrega cobertura pela regra do RNF-020.

    soma das linhas cobertas
    ────────────────────────  ≥ 60%
    soma das linhas executáveis

Duas coisas que a média de porcentagens esconde, e que esta conta não:

1. **Serviço grande sem teste.** Na média, um arquivo de 10 linhas com
   100% compensa um de 500 com 0%. Na soma, não.
2. **Arquivo que nenhum teste tocou.** Ele não aparece no relatório de
   cobertura, então a ferramenta o ignora e a porcentagem sobe. Aqui ele
   entra no denominador: o script varre o código-fonte e conta como zero
   coberto o que não apareceu.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path


# `testes/` (em portugues) e a pasta do apoio aos testes na raiz;
# `tests/` e a de cada servico. Nenhuma das duas e codigo do produto.
EH_TESTE = re.compile(r"(^|/)tests?/|(^|/)testes/|\.test\.|_test\.py$|(^|/)test_")


def normalizar(caminho: str) -> str:
    """Caminho canônico, relativo à raiz do repositório.

    O lcov do AUTH cita o módulo compartilhado como
    `services/auth/../../packages/shared/src/banco.js`. Sem resolver o
    `..`, o mesmo arquivo entra uma vez por serviço que o importa — oito
    cópias de `banco.js` no denominador, cada uma com as suas 83 linhas.
    Com sete serviços importando o pacote, isso sozinho respondia por
    mais de mil linhas fantasma.
    """
    return os.path.normpath(caminho).replace(os.sep, "/")


def ler_lcov(arquivo: Path, acumulado: dict[str, dict[int, int]]) -> None:
    """Acumula {caminho: {linha: vezes executada}} em `acumulado`.

    Por LINHA, e não por arquivo. O mesmo `catalogo.js` aparece no
    relatório do teste de regra e no do teste HTTP, cada um cobrindo
    linhas diferentes; guardar só o melhor dos dois jogaria fora o que o
    outro cobriu. A união é o número certo — é o quanto do arquivo a
    suíte inteira executa.
    """
    atual: str | None = None

    for linha in arquivo.read_text().splitlines():
        if linha.startswith("SF:"):
            caminho = normalizar(linha[3:].strip())
            # arquivo de teste nao e codigo do produto: ele e sempre
            # executado por inteiro e so serviria para inflar o numero
            atual = None if EH_TESTE.search(caminho) else caminho
            if atual is not None:
                acumulado.setdefault(atual, {})
        elif linha.startswith("DA:") and atual:
            _, _, resto = linha.partition(":")
            numero, _, vezes = resto.partition(",")
            n, v = int(numero), int(vezes)
            anterior = acumulado[atual].get(n, 0)
            if v > anterior:
                acumulado[atual][n] = v
            else:
                acumulado[atual].setdefault(n, v)
        elif linha.startswith("end_of_record"):
            atual = None


def contar_linhas_executaveis(caminho: Path) -> int:
    """Aproximação para arquivo que nenhum teste tocou.

    Conta linha que não é vazia, comentário de uma linha, fechamento de
    bloco solto nem `import`. É aproximação mesmo — mas errar para mais
    no denominador é o lado seguro: a cobertura sai menor, nunca maior.
    """
    n = 0
    em_bloco = False
    for bruta in caminho.read_text(errors="ignore").splitlines():
        s = bruta.strip()
        if em_bloco:
            if "*/" in s:
                em_bloco = False
            continue
        if s.startswith("/*"):
            em_bloco = "*/" not in s
            continue
        if not s or s.startswith(("//", "#", "*")):
            continue
        if s in {"}", "};", "});", ")", "],", "};", "],"}:
            continue
        if s.startswith(("import ", "from ", "export {")):
            continue
        n += 1
    return n


def main() -> int:
    saida, raiz, meta = Path(sys.argv[1]), Path(sys.argv[2]), float(sys.argv[3])

    # {caminho: {linha: vezes}}, unindo todos os relatórios
    por_linha: dict[str, dict[int, int]] = {}
    for lcov in sorted(saida.glob("*.ajustado.lcov")):
        ler_lcov(lcov, por_linha)

    medidos: dict[str, tuple[int, int]] = {
        caminho: (sum(1 for v in linhas.values() if v > 0), len(linhas))
        for caminho, linhas in por_linha.items()
    }

    # arquivos de código que NENHUM relatório mencionou
    #
    # A comparação é pelo caminho inteiro, não pelo nome do arquivo.
    # Comparar por nome fazia `services/cat/src/db.js` passar por medido
    # porque existe um `db.js` em auth — sete arquivos escapando do
    # denominador por homonímia.
    sem_teste: list[tuple[str, int]] = []
    # O frontend entra aqui. Ele estava fora dos padrões, e isso fazia
    # a porcentagem contar só o backend — 275 linhas de código de
    # produto sumiam do denominador sem nada dizer. Medida que escolhe o
    # que medir não mede nada.
    for padrao in ("services/*/src/**/*.js", "packages/*/src/**/*.js",
                   "services/mid/src/**/*.py", "web/src/**/*.js", "web/src/**/*.jsx"):
        for arq in raiz.glob(padrao):
            relativo = normalizar(str(arq.relative_to(raiz)))
            if relativo in medidos:
                continue
            # O próprio arquivo de teste não é código do produto. O
            # `ler_lcov` já o descarta do relatório; sem descartar aqui
            # também, ele voltava pela porta dos fundos — como arquivo
            # "sem teste", com todas as linhas contando como não
            # cobertas.
            if EH_TESTE.search(relativo):
                continue
            n = contar_linhas_executaveis(arq)
            if n:
                sem_teste.append((relativo, n))

    cobertas = sum(c for c, _ in medidos.values())
    executaveis = sum(e for _, e in medidos.values()) + sum(n for _, n in sem_teste)
    pct = 100 * cobertas / executaveis if executaveis else 0.0

    print()
    print(f"  {'arquivo':<52} {'cob':>6} {'exec':>6} {'%':>7}")
    print("  " + "-" * 74)
    for caminho in sorted(medidos):
        c, e = medidos[caminho]
        p = 100 * c / e if e else 0
        marca = "  " if p >= meta else "! "
        print(f"{marca}{caminho[-52:]:<52} {c:>6} {e:>6} {p:>6.1f}%")

    for caminho, n in sorted(sem_teste):
        print(f"! {caminho[-52:]:<52} {0:>6} {n:>6} {0:>6.1f}%   (sem teste)")

    print("  " + "-" * 74)
    print(f"  {'GLOBAL':<52} {cobertas:>6} {executaveis:>6} {pct:>6.1f}%")
    print()
    print(f"  Regra do RNF-020: soma coberta / soma executavel, nao media de %.")
    print(f"  Arquivos sem teste contam no denominador ({len(sem_teste)} arquivo(s)).")
    print()

    if pct < meta:
        print(f"  REPROVADO: {pct:.1f}% < {meta:.0f}% (RNF-023 bloqueia o merge)")
        return 1

    print(f"  APROVADO: {pct:.1f}% >= {meta:.0f}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
