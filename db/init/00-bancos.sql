-- Um banco lógico e um usuário por serviço.
-- Nenhum usuário tem permissão no banco dos outros — a separação é imposta
-- pelo Postgres, não por convenção de código.
DO $$
DECLARE s TEXT;
BEGIN
  FOREACH s IN ARRAY ARRAY['auth','bar','cat','agd','ass','ava','pag','not'] LOOP
    EXECUTE format('CREATE USER svc_%s WITH PASSWORD %L', s, 'svc_' || s);
  END LOOP;
END $$;

CREATE DATABASE naregua_auth OWNER svc_auth;
CREATE DATABASE naregua_bar  OWNER svc_bar;
CREATE DATABASE naregua_cat  OWNER svc_cat;
CREATE DATABASE naregua_agd  OWNER svc_agd;
CREATE DATABASE naregua_ass  OWNER svc_ass;
CREATE DATABASE naregua_ava  OWNER svc_ava;
CREATE DATABASE naregua_pag  OWNER svc_pag;
CREATE DATABASE naregua_not  OWNER svc_not;

-- REVOKE do público: sem isso, qualquer usuário conecta em qualquer banco
REVOKE CONNECT ON DATABASE naregua_auth FROM PUBLIC;
REVOKE CONNECT ON DATABASE naregua_bar  FROM PUBLIC;
REVOKE CONNECT ON DATABASE naregua_cat  FROM PUBLIC;
REVOKE CONNECT ON DATABASE naregua_agd  FROM PUBLIC;
REVOKE CONNECT ON DATABASE naregua_ass  FROM PUBLIC;
REVOKE CONNECT ON DATABASE naregua_ava  FROM PUBLIC;
REVOKE CONNECT ON DATABASE naregua_pag  FROM PUBLIC;
REVOKE CONNECT ON DATABASE naregua_not  FROM PUBLIC;

GRANT CONNECT ON DATABASE naregua_auth TO svc_auth;
GRANT CONNECT ON DATABASE naregua_bar  TO svc_bar;
GRANT CONNECT ON DATABASE naregua_cat  TO svc_cat;
GRANT CONNECT ON DATABASE naregua_agd  TO svc_agd;
GRANT CONNECT ON DATABASE naregua_ass  TO svc_ass;
GRANT CONNECT ON DATABASE naregua_ava  TO svc_ava;
GRANT CONNECT ON DATABASE naregua_pag  TO svc_pag;
GRANT CONNECT ON DATABASE naregua_not  TO svc_not;
