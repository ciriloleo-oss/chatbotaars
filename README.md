# Chatbot AARS - WhatsApp

Backend Node.js/Express para receber mensagens do WhatsApp Cloud API, classificar com OpenAI e salvar chamados no Supabase.

## Rodar local

```bash
npm install
npm run dev
```

## Variáveis necessárias no Railway

- SUPABASE_URL
- SUPABASE_SERVICE_ROLE_KEY
- OPENAI_API_KEY
- OPENAI_MODEL
- WHATSAPP_ACCESS_TOKEN
- WHATSAPP_VERIFY_TOKEN
- WHATSAPP_PHONE_NUMBER_ID

## Webhook Meta

Callback URL:

```text
https://SEU-DOMINIO.up.railway.app/webhook
```

Verify token:

```text
condominio_reserva_serra_token
```
