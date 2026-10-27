-- Espelho das cauções ativas, alimentado por evento do CAU (RF-012).
--
-- O LEI precisa saber, DENTRO da trava do leilão, se quem lança tem
-- caução. Havia três formas de descobrir isso, e duas quebram algo:
--
--   consulta HTTP ao CAU dentro da trava   segura o lock da linha do
--                                          leilão durante uma chamada
--                                          de rede: todos os lances
--                                          daquele leilão ficam
--                                          enfileirados atrás dela
--
--   consulta HTTP antes de travar          viola o princípio que o
--                                          próprio `lances.js` declara:
--                                          nada lido antes da trava
--                                          vale, porque pode ter mudado
--                                          durante a espera
--
--   espelho local por evento               consulta local dentro da
--                                          trava: rápida E revalidada
--
-- O preço do espelho é consistência eventual: quem acabou de pagar leva
-- alguns segundos até conseguir dar lance, enquanto o evento percorre
-- outbox -> SNS -> SQS. É um atraso visível ao usuário, e preferível a
-- um lock de leilão dependendo da latência de outro serviço.
--
-- Esta tabela não é fonte de verdade. A verdade é a `caucao` no banco
-- do CAU; aqui é uma cópia para leitura, e só.

CREATE TABLE caucao_ativa (
  id_leilao     UUID        NOT NULL,
  id_empresa    UUID        NOT NULL,
  -- `id_caucao` vem do CAU e serve para distinguir uma caução nova de
  -- um evento atrasado da anterior, caso o par leilão+empresa se repita
  id_caucao     UUID        NOT NULL,
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Uma caução por par leilão+empresa, igual à regra no CAU. A chave
  -- primária composta é o que torna o consumo idempotente: o mesmo
  -- evento entregue duas vezes atualiza a linha em vez de duplicá-la.
  PRIMARY KEY (id_leilao, id_empresa)
);

COMMENT ON TABLE caucao_ativa IS
  'Espelho de leitura das cauções confirmadas no CAU. Fonte de verdade é o CAU.';
