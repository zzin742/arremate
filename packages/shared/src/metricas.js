/**
 * Métricas no formato Prometheus (RNF-021).
 *
 * Um registro por processo. Quem diz **qual** serviço é a configuração
 * de raspagem, não a aplicação: pondo o rótulo nos dois lados, o
 * Prometheus mantém o do alvo e renomeia o da aplicação para
 * `exported_servico`, repetindo em toda série o que já está na outra
 * coluna (infra/observabilidade/prometheus.yml).
 */

import {
  Registry, Histogram, Gauge, collectDefaultMetrics,
} from 'prom-client';

/**
 * Fronteiras do histograma de duração.
 *
 * Não são as padrão da biblioteca. O `histogram_quantile` do Prometheus
 * **interpola dentro do balde**: sem uma fronteira em 0,3 s, o P95 perto
 * do limite do RNF-001 sairia de uma reta traçada entre 0,25 e 0,5 — um
 * palpite, não uma medição. Com 0,3 (RNF-001) e 0,5 (RNF-002) como
 * fronteiras, o painel compara contra o número que o requisito pede.
 */
const FRONTEIRAS = [0.01, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2.5, 5, 10];

/**
 * Rótulo de rota a partir do padrão, nunca da URL.
 *
 * `/leiloes/7/lances` e `/leiloes/8/lances` têm de virar a mesma série
 * `/leiloes/:id/lances`. Usar `req.url` criaria uma série por leilão, e
 * o Prometheus guarda cada série separada — num leilão movimentado isso
 * derruba o próprio Prometheus antes de medir qualquer coisa.
 *
 * Requisição que não casou rota alguma cai em `desconhecida` pelo mesmo
 * motivo: um robô varrendo caminhos abriria uma série por tentativa.
 */
function rotuloDaRota(req) {
  return req.route?.path ?? 'desconhecida';
}

export function criarMetricas() {
  const registro = new Registry();

  // CPU, memória, atraso do laço de eventos e GC. O atraso do laço é o
  // que denuncia o serviço lento sem nenhuma rota lenta — sinal de
  // trabalho síncrono segurando o Node.
  collectDefaultMetrics({ register: registro });

  const duracao = new Histogram({
    name: 'http_requisicao_duracao_segundos',
    help: 'Duração das requisições HTTP',
    labelNames: ['metodo', 'rota', 'status'],
    buckets: FRONTEIRAS,
    registers: [registro],
  });

  const emAndamento = new Gauge({
    name: 'http_requisicoes_em_andamento',
    help: 'Requisições que entraram e ainda não responderam',
    registers: [registro],
  });

  /** Mede toda requisição. Entra antes das rotas. */
  function middleware(req, res, next) {
    // A rota de métricas não se mede: ela responde a cada raspagem e
    // encheria o histograma com o próprio monitoramento.
    if (req.url === '/metricas') return next();

    emAndamento.inc();
    const fim = duracao.startTimer();

    // `finish` dispara quando a resposta foi entregue; `close` cobre o
    // cliente que desistiu no meio. Sem o segundo, a requisição
    // abandonada ficaria em `emAndamento` para sempre e o painel
    // mostraria uma fila que não existe. Os dois podem disparar na
    // mesma resposta, daí a trava.
    let encerrado = false;
    const encerrar = () => {
      if (encerrado) return;
      encerrado = true;
      emAndamento.dec();
      fim({ metodo: req.method, rota: rotuloDaRota(req), status: res.statusCode });
    };
    res.on('finish', encerrar);
    res.on('close', encerrar);

    next();
  }

  /** Handler da rota `/metricas`, que o Prometheus raspa. */
  async function handler(_req, res) {
    res.set('Content-Type', registro.contentType);
    res.end(await registro.metrics());
  }

  /**
   * Publica a idade da pendência mais antiga da outbox (RNF-007b).
   *
   * É medida na hora da raspagem, e não por amostragem periódica, para
   * não guardar um número velho: o valor interessa justamente quando
   * está subindo. Contagem de pendentes não serviria — mil eventos de
   * um segundo atrás estão saudáveis, um de dez minutos não.
   */
  function medirOutbox(consultarIdade) {
    new Gauge({
      name: 'outbox_pendencia_mais_antiga_segundos',
      help: 'Há quanto tempo espera o evento não publicado mais antigo',
      registers: [registro],
      async collect() {
        try {
          this.set(await consultarIdade());
        } catch {
          // Banco fora não pode derrubar a raspagem: sem o try, o
          // /metricas inteiro falharia e o painel perderia também as
          // métricas que não dependem do banco — justamente quando
          // mais se precisa delas.
        }
      },
    });
  }

  return { registro, middleware, handler, medirOutbox };
}
