# Backend - Railway

Esta versão mantém o webhook do WhatsApp e adiciona o chat web.

## Nova rota

`POST /api/chat`

A primeira mensagem cria um ticket e retorna um token de sessão assinado.
As mensagens seguintes usam o mesmo ticket/protocolo.

## Variáveis novas

Adicione no Railway:

- `WEB_CHAT_SIGNING_SECRET`: uma sequência longa e aleatória.
- `WEB_ALLOWED_ORIGINS`: depois do deploy do Netlify, use por exemplo:
  `https://reserva-serra-atendimento.netlify.app`

Se `WEB_ALLOWED_ORIGINS` ficar vazio, o backend aceita qualquer origem durante o teste inicial.

## Instalação local

```bash
npm install
npm run dev
```

## Deploy

Substitua os arquivos do projeto atual pelos desta pasta, depois:

```bash
npm install
git add .
git commit -m "Adiciona atendimento web"
git push
```

O Railway deve fazer o redeploy automaticamente.

## Banco

O código utiliza as tabelas já existentes:

- residents
- tickets
- ticket_messages
- ticket_status_history

Não é necessária migração de banco para este MVP.
