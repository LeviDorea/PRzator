# CodeReviewer Webapp

Frontend Next.js do CodeReviewer.

## Objetivo

Este app entrega a interface web para:

- login com Basic Auth da API
- visualização de análises de PR
- gestão de regras
- gestão de repositórios
- ajustes de configuração

## Desenvolvimento

No repo raiz:

```bash
npm run webapp:install
npm run webapp:dev
```

Ou, diretamente nesta pasta:

```bash
npm install
npm run dev
```

## Configuração

O app usa `NEXT_PUBLIC_API_URL` para apontar para o backend do CodeReviewer.

Se a variável não estiver definida, o fallback atual é:

```text
http://localhost:3000
```
