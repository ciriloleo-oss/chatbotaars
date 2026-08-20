const institution = require("./institution");
const { naturalizeUserAddress } = require("./languagePolicy");
const {
  openaiRequest,
  extractOutputText,
  extractFileCitations,
  extractFileSearchResults,
} = require("./openaiHttp");
const {
  detectKnowledgeTopic,
  buildTopicInstruction,
  answerLeaksTopic,
} = require("./knowledgeTopics");

function normalizeHistory(history = []) {
  return history.slice(-8).map((item) => ({
    sender:
      item.sender === "assistant" || item.role === "assistant"
        ? "Assistente"
        : "Usuário",
    text: String(item.message || item.text || "").slice(0, 1000),
  }));
}

function friendlyDocumentName(filename = "") {
  const lower = filename.toLowerCase();
  if (lower.includes("regulamento") || lower.includes("ri 2025")) {
    return "Regulamento Interno";
  }
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

function retrievalHints(question = "", topic = null) {
  const q = String(question).toLowerCase();
  const hints = [];

  if (/até que horas|a que horas|hor[aá]rio|funciona|funcionamento|abre|fecha|usar|utilizar/.test(q)) {
    hints.push("horário de funcionamento; horário permitido; utilização; uso");
  }
  if (/academia|gin[aá]stica/.test(q)) {
    hints.push("academia; uso da academia; sala de ginástica; item 9; 9.1");
  }
  if (/obra|reforma|manuten[cç][aã]o|servi[cç]o/.test(q)) {
    hints.push("obras e reformas; horários de trabalho; serviços; item 2");
  }
  if (/piscina/.test(q)) {
    hints.push("uso das piscinas; horário de funcionamento; item 7");
  }
  if (/churrasqueira/.test(q)) {
    hints.push("uso das churrasqueiras; reserva; horário; item 8");
  }
  if (/sal[aã]o|festa|evento/.test(q)) {
    hints.push("salões de festas; eventos; horário; reserva; item 16");
  }
  if (/quadra|futebol|t[eê]nis/.test(q)) {
    hints.push("quadras; campos; horário de utilização; reserva");
  }
  if (/lago|pesca/.test(q)) {
    hints.push("uso do lago; pesca; horário; item 14");
  }
  if (/visitante|prestador|portaria|acesso|corretor/.test(q)) {
    hints.push("portaria; identificação; acesso; visitantes; prestadores; item 4");
  }
  if (/barulho|ru[ií]do|sil[eê]ncio|som alto|decib/.test(q)) {
    hints.push("perturbação da ordem; ruído; silêncio; decibéis; item 20");
  }
  if (/animal|cachorro|c[aã]o|gato|guia|focinheira/.test(q)) {
    hints.push("animais domésticos; guia; focinheira; item 18; tabela de infrações");
  }
  if (/multa|penalidade|infra[cç][aã]o|advert[eê]ncia|recurso/.test(q)) {
    hints.push("penalidades e defesas; tabela de infrações; artigo 53 do Estatuto");
  }

  if (topic?.focus) hints.unshift(topic.focus);

  return hints.join(" | ");
}

function hasNegativeGroundingSignal(answer = "") {
  const text = String(answer).toLowerCase();
  return [
    "sem_base_documental:",
    "não localizei nos documentos",
    "não encontrei nos documentos",
    "não foi localizada previsão",
    "não há uma previsão específica",
    "não há previsão específica",
    "não traz uma regra específica",
    "não consta uma regra específica",
    "sem previsão específica",
    "não encontrei uma regra específica",
    "não localizei uma regra específica",
  ].some((phrase) => text.includes(phrase));
}

function stripRepeatedGreeting(text = "", residentName = "", history = []) {
  let output = String(text || "").trim();
  if (!output || !history.length) return output;

  const firstName = String(residentName || "").trim().split(/\s+/)[0] || "";
  const escapedName = firstName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const patterns = [
    new RegExp(`^(olá|oi)\\s*,?\\s*${escapedName ? `${escapedName}\\s*[!,.:-]?\\s*` : ""}`, "i"),
    /^(bom dia|boa tarde|boa noite)\s*[!,.:-]?\s*/i,
  ];

  for (const pattern of patterns) {
    output = output.replace(pattern, "").trim();
  }

  if (output) {
    output = output.charAt(0).toUpperCase() + output.slice(1);
  }

  return output;
}

function postProcessAnswer(rawAnswer, resident, history) {
  const natural = naturalizeUserAddress(rawAnswer, resident?.name);
  return stripRepeatedGreeting(natural, resident?.name, history);
}


function parseJsonObject(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return null;

  const cleaned = text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function focusedDirectTopicLookup({
  question,
  history = [],
  resident = {},
  scope = "RI",
  topic,
}) {
  if (!topic) return { grounded: false, answer: "", sources: [] };

  const fileId =
    scope === "ESTATUTO"
      ? process.env.OPENAI_ESTATUTO_FILE_ID
      : process.env.OPENAI_RI_FILE_ID;

  if (!fileId) {
    return { grounded: false, answer: "", sources: [] };
  }

  const normalizedHistory = normalizeHistory(history);
  const topicInstruction = buildTopicInstruction(topic);

  const prompt = `
Você fará uma verificação documental estrita para a ${institution.shortName}.
Analise diretamente o PDF oficial anexado.

PERGUNTA ATUAL:
${JSON.stringify(question)}

HISTÓRICO RECENTE:
${JSON.stringify(normalizedHistory, null, 2)}

${topicInstruction}

REGRAS DE VERIFICAÇÃO:
1. Localize primeiro o título/seção correspondente ao ALVO DOCUMENTAL OBRIGATÓRIO.
2. Só depois extraia a regra que responde à pergunta.
3. Não use números, horários, limites, reservas, convidados ou condições de uma seção vizinha.
4. Uma página pode conter o final de uma seção e o começo de outra. Confira a numeração do item antes de usar qualquer informação.
5. Se o usuário empregar um apelido que não aparece como nome de instalação no documento, não transforme uma ocorrência incidental da palavra em nome oficial.
6. Não use conhecimento geral.
7. Não invente item ou artigo.
8. Responda de forma curta e natural, sem saudação e sem usar "Associado" como vocativo.

Retorne SOMENTE JSON válido neste formato:
{
  "grounded": true,
  "needs_clarification": false,
  "reference": "item ou artigo exato, sem inventar",
  "answer": "resposta direta, sem linha de fonte"
}

Se a seção correta não sustentar a resposta, use grounded=false.
Se a pergunta depender de esclarecer qual instalação o usuário quis dizer, use needs_clarification=true e coloque em answer uma única pergunta breve de esclarecimento.
`;

  const response = await openaiRequest("/responses", {
    method: "POST",
    body: JSON.stringify({
      model:
        process.env.OPENAI_KNOWLEDGE_MODEL ||
        process.env.OPENAI_MODEL ||
        "gpt-4.1-mini",
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_file", file_id: fileId },
          ],
        },
      ],
    }),
  });

  const parsed = parseJsonObject(extractOutputText(response));
  if (!parsed || parsed.grounded !== true || !parsed.answer) {
    return { grounded: false, answer: "", sources: [] };
  }

  let answer = postProcessAnswer(parsed.answer, resident, history);
  if (answerLeaksTopic(answer, topic)) {
    console.warn("Base documental: resposta focada rejeitada por mistura de assunto.", {
      topic: topic.key,
    });
    return { grounded: false, answer: "", sources: [] };
  }

  const reference = String(parsed.reference || "").trim();
  const label = scope === "ESTATUTO" ? "Estatuto Social" : "Regulamento Interno";

  if (!parsed.needs_clarification) {
    answer = `${answer}\n\nFonte: ${label}${reference ? ` — ${reference}` : ""}`;
  }

  return {
    grounded: true,
    answer,
    sources: [{ fileId, label, filename: label }],
    focused: true,
    needsClarification: Boolean(parsed.needs_clarification),
  };
}

function buildGroundingPrompt({ question, history, resident, scope, topic = null }) {
  const normalizedHistory = normalizeHistory(history);
  const hints = retrievalHints(question, topic);
  const topicInstruction = buildTopicInstruction(topic);

  return `
Você é o Assistente Virtual da ${institution.legalName} (${institution.shortName}).
A organização é uma ASSOCIAÇÃO. Nunca use "condomínio" ou "condômino" como nomenclatura institucional.

TRATAMENTO DA PESSOA:
- Converse de forma natural e cordial.
- O usuário já foi saudado pela interface do chat. Se houver histórico, NÃO reinicie a resposta com "Olá", "Oi", "Bom dia", "Boa tarde" ou "Boa noite".
- Pode usar o primeiro nome ocasionalmente, mas não em todas as respostas.
- NÃO use "Associado" ou "Associada" como título ou vocativo.
- Use "associado", "morador", "locatário", "dependente", "visitante" ou "prestador" somente quando essa condição for necessária para explicar corretamente uma regra documental.

Sua tarefa é responder EXCLUSIVAMENTE com base nos documentos oficiais disponibilizados pela AARS.

DOCUMENTOS OFICIAIS:
- Estatuto Social da Associação dos Amigos do Reserva da Serra.
- Regulamento Interno vigente do Reserva da Serra, incluindo sua tabela de infrações.

${topicInstruction}

ESCOPO PROVÁVEL DA PERGUNTA: ${scope || "AMBOS"}

DADOS DA PESSOA ATENDIDA:
Nome: ${resident?.name || "não informado"}
Quadra e lote: ${resident?.unit || "não informado"}

HISTÓRICO RECENTE:
${JSON.stringify(normalizedHistory, null, 2)}

PERGUNTA ATUAL:
${JSON.stringify(question)}

TERMOS DE BUSCA SUGERIDOS:
${hints || "Use o assunto principal e variações semânticas da pergunta."}

REGRAS DE BUSCA:
1. Faça a busca pelo ASSUNTO, e não apenas pelas palavras exatas usadas pelo usuário.
2. Perguntas coloquiais devem ser convertidas semanticamente. Exemplo: "até que horas posso usar a academia?" significa procurar por "horário de funcionamento / uso da academia".
3. Se a primeira formulação não localizar conteúdo suficiente, tente termos equivalentes, o nome da instalação/assunto e expressões como "horário", "uso", "funcionamento", "regras" ou o item correspondente quando indicado nos termos sugeridos.
4. Não conclua que não existe regra apenas porque a pergunta não usa a mesma redação do documento.

REGRAS DE RESPOSTA:
1. Não invente, complete, modernize ou corrija regras dos documentos.
2. Preserve o sentido da regra oficial, mas explique em português claro e breve.
3. Se a resposta depender de uma distinção entre associado, morador, locatário, dependente, visitante ou prestador, preserve essa distinção conforme o documento.
4. Não aplique penalidade, não declare culpa e não diga que alguém "será multado". Você pode informar como uma conduta está classificada no documento e explicar que a aplicação segue o procedimento competente da Associação.
5. Se houver regra suficiente, termine com uma linha curta no formato: "Fonte: [nome do documento] — [item/artigo exatamente como aparece na fonte]". Não invente número de item/artigo. Se o número não estiver claro no trecho recuperado, cite apenas o nome do documento.
6. Se os documentos recuperados não forem suficientes para responder com segurança, responda EXATAMENTE começando por: "SEM_BASE_DOCUMENTAL:" e explique, em uma frase, que não foi localizada previsão específica e que a dúvida pode ser encaminhada à Associação.
7. Não use conhecimento geral para preencher lacunas.
8. Não diga "o regulamento que tenho aqui", "nos trechos que tenho", "na minha base" ou expressões semelhantes. Fale institucionalmente: "o Regulamento Interno estabelece...".
9. Seja objetivo para leitura em celular: dê primeiro a resposta direta, depois eventual condição/exceção e, por fim, a fonte.
`;
}

async function searchOfficialKnowledge({
  question,
  history = [],
  resident = {},
  scope = "AMBOS",
  topic = null,
}) {
  topic = topic || detectKnowledgeTopic(question);
  const effectiveScope = topic?.scope || scope;
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
    input: buildGroundingPrompt({
      question,
      history,
      resident,
      scope: effectiveScope,
      topic,
    }),
    tools: [
      {
        type: "file_search",
        vector_store_ids: [vectorStoreId],
        max_num_results: 12,
      },
    ],
    include: ["file_search_call.results"],
  };

  const response = await openaiRequest("/responses", {
    method: "POST",
    body: JSON.stringify(body),
  });

  const answer = postProcessAnswer(
    extractOutputText(response),
    resident,
    history
  );
  const results = extractFileSearchResults(response);
  const citations = extractFileCitations(response);
  const sources = normalizeSources(citations, results);
  const grounded =
    Boolean(answer) &&
    !hasNegativeGroundingSignal(answer) &&
    !answerLeaksTopic(answer, topic);

  return {
    available: true,
    grounded,
    answer:
      answer ||
      "SEM_BASE_DOCUMENTAL: não foi possível localizar uma resposta documental.",
    sources,
    results,
  };
}

async function directPdfFallback({
  question,
  history = [],
  resident = {},
  scope = "AMBOS",
  topic = null,
}) {
  topic = topic || detectKnowledgeTopic(question);
  scope = topic?.scope || scope;
  const fileIds = [];

  if (scope === "ESTATUTO" || scope === "AMBOS") {
    if (process.env.OPENAI_ESTATUTO_FILE_ID) {
      fileIds.push(process.env.OPENAI_ESTATUTO_FILE_ID);
    }
  }
  if (scope === "RI" || scope === "AMBOS") {
    if (process.env.OPENAI_RI_FILE_ID) {
      fileIds.push(process.env.OPENAI_RI_FILE_ID);
    }
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
      text: `${buildGroundingPrompt({
        question,
        history,
        resident,
        scope,
        topic,
      })}\n\nA busca vetorial anterior não foi conclusiva. Analise diretamente os PDFs oficiais anexados nesta solicitação antes de concluir que não existe previsão.`,
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

  const answer = postProcessAnswer(
    extractOutputText(response),
    resident,
    history
  );
  const citations = extractFileCitations(response);
  const grounded =
    Boolean(answer) &&
    !hasNegativeGroundingSignal(answer) &&
    !answerLeaksTopic(answer, topic);

  return {
    grounded,
    answer:
      answer ||
      "SEM_BASE_DOCUMENTAL: não foi possível localizar uma resposta documental.",
    sources: normalizeSources(citations, []),
  };
}

async function answerFromOfficialDocuments(args) {
  try {
    const topic = detectKnowledgeTopic(args?.question || "");
    const scopedArgs = {
      ...args,
      scope: topic?.scope || args?.scope || "AMBOS",
      topic,
    };

    if (topic) {
      console.log("Base documental: assunto identificado.", {
        topic: topic.key,
        focus: topic.focus,
      });
    }

    // Para instalações e áreas com seções próprias no RI, prioriza leitura direta
    // da seção correta. Isso reduz mistura de horários/regras entre chunks vizinhos.
    if (topic?.directPdfFirst) {
      const focused = await focusedDirectTopicLookup(scopedArgs);
      if (focused.grounded) {
        return { available: true, ...focused };
      }

      console.log("Base documental: leitura focada inconclusiva; tentando busca vetorial.", {
        topic: topic.key,
      });
    }

    const primary = await searchOfficialKnowledge(scopedArgs);
    if (primary.grounded) return primary;

    console.log("Base documental: busca vetorial inconclusiva; usando leitura direta do PDF.");

    const fallback = await directPdfFallback(scopedArgs);
    if (fallback.grounded) return { available: true, ...fallback };

    return {
      available: primary.available,
      grounded: false,
      answer:
        "Não localizei nos documentos oficiais uma previsão específica que responda a essa situação com segurança. Posso registrar a dúvida para análise da Associação.",
      sources: [],
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
