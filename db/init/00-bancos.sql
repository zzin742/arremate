-- Um banco lógico e um usuário por serviço (ADR-003).
-- Nenhum usuário tem permissão no banco dos outros — a separação é imposta
-- pelo Postgres, não por convenção de código.
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['auth','hab','cat','mid','lei','cau','vis'] LOOP
    EXECUTE format('CREATE USER svc_%s WITH PASSWORD %L', s, 'svc_' || s);
  END LOOP;
END $$;

CREATE DATABASE arremate_auth OWNER svc_auth;
CREATE DATABASE arremate_hab  OWNER svc_hab;
CREATE DATABASE arremate_cat  OWNER svc_cat;
CREATE DATABASE arremate_mid  OWNER svc_mid;
CREATE DATABASE arremate_lei  OWNER svc_lei;
CREATE DATABASE arremate_cau  OWNER svc_cau;
CREATE DATABASE arremate_vis  OWNER svc_vis;

-- REVOKE do público: sem isso, qualquer usuário conecta em qualquer banco
REVOKE CONNECT ON DATABASE arremate_auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE arremate_hab  FROM PUBLIC;
REVOKE CONNECT ON DATABASE arremate_cat  FROM PUBLIC;
REVOKE CONNECT ON DATABASE arremate_mid  FROM PUBLIC;
REVOKE CONNECT ON DATABASE arremate_lei  FROM PUBLIC;
REVOKE CONNECT ON DATABASE arremate_cau  FROM PUBLIC;
REVOKE CONNECT ON DATABASE arremate_vis  FROM PUBLIC;
