# CodeReviewer

Bot de **revisão automática de Pull Requests** no GitHub. Quando um PR é aberto ou atualizado, o sistema analisa o código alterado usando IA (LLM), atribui uma nota e publica um comentário no próprio PR com os problemas encontrados, organizados por criticidade.

## Stack

- **NestJS + TypeScript** — backend modular, organizado por domínio.
- **Prisma + PostgreSQL** — persistência (repositórios, regras, análises, configuração de pontuação).
- **GitHub App + Octokit** — integração com o GitHub via webhooks e API.
- **LangChain + OpenAI (`gpt-4o`)** — motor de análise do código (saída estruturada validada com **Zod**).
- **Arquitetura orientada a eventos** (`@nestjs/event-emitter`) — desacopla as etapas do pipeline.
- **Next.js 16 + React 19** em `webapp/` — dashboard web para análises, regras, repositórios e login via Basic Auth da API.

## Estrutura

- **raiz do repo** — backend NestJS, Prisma, GitHub App, pipeline de análise e scripts operacionais.
- **`webapp/`** — frontend Next.js do CodeReviewer.

## Como funciona (visão geral)

```
Dev abre/atualiza PR no GitHub
        │  (webhook pull_request)
        ▼
WebhookService ── valida assinatura HMAC SHA-256 ── identifica o repo
        │  (emite evento "analysis.requested")
        ▼
AnalysisService (pipeline)
   1. Busca contexto do PR + arquivos alterados (diff) + linguagens via GitHub API
   2. Carrega regras ativas do repositório (banco)
   3. Coleta contexto de arquivos relacionados/importados (SharedFilesService)
   4. Envia tudo para o LLM analisar (LlmService)
   5. Calcula a nota (ScoringService)
   6. Salva a análise e emite "analysis.completed"
        │
        ▼
CommentService formata Markdown ── GithubService publica o comentário no PR
```

Diagrama visual: [CodeReviewer — Fluxo de Análise de PR (FigJam)](https://www.figma.com/board/eSCaywkjIjoce79H3CzSnr)

## Módulos principais

- **`webhook/`** — recebe eventos do GitHub, valida a assinatura HMAC e dispara o pipeline.
- **`github/`** — wrapper da API do GitHub (PR, diff, conteúdo de arquivos, linguagens, comentários) com **retry e backoff exponencial**.
- **`analysis/`** — orquestra o pipeline: `analysis.service`, `llm.service`, `diff.service`, `shared-files.service`, `scoring.service`.
- **`rules/`** — CRUD de regras de revisão (regras padrão, globais e específicas por repositório).
- **`scoring-config/`** — pesos da pontuação por criticidade.
- **`comment/`** — formata o comentário em Markdown (PT-BR, com indicadores 🔴🟡🟢).
- **`repositories/`** — registro dos repositórios e webhooks.

## Regras de revisão

As regras ficam no banco (model `Rule`) e são combinadas por repositório em `RulesService.getActiveRulesForRepo`:

- **Padrão** (`isDefault`) — aplicadas a todos os repositórios e não podem ser editadas/removidas.
- **Globais customizadas** — sem associação a repositório específico (valem para todos).
- **Específicas** — associadas a um repositório via `RuleRepository`.

Cada regra tem `title`, `description`, `criticality` (`low`/`medium`/`high`), `fileGlobs` e `targetLanguage`.

## Pontuação

Definida em `ScoringService`: começa em **100** e desconta pesos por criticidade de cada issue (padrão: `high=10`, `medium=4`, `low=1`, configuráveis em `ScoringConfig`). Nunca fica abaixo de 0.

```
nota = max(0, 100 - Σ peso(criticidade))
```

## Variáveis de ambiente

| Variável | Descrição |
|---|---|
| `DATABASE_URL` | Conexão PostgreSQL (Prisma) |
| `GITHUB_APP_ID` | ID do GitHub App |
| `GITHUB_APP_PRIVATE_KEY` | Chave privada do GitHub App |
| `GITHUB_WEBHOOK_SECRET` | Segredo usado na validação HMAC do webhook |
| `GITHUB_ORG` | Organização alvo no GitHub |
| `WEBHOOK_URL` | URL base pública para registro do webhook |
| `OPENAI_API_KEY` | Chave da API da OpenAI |
| `OPENAI_MODEL` | Modelo usado (padrão: `gpt-4o`) |
| `MAX_DIFF_TOKENS` | Limite estimado de tokens por lote do diff (padrão: `12000`) |

## Setup

```bash
$ npm install
$ npx prisma migrate dev     # aplica o schema no banco
$ npx prisma db seed         # popula regras padrão / config (opcional)
$ npm run webapp:install     # instala dependências do dashboard Next.js
```

## Executar

```bash
# desenvolvimento
$ npm run start

# watch mode
$ npm run start:dev

# produção
$ npm run start:prod
```

### Dashboard Web

```bash
$ npm run webapp:dev
```

O frontend fica em `webapp/` e, por padrão, espera a API do backend em `http://localhost:3000`. Quando necessário, configure `NEXT_PUBLIC_API_URL` no ambiente do app Next.

Para subir a versão já compilada do frontend:

```bash
$ npm run webapp:build
$ npm run webapp:start
```

## Testes

```bash
$ npm run test         # unitários
$ npm run test:e2e     # end-to-end
$ npm run test:cov     # cobertura
```

## Resiliência

Todas as chamadas externas (GitHub e OpenAI) usam retry com backoff exponencial. Erros de rate-limit (`429`) e de servidor (`5xx`) são re-tentados automaticamente; erros de autenticação (`401`/`403`) não. Quando a OpenAI rejeita um prompt grande demais, o `LlmService` agora remove o contexto compartilhado e divide o lote em partes menores antes de desistir. Se o pipeline ainda falhar, um comentário de erro é publicado no PR.
