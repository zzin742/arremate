# Medição de carga — RNF-001 e RNF-004 (T-031)

**Medido em:** 27/11/2026
**Ferramenta:** `testes/carga.mjs`
**Comando:** `node testes/carga.mjs --segundos 300`

---

## O que os requisitos pedem

| Requisito | Meta |
|---|---|
| RNF-001 | Latência P95 do registro de lance **< 300 ms**, com 20 clientes simultâneos por 5 min, 70% de lances válidos |
| RNF-004 | **> 50 RPS** sustentado com 20 conexões, por 5 min, **sem lance confirmado perdido**. Rejeição por regra de negócio não conta como falha |

Os dois estão escritos com número desde o documento 02 e nunca tinham sido
medidos. O teste de concorrência do LEI prova **correção** — 50 lances iguais,
exatamente um aceito — e não diz nada sobre **capacidade**. São perguntas
diferentes.

## O cenário

Todos os clientes disputam **o mesmo leilão**. É deliberado: é onde o
`SELECT ... FOR UPDATE` serializa, e portanto onde a capacidade é menor.
Espalhar a carga por vários leilões daria um número maior e responderia outra
pergunta.

A medição é na borda HTTP, com o servidor escutando numa porta real e o
cliente usando `fetch`. **É loopback**, então o número exclui latência de rede
e de balanceador — uma medição na AWS será maior, e isso precisa ser dito
assim na banca.

---

## Resultado

| Métrica | Medido | Meta | |
|---|---:|---:|:--:|
| Latência P50 | 39,6 ms | — | |
| **Latência P95** | **124,0 ms** | < 300 ms | OK |
| Latência P99 | 264,3 ms | — | |
| Latência máxima | 897,7 ms | — | |
| **Vazão** | **379,9 RPS** | > 50 RPS | OK |
| **Lances confirmados perdidos** | **0** | 0 | OK |
| Sequência | sem buraco e sem repetição | — | OK |
| Respostas 5xx | 0 | 0 | OK |

114.110 requisições em 300,3 s. 79.932 aceitas, 34.178 recusadas por
`lance_abaixo_do_minimo` — 70,0% de aceitas, que é a fração que o RNF-001
pede.

A vazão ficou **7,6 vezes acima** da meta, no cenário mais hostil possível.

---

## O defeito que a medição encontrou

A primeira rodada de 5 minutos **passou nos dois RNF e mesmo assim acusou um
problema**: 10 respostas **HTTP 500** em 113.896 requisições, com
`Error: timeout exceeded when trying to connect` vindo do pool do Postgres. A
latência máxima foi de **12.530 ms**.

### A causa

Os três limites de espera estavam em ordem errada:

| Limite | Era | Devia ser |
|---|---:|---|
| `lock_timeout` (espera pela linha do leilão) | 30 s | **o menor** |
| `connectionTimeoutMillis` (espera por vaga no pool) | 10 s | no meio |
| `statement_timeout` (espera pela consulta) | 30 s | o maior |

Com 20 clientes no mesmo leilão e um pool de 10 conexões, quem pegava a trava
segurava a conexão por até 30 s, enquanto quem esperava vaga no pool desistia
em 10 s. **A falha aparecia no pool, longe de onde a contenção realmente
estava** — e subia como exceção genérica, virando HTTP 500.

Um 500 diz ao cliente "erro nosso, desista". O caso aqui é o oposto: é carga,
e tentar de novo adianta.

### A correção

1. **`lock_timeout` passou para 5 s**, abaixo da espera do pool. Quem espera
   demais pela linha falha primeiro, **devolve a conexão**, e a fila do pool
   drena. A carga é descartada onde ela existe. 5 s é folgado: sob 380 RPS o
   P99 é de 264 ms, então só dispara em contenção patológica — que é quando se
   quer descartar.
2. **`SemConexao`**, uma classe própria em `packages/shared/src/banco.js`, para
   separar "o banco recusou" de "não cheguei ao banco". O LEI a traduz em
   **503 com `Retry-After: 1`**.

### Antes e depois

| | Antes | Depois |
|---|---:|---:|
| Respostas 5xx | 10 | **0** |
| Latência máxima | 12.530,4 ms | **897,7 ms** |
| P95 | 109,4 ms | 124,0 ms |
| Vazão | 379,6 RPS | 379,9 RPS |

A latência máxima caiu **14 vezes**. P95 e vazão não mudaram de forma
significativa — a correção não comprou desempenho, **comprou previsibilidade**:
o caso ruim deixou de ser uma espera de 12 segundos terminada em erro interno.

> O P95 subiu 14,6 ms entre as duas rodadas. Não é efeito da correção: as duas
> rodadas são amostras diferentes na mesma máquina, com variação normal. O que
> mudou de verdade foi a cauda.

---

## Limites desta medição

Honestidade sobre o que o número **não** diz:

- **É loopback, não rede.** Exclui latência de rede, ALB e TLS. Na AWS o P95
  será maior; a parcela medida aqui é a do serviço e do banco.
- **Uma instância do LEI, um Postgres local.** Em produção o LEI escala de 2 a
  6 tarefas, e o RDS tem outro perfil de disco.
- **Só o caminho do lance.** Abertura de leilão, encerramento e as rotas dos
  outros sete serviços não entraram.
- **A máquina é um MacBook**, com o Postgres em contêiner. Não é ambiente
  controlado de teste de desempenho.

O que a medição prova com segurança: no cenário de contenção máxima, **a
serialização por `FOR UPDATE` não é o gargalo que se temia**, e nenhum lance
confirmado se perde.

---

## Como repetir

```bash
npm run db:up
node testes/carga.mjs --segundos 300          # a medição que o RNF pede
node testes/carga.mjs                         # 30 s, para conferência rápida
node testes/carga.mjs --clientes 40           # dobrando a concorrência
```

O script sai com código 1 se qualquer veredito falhar, então serve de portão
em pipeline.
