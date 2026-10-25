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

import re
import sys
from pathlib import Path


EH_TESTE = re.compile(r"(^|/)tests?/|\.test\.|_test\.py$|^test_")


def ler_lcov(arquivo: Path) -> dict[str, tuple[int, int]]:
    """{caminho: (linhas_cobertas, linhas_executaveis)}"""
    por_arquivo: dict[str, tuple[int, int]] = {}
    atual: str | None = None
    cobertas = executaveis = 0

    for linha in arquivo.read_text().splitlines():
        if linha.startswith("SF:"):
            atual = linha[3:].strip()
            cobertas = executaveis = 0
        elif linha.startswith("DA:") and atual:
            _, _, resto = linha.partition(":")
            _, _, vezes = resto.partition(",")
            executaveis += 1
            if int(vezes) > 0:
                cobertas += 1
        elif linha.startswith("end_of_record") and atual:
            # arquivo de teste nao e codigo do produto: ele e sempre
            # executado por inteiro e so serviria para inflar o numero
            if not EH_TESTE.search(atual):
                por_arquivo[atual] = (cobertas, executaveis)
            atual = None

    return por_arquivo


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

    medidos: dict[str, tuple[int, int]] = {}
    for lcov in saida.glob("*.ajustado.lcov"):
        for caminho, nums in ler_lcov(lcov).items():
            # o mesmo arquivo pode aparecer em dois relatórios (código
            # compartilhado); fica com a melhor medição
            anterior = medidos.get(caminho, (0, 0))
            if nums[0] > anterior[0]:
                medidos[caminho] = nums

    # arquivos de código que NENHUM relatório mencionou
    nomes_medidos = {Path(c).name for c in medidos}
    sem_teste: list[tuple[str, int]] = []
    for padrao in ("services/*/src/**/*.js", "packages/*/src/**/*.js", "services/mid/src/**/*.py"):
        for arq in raiz.glob(padrao):
            if arq.name in nomes_medidos:
                continue
            n = contar_linhas_executaveis(arq)
            if n:
                sem_teste.append((str(arq.relative_to(raiz)), n))

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
