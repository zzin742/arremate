# Documento de Solicitação do Sistema

---

**Projeto:** Na Régua — Marketplace de Barbearias
**Grupo:** Na Régua
**Curso:** Análise e Desenvolvimento de Sistemas — UniFAAT
**Versão:** 1.0 — 27/11/2026

---

## 1. Visão geral

O **Na Régua** é um marketplace de barbearias. O cliente encontra a barbearia,
escolhe o serviço e o barbeiro, vê os horários livres e marca. A barbearia
administra a própria agenda, a equipe, os planos de assinatura e o caixa.

O produto nasceu de uma necessidade observada em Piracaia e Atibaia, no
interior de São Paulo, onde barbearias de bairro agendam por WhatsApp.

---

## 2. O problema

Agendar por WhatsApp funciona até a barbearia crescer. A partir de dois
barbeiros e umas vinte marcações por dia, três problemas aparecem e não se
resolvem com disciplina.

### 2.1 Horário marcado duas vezes

É o problema central, e o único que não tem solução organizacional.

Duas pessoas mandam mensagem quase ao mesmo tempo pedindo as 10h de sábado com
o mesmo barbeiro. Quem responde está cortando cabelo, olha o celular entre um
cliente e outro, e confirma as duas. No sábado, duas pessoas aparecem para a
mesma cadeira.

O custo não é o constrangimento: é o cliente que vai embora e não volta.

> Este é o problema que define a viabilidade técnica do projeto. Ele continua
> existindo mesmo com um sistema, se o sistema for construído de forma ingênua
> — e é por isso que a arquitetura do Na Régua gira em torno dele.

### 2.2 Falta não registrada

O cliente não aparece e ninguém anota. No fim do mês o dono não sabe quantos
faltaram, quem falta sempre, nem quanto isso custou em cadeira vazia.

### 2.3 O dono não sabe quanto cada barbeiro produziu

A comissão é calculada de cabeça ou num caderno. Quando há divergência, não há
registro para conferir — e a conversa sobre dinheiro entre o dono e o barbeiro
acontece sem dado nenhum.

---

## 3. Justificativa

### 3.1 Por que não basta uma agenda genérica

Existem agendas online genéricas. Elas não resolvem o caso da barbearia por
três motivos:

| Necessidade | O que a agenda genérica não faz |
|---|---|
| Serviços com duração própria | Corte 30 min, corte com barba 50 min, pezinho 15 min. A agenda genérica trabalha com blocos fixos. |
| Barbeiro que faz só alguns serviços | O aprendiz não faz barba. A agenda genérica não modela quem faz o quê. |
| Assinatura mensal | "Quatro cortes por mês" é o modelo que a barbearia usa para fidelizar, e exige controlar ciclo e consumo. |
| Comissão por serviço | A comissão muda por serviço e por barbeiro. |

### 3.2 Por que o cliente usaria

Porque hoje ele manda mensagem e espera. No Na Régua ele vê o horário livre e
marca, sem conversar com ninguém. Para quem marca fora do horário comercial —
que é quando a maioria lembra — a diferença é entre marcar agora e marcar
amanhã.

---

## 4. Valor agregado

| Para quem | O que muda |
|---|---|
| **Dono da barbearia** | Agenda confiável, registro de falta, relatório por barbeiro, planos de assinatura |
| **Barbeiro** | Agenda própria, bloqueio de horário, comissão com registro |
| **Cliente** | Marca sozinho, a qualquer hora, e vê o horário real |

---

## 5. Público-alvo

- **Barbearias de bairro**, de um a seis barbeiros, em cidades do interior.
  É o recorte onde o problema existe e onde ainda não há sistema.
- **Clientes** que já cortam nessas barbearias e hoje marcam por WhatsApp.

---

## 6. Escopo do MVP

| # | Funcionalidade |
|---|---|
| 1 | Cadastro e autenticação de conta |
| 2 | Cadastro de barbearia, com horário de funcionamento |
| 3 | Cadastro de serviços, barbeiros e expediente |
| 4 | Consulta de horários livres |
| 5 | **Agendamento com garantia de que a cadeira não é marcada duas vezes** |
| 6 | Cancelamento, conclusão e registro de falta |

**O item 5 é o núcleo.** Ele demonstra a viabilidade técnica da proposta: com N
pedidos de agendamento chegando ao mesmo tempo para o mesmo barbeiro e horário,
exatamente um é aceito, e todo agendamento confirmado ao cliente está no banco.

---

## 7. Fora do escopo

Registrado para evitar expectativa que o projeto não vai atender:

- **Pagamento do corte.** O cliente paga no balcão, como já paga. O sistema
  trata apenas o pagamento **da barbearia para a plataforma**.
- **Emissão de nota fiscal.**
- **Controle de estoque** de produtos.
- **Rede social.** Não há perfil público de cliente, seguidores nem feed.

---

## 8. Situação atual

O Na Régua existe como produto real, no ar, construído sobre uma plataforma de
backend gerenciado. O Projeto Experimental **reconstrói o backend** segundo os
requisitos arquiteturais do termo de aceite: microsserviços, infraestrutura
própria em nuvem pública, provisionamento por Terraform, esteira de CI/CD e
monitoramento.

O domínio, as regras de negócio e o design das telas vêm do produto real. O que
muda é a arquitetura — e é essa mudança que o projeto acadêmico documenta e
defende.
