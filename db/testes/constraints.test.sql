-- Prova que o BANCO recusa os três estados inválidos críticos.
--
-- Critério de conclusão da T-003 (planejamento, Sprint 1). A ideia é que
-- estas regras valham antes de existir uma linha de regra de negócio: se a
-- aplicação errar, o banco ainda recusa.
--
-- Cada bloco tenta inserir algo proibido e FALHA o teste se a inserção
-- passar. Rodado por db/testes/rodar.sh.

\set ON_ERROR_STOP on

-- ───────────────────────────────────────────────────────────────────
-- 1. VIS — duas visitas agendadas sobrepostas no mesmo equipamento
-- ───────────────────────────────────────────────────────────────────
\c arremate_vis

BEGIN;
  INSERT INTO visita (id_equipamento, id_empresa, periodo) VALUES
    ('11111111-1111-1111-1111-111111111111',
     '22222222-2222-2222-2222-222222222222',
     tstzrange('2027-01-10 09:00+00', '2027-01-10 11:00+00'));

  DO $$
  BEGIN
    -- sobrepõe das 10h às 12h: deve ser recusada
    INSERT INTO visita (id_equipamento, id_empresa, periodo) VALUES
      ('11111111-1111-1111-1111-111111111111',
       '33333333-3333-3333-3333-333333333333',
       tstzrange('2027-01-10 10:00+00', '2027-01-10 12:00+00'));
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU visita sobreposta';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'ok 1.1 — visita sobreposta recusada';
  END $$;

  DO $$
  BEGIN
    -- mesmo horário, equipamento DIFERENTE: deve passar
    INSERT INTO visita (id_equipamento, id_empresa, periodo) VALUES
      ('99999999-9999-9999-9999-999999999999',
       '33333333-3333-3333-3333-333333333333',
       tstzrange('2027-01-10 10:00+00', '2027-01-10 12:00+00'));
    RAISE NOTICE 'ok 1.2 — outro equipamento no mesmo horário é aceito';
  END $$;

  -- cancelar libera o horário (é o que o WHERE da constraint permite)
  UPDATE visita SET status = 'cancelada'
   WHERE id_equipamento = '11111111-1111-1111-1111-111111111111';
  DO $$
  BEGIN
    INSERT INTO visita (id_equipamento, id_empresa, periodo) VALUES
      ('11111111-1111-1111-1111-111111111111',
       '44444444-4444-4444-4444-444444444444',
       tstzrange('2027-01-10 09:30+00', '2027-01-10 10:30+00'));
    RAISE NOTICE 'ok 1.3 — após cancelar, o horário fica livre';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 2. LEI — dois leilões ativos para o mesmo equipamento
-- ───────────────────────────────────────────────────────────────────
\c arremate_lei

BEGIN;
  INSERT INTO leilao (id_equipamento, id_empresa, lance_inicial, incremento_min, encerra_em, status)
  VALUES ('11111111-1111-1111-1111-111111111111',
          '22222222-2222-2222-2222-222222222222',
          1000, 100, '2027-02-01 12:00+00', 'aberto');

  DO $$
  BEGIN
    INSERT INTO leilao (id_equipamento, id_empresa, lance_inicial, incremento_min, encerra_em, status)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            2000, 100, '2027-03-01 12:00+00', 'agendado');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU segundo leilão ativo';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 2.1 — segundo leilão ativo recusado';
  END $$;

  -- encerrar o primeiro libera o equipamento para novo leilão
  UPDATE leilao SET status = 'encerrado'
   WHERE id_equipamento = '11111111-1111-1111-1111-111111111111';
  DO $$
  BEGIN
    INSERT INTO leilao (id_equipamento, id_empresa, lance_inicial, incremento_min, encerra_em, status)
    VALUES ('11111111-1111-1111-1111-111111111111',
            '22222222-2222-2222-2222-222222222222',
            2000, 100, '2027-03-01 12:00+00', 'agendado');
    RAISE NOTICE 'ok 2.2 — após encerrar, o equipamento pode ser releiloado';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 3. LEI — sequência de lance repetida no mesmo leilão
-- ───────────────────────────────────────────────────────────────────
BEGIN;
  INSERT INTO leilao (id, id_equipamento, id_empresa, lance_inicial, incremento_min, encerra_em, status)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '55555555-5555-5555-5555-555555555555',
          '22222222-2222-2222-2222-222222222222',
          1000, 100, '2027-02-01 12:00+00', 'aberto');

  INSERT INTO lance (id_leilao, id_empresa, valor, sequencia)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '33333333-3333-3333-3333-333333333333', 1100, 1);

  DO $$
  BEGIN
    INSERT INTO lance (id_leilao, id_empresa, valor, sequencia)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
            '44444444-4444-4444-4444-444444444444', 1200, 1);
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU sequência repetida';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 3.1 — sequência repetida no mesmo leilão recusada';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 4. LEI — arremate apontando para lance de OUTRO leilão
-- ───────────────────────────────────────────────────────────────────
BEGIN;
  INSERT INTO leilao (id, id_equipamento, id_empresa, lance_inicial, incremento_min, encerra_em, status)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','55555555-5555-5555-5555-555555555555',
          '22222222-2222-2222-2222-222222222222', 1000, 100, '2027-02-01 12:00+00', 'encerrado'),
         ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','66666666-6666-6666-6666-666666666666',
          '22222222-2222-2222-2222-222222222222', 1000, 100, '2027-02-01 12:00+00', 'encerrado');

  INSERT INTO lance (id, id_leilao, id_empresa, valor, sequencia)
  VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          '33333333-3333-3333-3333-333333333333', 1100, 1);

  DO $$
  BEGIN
    -- arremate do leilão A apontando para lance do leilão B
    INSERT INTO arremate (id_leilao, id_lance)
    VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','cccccccc-cccc-cccc-cccc-cccccccccccc');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU arremate com lance de outro leilão';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'ok 4.1 — arremate com lance de outro leilão recusado';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 5. CAU — webhook repetido (mesmo id de evento externo)
-- ───────────────────────────────────────────────────────────────────
\c arremate_cau

BEGIN;
  INSERT INTO caucao (id, id_leilao, id_empresa, valor)
  VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd',
          'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          '33333333-3333-3333-3333-333333333333', 500);

  INSERT INTO evento_pagamento (id_caucao, id_evento_externo, tipo, payload)
  VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','evt_abc123','pagamento.confirmado','{}');

  DO $$
  BEGIN
    INSERT INTO evento_pagamento (id_caucao, id_evento_externo, tipo, payload)
    VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','evt_abc123','pagamento.confirmado','{}');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU evento de pagamento repetido';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 5.1 — evento de pagamento repetido recusado';
  END $$;

  DO $$
  BEGIN
    -- outro evento da MESMA transação deve passar: a chave é o evento,
    -- não a transação (RF-021)
    INSERT INTO evento_pagamento (id_caucao, id_evento_externo, tipo, payload)
    VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','evt_abc124','pagamento.liquidado','{}');
    RAISE NOTICE 'ok 5.2 — outro evento da mesma transação é aceito';
  END $$;
ROLLBACK;

\echo ''
\echo '================================================'
\echo ' TODAS AS CONSTRAINTS CRITICAS PASSARAM'
\echo '================================================'
