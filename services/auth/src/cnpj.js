/**
 * Valida CNPJ pelos dois dígitos verificadores (RF-003).
 *
 * Só o formato — a situação cadastral é consultada depois, de forma
 * assíncrona, pelo HAB na BrasilAPI. Cadastro não é rejeitado por CNPJ
 * inexistente; ele nasce com habilitação pendente.
 */
export function cnpjValido(entrada) {
  const d = String(entrada ?? '').replace(/\D/g, '');
  if (d.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(d)) return false;        // 00000000000000 e afins

  const dv = (base) => {
    let peso = base.length - 7;
    let soma = 0;
    for (let i = 0; i < base.length; i++) {
      soma += Number(base[i]) * peso--;
      if (peso < 2) peso = 9;
    }
    const r = soma % 11;
    return r < 2 ? 0 : 11 - r;
  };

  return dv(d.slice(0, 12)) === Number(d[12])
      && dv(d.slice(0, 13)) === Number(d[13]);
}

export const soDigitos = (v) => String(v ?? '').replace(/\D/g, '');
