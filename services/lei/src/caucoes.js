/**
 * Espelho local das cauções, alimentado pelo evento `caucao_mudou`.
 *
 * O LEI não pergunta ao CAU no caminho do lance. A razão é a mesma do
 * token de habilitação: chamada de rede dentro da trava do leilão
 * seguraria o lock da linha pelo tempo da resposta alheia, e todos os
 * lances daquele leilão ficariam enfileirados atrás dela.
 *
 * O que muda em relação ao token é de onde vem a prova. A habilitação
 * viaja com o pedido, assinada pelo HAB. A caução não: ela muda por
 * webhook do provedor, sem ninguém pedindo, e o participante não teria
 * como carregar uma prova atualizada. Por isso aqui é espelho por
 * evento, e lá é assinatura.
 */

/**
 * Aplica o que o CAU avisou.
 *
 * Idempotente pela chave primária composta: o mesmo evento entregue
 * duas vezes atualiza a linha em vez de duplicá-la — e a entrega é ao
 * menos uma vez (ADR-007), então isso acontece.
 */
export async function espelharCaucao(cx, { idCaucao, idLeilao, idEmpresa, status }) {
  if (status !== 'confirmada') {
    // Qualquer status que não libere o lance remove a permissão.
    // Apagar em vez de guardar o status: esta tabela responde a uma
    // única pergunta, e guardar `recusada` aqui convidaria alguém a
    // consultá-la para outra coisa — e a tratar um espelho como fonte.
    await cx.query(
      'DELETE FROM caucao_ativa WHERE id_leilao = $1 AND id_empresa = $2',
      [idLeilao, idEmpresa],
    );
    return;
  }

  await cx.query(
    `INSERT INTO caucao_ativa (id_leilao, id_empresa, id_caucao)
     VALUES ($1, $2, $3)
     ON CONFLICT (id_leilao, id_empresa)
     DO UPDATE SET id_caucao = EXCLUDED.id_caucao, atualizado_em = now()`,
    [idLeilao, idEmpresa, idCaucao],
  );
}

/**
 * A empresa tem caução neste leilão?
 *
 * Recebe a conexão da transação de propósito: tem de ser consultada
 * **dentro** da trava, junto com o resto da revalidação. Uma consulta
 * feita antes de travar responderia sobre um estado que pode ter
 * mudado durante a espera pelo lock.
 */
export async function temCaucao(cx, { idLeilao, idEmpresa }) {
  const { rowCount } = await cx.query(
    'SELECT 1 FROM caucao_ativa WHERE id_leilao = $1 AND id_empresa = $2',
    [idLeilao, idEmpresa],
  );
  return rowCount > 0;
}
