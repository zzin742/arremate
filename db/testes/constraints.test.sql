-- Prova que o BANCO recusa os estados inválidos críticos.
--
-- A ideia é que estas regras valham antes de existir uma linha de regra
-- de negócio: se a aplicação errar, o banco ainda recusa. Cada bloco
-- tenta inserir algo proibido e FALHA o teste se a inserção passar.
--
-- Rodado por db/testes/rodar.sh.

\set ON_ERROR_STOP on

-- ───────────────────────────────────────────────────────────────────
-- 1. AGD — dois atendimentos vivos na mesma cadeira ao mesmo tempo
--
--    É a regra central do produto. Um cliente marcando 10h-10h30 e
--    outro marcando 10h15-10h45 com o MESMO barbeiro não podem coexistir.
-- ───────────────────────────────────────────────────────────────────
\c naregua_agd

BEGIN;
  INSERT INTO agendamento (id_barbearia, id_barbeiro, id_servico, id_cliente, dia, comeca_em, termina_em)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'bbbbbbbb-1111-1111-1111-111111111111',
          'cccccccc-1111-1111-1111-111111111111',
          'dddddddd-1111-1111-1111-111111111111',
          DATE '2027-03-10', TIME '10:00', TIME '10:30');

  DO $$
  BEGIN
    -- 10h15 às 10h45 invade os 15 minutos finais: deve ser recusado
    INSERT INTO agendamento (id_barbearia, id_barbeiro, id_servico, id_cliente, dia, comeca_em, termina_em)
    VALUES ('11111111-1111-1111-1111-111111111111',
            'bbbbbbbb-1111-1111-1111-111111111111',
            'cccccccc-1111-1111-1111-111111111111',
            'eeeeeeee-1111-1111-1111-111111111111',
            DATE '2027-03-10', TIME '10:15', TIME '10:45');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU dois atendimentos sobrepostos na mesma cadeira';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'ok 1.1 — atendimento sobreposto recusado';
  END $$;

  -- OUTRO barbeiro no mesmo horário é legítimo: a barbearia tem mais de
  -- uma cadeira, e bloquear isso quebraria o negócio.
  INSERT INTO agendamento (id_barbearia, id_barbeiro, id_servico, id_cliente, dia, comeca_em, termina_em)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'bbbbbbbb-2222-2222-2222-222222222222',
          'cccccccc-1111-1111-1111-111111111111',
          'eeeeeeee-1111-1111-1111-111111111111',
          DATE '2027-03-10', TIME '10:15', TIME '10:45');
  SELECT 'ok 1.2 — outra cadeira no mesmo horário é aceita' AS resultado;

  -- Encostar não é sobrepor: 10h30-11h começa onde o outro terminou. O
  -- intervalo é '[)' justamente para isso — com '[]' a agenda perderia
  -- um horário a cada atendimento.
  INSERT INTO agendamento (id_barbearia, id_barbeiro, id_servico, id_cliente, dia, comeca_em, termina_em)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'bbbbbbbb-1111-1111-1111-111111111111',
          'cccccccc-1111-1111-1111-111111111111',
          'ffffffff-1111-1111-1111-111111111111',
          DATE '2027-03-10', TIME '10:30', TIME '11:00');
  SELECT 'ok 1.3 — horário encostado (10h30 após 10h30) é aceito' AS resultado;

  -- Cancelar libera a cadeira. Sem o WHERE da constraint, o horário
  -- ficaria bloqueado para sempre por um atendimento que não existe.
  UPDATE agendamento SET status = 'cancelado_pelo_cliente'
   WHERE comeca_em = TIME '10:00' AND id_barbeiro = 'bbbbbbbb-1111-1111-1111-111111111111';

  INSERT INTO agendamento (id_barbearia, id_barbeiro, id_servico, id_cliente, dia, comeca_em, termina_em)
  VALUES ('11111111-1111-1111-1111-111111111111',
          'bbbbbbbb-1111-1111-1111-111111111111',
          'cccccccc-1111-1111-1111-111111111111',
          'eeeeeeee-1111-1111-1111-111111111111',
          DATE '2027-03-10', TIME '10:00', TIME '10:30');
  SELECT 'ok 1.4 — após cancelar, o horário fica livre' AS resultado;

  DO $$
  BEGIN
    -- nem cliente nem encaixe: o atendimento não é de ninguém
    INSERT INTO agendamento (id_barbearia, id_barbeiro, id_servico, dia, comeca_em, termina_em)
    VALUES ('11111111-1111-1111-1111-111111111111',
            'bbbbbbbb-9999-9999-9999-999999999999',
            'cccccccc-1111-1111-1111-111111111111',
            DATE '2027-03-11', TIME '09:00', TIME '09:30');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU atendimento sem cliente e sem encaixe';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 1.5 — atendimento sem dono recusado';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 2. BAR — duas pessoas donas da mesma barbearia
-- ───────────────────────────────────────────────────────────────────
\c naregua_bar

BEGIN;
  INSERT INTO barbearia (id, id_dono, nome, apelido_url)
  VALUES ('aaaaaaaa-1111-1111-1111-111111111111',
          'dddddddd-1111-1111-1111-111111111111', 'Barbearia Teste', 'teste');

  INSERT INTO membro (id_barbearia, id_conta, papel)
  VALUES ('aaaaaaaa-1111-1111-1111-111111111111',
          'dddddddd-1111-1111-1111-111111111111', 'dono');

  DO $$
  BEGIN
    INSERT INTO membro (id_barbearia, id_conta, papel)
    VALUES ('aaaaaaaa-1111-1111-1111-111111111111',
            'eeeeeeee-1111-1111-1111-111111111111', 'dono');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU dois donos na mesma barbearia';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 2.1 — segundo dono recusado';
  END $$;

  -- Sócio e funcionário podem ser vários.
  INSERT INTO membro (id_barbearia, id_conta, papel)
  VALUES ('aaaaaaaa-1111-1111-1111-111111111111',
          'eeeeeeee-1111-1111-1111-111111111111', 'socio');
  SELECT 'ok 2.2 — sócio aceito ao lado do dono' AS resultado;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 3. CAT — dois bloqueios sobrepostos na agenda do mesmo barbeiro
-- ───────────────────────────────────────────────────────────────────
\c naregua_cat

BEGIN;
  INSERT INTO barbeiro (id, id_barbearia, nome)
  VALUES ('bbbbbbbb-1111-1111-1111-111111111111',
          'aaaaaaaa-1111-1111-1111-111111111111', 'Barbeiro Teste');

  INSERT INTO bloqueio (id_barbeiro, comeca_em, termina_em, motivo)
  VALUES ('bbbbbbbb-1111-1111-1111-111111111111',
          '2027-03-10 12:00+00', '2027-03-10 13:00+00', 'almoço');

  DO $$
  BEGIN
    INSERT INTO bloqueio (id_barbeiro, comeca_em, termina_em, motivo)
    VALUES ('bbbbbbbb-1111-1111-1111-111111111111',
            '2027-03-10 12:30+00', '2027-03-10 14:00+00', 'dentista');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU bloqueios sobrepostos';
  EXCEPTION WHEN exclusion_violation THEN
    RAISE NOTICE 'ok 3.1 — bloqueio sobreposto recusado';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 4. ASS — duas assinaturas vivas do mesmo cliente na mesma barbearia
-- ───────────────────────────────────────────────────────────────────
\c naregua_ass

BEGIN;
  INSERT INTO plano (id, id_barbearia, nome, preco_centavos)
  VALUES ('99999999-1111-1111-1111-111111111111',
          'aaaaaaaa-1111-1111-1111-111111111111', 'Plano Teste', 9900);

  INSERT INTO assinatura (id_cliente, id_plano, id_barbearia, comeca_em, termina_em, status)
  VALUES ('dddddddd-1111-1111-1111-111111111111',
          '99999999-1111-1111-1111-111111111111',
          'aaaaaaaa-1111-1111-1111-111111111111',
          DATE '2027-03-01', DATE '2027-04-01', 'ativa');

  DO $$
  BEGIN
    INSERT INTO assinatura (id_cliente, id_plano, id_barbearia, comeca_em, termina_em, status)
    VALUES ('dddddddd-1111-1111-1111-111111111111',
            '99999999-1111-1111-1111-111111111111',
            'aaaaaaaa-1111-1111-1111-111111111111',
            DATE '2027-03-15', DATE '2027-04-15', 'aguardando_pagamento');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU duas assinaturas vivas';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 4.1 — segunda assinatura viva recusada';
  END $$;

  -- Cancelada não conta: o cliente pode assinar de novo depois.
  UPDATE assinatura SET status = 'cancelada'
   WHERE id_cliente = 'dddddddd-1111-1111-1111-111111111111';

  INSERT INTO assinatura (id_cliente, id_plano, id_barbearia, comeca_em, termina_em, status)
  VALUES ('dddddddd-1111-1111-1111-111111111111',
          '99999999-1111-1111-1111-111111111111',
          'aaaaaaaa-1111-1111-1111-111111111111',
          DATE '2027-05-01', DATE '2027-06-01', 'ativa');
  SELECT 'ok 4.2 — após cancelar, o cliente assina de novo' AS resultado;

  -- Consumo do plano é idempotente pelo agendamento.
  INSERT INTO uso_assinatura (id_assinatura, id_servico, id_agendamento)
  SELECT id, 'cccccccc-1111-1111-1111-111111111111', '77777777-1111-1111-1111-111111111111'
    FROM assinatura WHERE status = 'ativa' LIMIT 1;

  DO $$
  BEGIN
    INSERT INTO uso_assinatura (id_assinatura, id_servico, id_agendamento)
    SELECT id, 'cccccccc-1111-1111-1111-111111111111', '77777777-1111-1111-1111-111111111111'
      FROM assinatura WHERE status = 'ativa' LIMIT 1;
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU descontar o mesmo corte duas vezes do plano';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 4.3 — consumo repetido do plano recusado';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 5. AVA — duas avaliações do mesmo atendimento
-- ───────────────────────────────────────────────────────────────────
\c naregua_ava

BEGIN;
  INSERT INTO avaliacao (id_agendamento, id_cliente, id_barbearia, nota)
  VALUES ('77777777-1111-1111-1111-111111111111',
          'dddddddd-1111-1111-1111-111111111111',
          'aaaaaaaa-1111-1111-1111-111111111111', 5);

  DO $$
  BEGIN
    INSERT INTO avaliacao (id_agendamento, id_cliente, id_barbearia, nota)
    VALUES ('77777777-1111-1111-1111-111111111111',
            'dddddddd-1111-1111-1111-111111111111',
            'aaaaaaaa-1111-1111-1111-111111111111', 1);
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU avaliar o mesmo atendimento duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 5.1 — segunda avaliação do mesmo atendimento recusada';
  END $$;
ROLLBACK;

-- ───────────────────────────────────────────────────────────────────
-- 6. PAG — webhook de pagamento repetido
-- ───────────────────────────────────────────────────────────────────
\c naregua_pag

BEGIN;
  INSERT INTO pagamento_plataforma (id_barbearia, pago_em, valor_centavos, id_evento_externo)
  VALUES ('aaaaaaaa-1111-1111-1111-111111111111', DATE '2027-03-05', 14900, 'evt_abc123');

  DO $$
  BEGIN
    INSERT INTO pagamento_plataforma (id_barbearia, pago_em, valor_centavos, id_evento_externo)
    VALUES ('aaaaaaaa-1111-1111-1111-111111111111', DATE '2027-03-05', 14900, 'evt_abc123');
    RAISE EXCEPTION 'FALHOU: o banco ACEITOU o mesmo pagamento duas vezes';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 6.1 — pagamento repetido recusado';
  END $$;
ROLLBACK;

\echo ''
\echo '================================================'
\echo ' TODAS AS CONSTRAINTS CRITICAS PASSARAM'
\echo '================================================'
