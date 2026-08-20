const institution = require("./institution");
const {
  openaiRequest,
  extractOutputText,
  extractFileCitations,
  extractFileSearchResults,
} = require("./openaiHttp");

function normalizeHistory(history = []) {
  return history.slice(-8).map((item) => ({
    sender:
      item.sender === "assistant" || item.role === "assistant"
        ? "Assistente"
        : "Associado",
    text: String(item.message || item.text || "").slice(0, 1000),
  }));
}

function friendlyDocumentName(filename = "") {
  const lower = filename.toLowerCase();
  if (lower.includes("regulamento")) return "Regulamento Interno";
  if (lower.includes("estatuto")) return "Estatuto Social";
  return filename || "Documento oficial da AARS";
}

function normalizeSources(citations = [], results = []) {
  const items = [];

  for (const c of citations) {
    items.push({
      fileId: c.fileId,
      label: friendlyDocumentName(c.filename),
      filename: c.filename,
    });
  }

  for (const r of results) {
    items.push({
      fileId: r.file_id || null,
      label: friendlyDocumentName(r.filename),
      filename: r.filename || "Documento oficial",
      score: typeof r.score === "number" ? r.score : null,
    });
  }

  const unique = new Map();
  items.forEach((item) => {
    const key = item.fileId || item.filename || item.label;
    if (!unique.has(key)) unique.set(key, item);
  });

  return [...unique.values()].slice(0, 4);
}

function buildGroundingPrompt({ question, history, resident, scope }) {
  return `
Você é o Assistente Virtual da ${institution.legalName} (${institution.shortName}).
A organização é uma ASSOCIAÇÃO. Dirija-se ao usuário como ASSOCIADO quando precisar usar uma designação institucional. Nunca use "condomínio" ou "condômino" como nomenclatura institucional.

Sua tarefa é responder EXCLUSIVAMENTE com base nos documentos oficiais disponibilizados pela AARS.

DOCUMENTOS OFICIAIS:
- Estatuto Social da Associação dos Amigos do Reserva da Serra.
- Regulamento Interno vigente do Reserva da Serra, incluindo sua tabela de infrações.

ESCOPO PROVÁVEL DA PERGUNTA: ${scope || "AMBOS"}

DADOS DO ASSOCIADO:
Nome: ${resident?.name || "não informado"}
Unidade/Casa: ${resident?.unit || "não informada"}

HISTÓRICO RECENTE:
${JSON.stringify(normalizeHistory(history), null, 2)}

PERGUNTA ATUAL:
${JSON.stringify(question)}

REGRAS OBRIGATÓRIAS:
1. Não invente, complete, modernize ou corrija regras dos documentos.
2. Preserve o sentido da regra oficial, mas explique em português claro e breve.
3. Se a resposta depender de uma distinção entre associado, morador, locatário, dependente, visitante ou prestador, preserve essa distinção conforme o documento.
4. Não aplique penalidade, não declare culpa e não diga que alguém "será multado". Você pode informar como uma conduta está classificada no documento e explicar que a aplicação segue o procedimento competente da Associação.
5. Se houver regra suficiente, termine com uma linha curta no formato: "Fonte: [nome do documento] — [item/artigo exatamente como aparece na fonte]". Não invente número de item/artigo. Se o número não estiver claro no trecho recuperado, cite apenas o nome do documento.
6. Se os documentos recuperados não forem suficientes para responder com segurança, responda EXATAMENTE começando por: "SEM_BASE_DOCUMENTAL:" e explique, em uma frase, que não foi localizada previsão específica e que a dúvida pode ser encaminhada à Associação.
7. Não use conhecimento geral para preencher lacunas.
8. Seja objetivo para leitura em celular.
`;
}

async function searchOfficialKnowledge({ question, history = [], resident = {}, scope = "AMBOS" }) {
  const vectorStoreId = process.env.OPENAI_VECTOR_STORE_ID;
  if (!vectorStoreId) {
    return {
      available: false,
      grounded: false,
      answer: "A base documental ainda não foi configurada no servidor.",
      sources: [],
    };
  }

  const body = {
    model:
      process.env.OPENAI_KNOWLEDGE_MODEL ||
      process.env.OPENAI_MODEL ||
      "gpt-4.1-mini",
    input: buildGroundingPrompt({ question, history, resident, scope }),
    tools: [
      {
        type: "file_search",
        vector_store_ids: [vectorStoreId],
        max_num_results: 8,
        ranking_options: {
          score_threshold: 0.18,
        },
      },
    ],
    include: ["file_search_call.results"],
  };

  const response = await openaiRequest("/responses", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const answer = extractOutputText(response);
  const results = extractFileSearchResults(response);
  const citations = extractFileCitations(response);
  const sources = normalizeSources(citations, results);
  const grounded = Boolean(answer) && !answer.startsWith("SEM_BASE_DOCUMENTAL:");

  return {
    available: true,
    grounded,
    answer: answer || "SEM_BASE_DOCUMENTAL: não foi possível localizar uma resposta documental.",
    sources,
    results,
  };
}

async function directPdfFallback({ question, history = [], resident = {}, scope = "AMBOS" }) {
  const fileIds = [];

  if (scope === "ESTATUTO" || scope === "AMBOS") {
    if (process.env.OPENAI_ESTATUTO_FILE_ID) fileIds.push(process.env.OPENAI_ESTATUTO_FILE_ID);
  }
  if (scope === "RI" || scope === "AMBOS") {
    if (process.env.OPENAI_RI_FILE_ID) fileIds.push(process.env.OPENAI_RI_FILE_ID);
  }

  if (!fileIds.length) {
    return {
      grounded: false,
      answer:
        "SEM_BASE_DOCUMENTAL: não foi localizada previsão específica nos documentos configurados.",
      sources: [],
    };
  }

  const content = [
    {
      type: "input_text",
      text: `${buildGroundingPrompt({ question, history, resident, scope })}\n\nAnalise diretamente os PDFs anexados nesta solicitação.`,
    },
    ...fileIds.map((fileId) => ({ type: "input_file", file_id: fileId })),
  ];

  const response = await openaiRequest("/responses", {
    method: "POST",
    body: JSON.stringify({
      model:
        process.env.OPENAI_KNOWLEDGE_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-4.1-mini",
      input: [{ role: "user", content }],
    }),
  });

  const answer = extractOutputText(response);
  const citations = extractFileCitations(response);

  return {
    grounded: Boolean(answer) && !answer.startsWith("SEM_BASE_DOCUMENTAL:"),
    answer: answer || "SEM_BASE_DOCUMENTAL: não foi possível localizar uma resposta documental.",
    sources: normalizeSources(citations, []),
  };
}

async function answerFromOfficialDocuments(args) {
  try {
    const primary = await searchOfficialKnowledge(args);
    if (primary.grounded) return primary;

    // O Estatuto é um PDF digitalizado. Se a busca vetorial não encontrar base suficiente,
    // o fallback envia o PDF oficial diretamente ao modelo apenas nessa consulta.
    const fallback = await directPdfFallback(args);
    if (fallback.grounded) return { available: true, ...fallback };

    return {
      available: primary.available,
      grounded: false,
      answer:
        "Não localizei nos documentos oficiais uma previsão específica que responda a essa situação com segurança. Posso registrar a dúvida para análise da Associação.",
      sources: primary.sources || [],
    };
  } catch (error) {
    console.error("Erro na base documental:", {
      message: error.message,
      status: error.status,
      data: error.data,
    });

    return {
      available: false,
      grounded: false,
      answer:
        "Não consegui consultar os documentos oficiais agora. Posso registrar a dúvida para análise da Associação.",
      sources: [],
    };
  }
}

module.exports = { answerFromOfficialDocuments };
