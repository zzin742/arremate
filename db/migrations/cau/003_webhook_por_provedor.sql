-- Chave do webhook passa a incluir o provedor.
--
-- Adotado da proposta de MVP recebida em 24/10 (docs/recebidos/). O id de
-- evento é único dentro do provedor, não globalmente: se um dia houver um
-- segundo provedor, dois eventos legítimos poderiam colidir.
ALTER TABLE evento_pagamento ADD COLUMN provedor VARCHAR(40) NOT NULL DEFAULT 'sandbox';
ALTER TABLE evento_pagamento DROP CONSTRAINT evento_pagamento_unico;
ALTER TABLE evento_pagamento ADD CONSTRAINT evento_pagamento_unico
  UNIQUE (provedor, id_evento_externo);
