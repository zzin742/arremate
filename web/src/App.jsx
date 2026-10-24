import { useState, useEffect, useCallback } from 'react';
import { sessao, entrar, cadastrar, verLeilao, abrirLeilao, darLance } from './api.js';

const dinheiro = (v) =>
  Number(v).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

function Erro({ children }) {
  if (!children) return null;
  return <p className="erro" role="alert">{children}</p>;
}

// ─────────────────────────────────────────────────────────────────
function Entrada({ aoEntrar }) {
  const [modo, setModo] = useState('entrar');
  const [form, setForm] = useState({
    email: '', senha: '', cnpj: '', razaoSocial: '',
  });
  const [erro, setErro] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  const campo = (k) => ({
    value: form[k],
    onChange: (e) => setForm({ ...form, [k]: e.target.value }),
  });

  async function enviar(e) {
    e.preventDefault();
    setErro(null);
    setOcupado(true);
    try {
      if (modo === 'cadastrar') {
        await cadastrar(form);
      }
      const { token } = await entrar(form.email, form.senha);
      sessao.token = token;
      aoEntrar();
    } catch (ex) {
      setErro(ex.message);
    } finally {
      setOcupado(false);
    }
  }

  return (
    <form onSubmit={enviar} className="cartao">
      <h1>Arremate</h1>
      <p className="sub">Leilão de máquinas e equipamentos industriais</p>

      <div className="abas">
        <button type="button" className={modo === 'entrar' ? 'ativa' : ''}
                onClick={() => setModo('entrar')}>Entrar</button>
        <button type="button" className={modo === 'cadastrar' ? 'ativa' : ''}
                onClick={() => setModo('cadastrar')}>Cadastrar empresa</button>
      </div>

      {modo === 'cadastrar' && (
        <>
          <label>CNPJ<input {...campo('cnpj')} placeholder="11.222.333/0001-81" required /></label>
          <label>Razão social<input {...campo('razaoSocial')} required /></label>
        </>
      )}
      <label>E-mail<input type="email" {...campo('email')} required /></label>
      <label>Senha<input type="password" {...campo('senha')} minLength={8} required /></label>

      <Erro>{erro}</Erro>
      <button type="submit" disabled={ocupado}>
        {ocupado ? 'Aguarde…' : modo === 'entrar' ? 'Entrar' : 'Cadastrar e entrar'}
      </button>
    </form>
  );
}

// ─────────────────────────────────────────────────────────────────
function Leilao({ id, aoSair }) {
  const [leilao, setLeilao] = useState(null);
  const [valor, setValor] = useState('');
  const [erro, setErro] = useState(null);
  const [aviso, setAviso] = useState(null);

  const carregar = useCallback(async () => {
    try {
      setLeilao(await verLeilao(id));
    } catch (e) {
      setErro(e.message);
    }
  }, [id]);

  // Consulta periódica. Na Sprint do WebSocket (T-012, escopo adicional)
  // isto vira push pela outbox, com número de sequência para o cliente
  // descartar mensagem atrasada.
  useEffect(() => {
    carregar();
    const t = setInterval(carregar, 2000);
    return () => clearInterval(t);
  }, [carregar]);

  async function lancar(e) {
    e.preventDefault();
    setErro(null); setAviso(null);
    try {
      const lance = await darLance(id, Number(valor));
      setAviso(`Lance ${dinheiro(lance.valor)} aceito — sequência ${lance.sequencia}`);
      setValor('');
      carregar();
    } catch (ex) {
      setErro(ex.message);
    }
  }

  if (!leilao) return <div className="cartao"><p>Carregando…<Erro>{erro}</Erro></p></div>;

  const atual = leilao.lance_atual;
  const minimo = atual
    ? Number(atual.valor) + Number(leilao.incremento_min)
    : Number(leilao.lance_inicial);

  return (
    <div className="cartao">
      <button className="link" onClick={aoSair}>← voltar</button>
      <h2>{leilao.descricao_equipamento}</h2>
      <span className={`etiqueta ${leilao.status}`}>{leilao.status}</span>

      <dl className="placar">
        <div><dt>Lance atual</dt><dd>{atual ? dinheiro(atual.valor) : '—'}</dd></div>
        <div><dt>Mínimo aceito</dt><dd>{dinheiro(minimo)}</dd></div>
        <div><dt>Lances</dt><dd>{leilao.total_lances}</dd></div>
      </dl>
      <p className="sub">Encerra em {new Date(leilao.encerra_em).toLocaleString('pt-BR')}</p>

      <form onSubmit={lancar} className="linha">
        <input type="number" step="0.01" min={minimo} value={valor}
               onChange={(e) => setValor(e.target.value)}
               placeholder={`${minimo}`} required />
        <button type="submit">Dar lance</button>
      </form>

      <Erro>{erro}</Erro>
      {aviso && <p className="aviso">{aviso}</p>}

      <h3>Histórico</h3>
      {leilao.lances.length === 0 && <p className="sub">Nenhum lance ainda.</p>}
      <ol className="historico">
        {leilao.lances.map((l) => (
          <li key={l.id}>
            <span className="seq">#{l.sequencia}</span>
            <strong>{dinheiro(l.valor)}</strong>
            <span className="sub">{new Date(l.criado_em).toLocaleTimeString('pt-BR')}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
function Inicio({ aoAbrir, aoSair }) {
  const [id, setId] = useState('');
  const [form, setForm] = useState({
    descricaoEquipamento: '', lanceInicial: '1000', incrementoMin: '100',
  });
  const [erro, setErro] = useState(null);

  async function criar(e) {
    e.preventDefault();
    setErro(null);
    try {
      const l = await abrirLeilao({
        descricaoEquipamento: form.descricaoEquipamento,
        lanceInicial: Number(form.lanceInicial),
        incrementoMin: Number(form.incrementoMin),
        encerraEm: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
      aoAbrir(l.id);
    } catch (ex) {
      setErro(ex.message);
    }
  }

  const campo = (k) => ({
    value: form[k], onChange: (e) => setForm({ ...form, [k]: e.target.value }),
  });

  return (
    <div className="cartao">
      <button className="link" onClick={aoSair}>sair</button>
      <h2>Abrir leilão</h2>
      <form onSubmit={criar}>
        <label>Equipamento<input {...campo('descricaoEquipamento')}
               placeholder="Torno mecânico 1998" required /></label>
        <div className="linha">
          <label>Lance inicial<input type="number" {...campo('lanceInicial')} required /></label>
          <label>Incremento<input type="number" {...campo('incrementoMin')} required /></label>
        </div>
        <Erro>{erro}</Erro>
        <button type="submit">Abrir (dura 1 hora)</button>
      </form>

      <h2>Ou entrar num leilão</h2>
      <form onSubmit={(e) => { e.preventDefault(); aoAbrir(id); }} className="linha">
        <input value={id} onChange={(e) => setId(e.target.value)}
               placeholder="id do leilão" required />
        <button type="submit">Abrir</button>
      </form>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
export default function App() {
  const [autenticado, setAutenticado] = useState(Boolean(sessao.token));
  const [leilaoId, setLeilaoId] = useState(null);

  function sair() { sessao.token = null; setAutenticado(false); setLeilaoId(null); }

  if (!autenticado) return <Entrada aoEntrar={() => setAutenticado(true)} />;
  if (leilaoId) return <Leilao id={leilaoId} aoSair={() => setLeilaoId(null)} />;
  return <Inicio aoAbrir={setLeilaoId} aoSair={sair} />;
}
