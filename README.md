# Backend AARS v3 - Railway

Esta versão transforma o chat em dois fluxos:

- **CONSULTA**: responde com base nos documentos oficiais e não abre chamado.
- **ATENDIMENTO**: registra solicitação/ocorrência e mantém o protocolo.
- **CONSULTA_ATENDIMENTO**: responde a regra e também registra a ocorrência.

A nomenclatura institucional foi alterada para **Associação / Associado**.

## 1. Documentos oficiais

A pasta local `knowledge/official` contém:

- `estatuto-social-aars.pdf`
- `regulamento-interno-aars.pdf`

Esses PDFs estão no `.gitignore` e **não devem ser enviados ao GitHub**.

## 2. Preparar a base documental uma única vez

Mantenha sua `.env` local com `OPENAI_API_KEY` e execute:

```bash
npm install
npm run knowledge:setup
```

O script:

1. envia os dois PDFs para o projeto da OpenAI;
2. cria um Vector Store;
3. indexa os documentos;
4. imprime três variáveis.

Copie as variáveis exibidas para o Railway:

```text
OPENAI_VECTOR_STORE_ID=vs_...
OPENAI_ESTATUTO_FILE_ID=file_...
OPENAI_RI_FILE_ID=file_...
```

O `OPENAI_ESTATUTO_FILE_ID` também é usado como fallback para consultas ao Estatuto, pois o PDF é digitalizado.

## 3. Deploy no Railway

Depois da configuração documental:

```bash
git add .
git commit -m "Adiciona base oficial Estatuto e Regulamento ao chat AARS"
git push
```

Os PDFs não aparecerão no commit porque estão ignorados.

## 4. Teste de saúde

Abra:

`https://chatbotaars-production.up.railway.app/api/health`

O esperado é:

```json
{
  "ok": true,
  "service": "AARS Atendimento Digital",
  "knowledgeConfigured": true
}
```

## 5. CORS

Para o site atual do Netlify use no Railway:

```text
WEB_ALLOWED_ORIGINS=https://aarsac.netlify.app
```

## Regras de resposta documental

O prompt foi configurado para:

- não inventar ou corrigir regras;
- preservar distinções existentes nos documentos;
- citar documento e item/artigo quando a fonte recuperada trouxer a referência;
- não aplicar penalidades nem declarar culpa;
- encaminhar para análise humana quando não houver base documental suficiente.
