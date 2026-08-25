const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanText(value, max = 800) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, max) : null;
}

function normalize(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-12).map((item) => ({
    role:
      item.role === "assistant" || item.sender === "assistant"
        ? "assistant"
        : "user",
    text: String(item.text || item.message || "").slice(0, 900),
  }));
}

function normalizeRelation(value) {
  const allowed = new Set([
    "DIRECT",
    "DETAIL",
    "CORRECTION",
    "EXAMPLE",
    "HYPOTHETICAL",
    "AMBIGUOUS_EXAMPLE",
    "NEW_OCCURRENCE",
  ]);
  const v = String(value || "DIRECT").toUpperCase();
  return allowed.has(v) ? v : "DIRECT";
}

function normalizeMode(value) {
  const allowed = new Set(["OPERATIONAL", "DOCUMENTARY", "MIXED"]);
  const v = String(value || "OPERATIONAL").toUpperCase();
  return allowed.has(v) ? v : "OPERATIONAL";
}

function isExplicitExample(text) {
  const t = normalize(text);
  return /\b(so um exemplo|só um exemplo|apenas um exemplo|como exemplo|por exemplo|foi um exemplo|era um exemplo)\b/.test(t);
}

function isHypothetical(text) {
  const t = normalize(text);
  return /\b(se acontecer|caso aconteca|caso aconteça|pode acontecer|poderia acontecer|se alguem|se alguém|como vao|como vão|o que fariam|como procederiam)\b/.test(t);
}

function isCorrection(text) {
  const t = normalize(text);
  return /^(nao e|não é|na verdade|corrigindo|quis dizer|nao quis dizer|não quis dizer)\b/.test(t);
}

function likelyDocumentaryQuestion(text) {
  const t = normalize(text);
  if (!t) return false;
  if (/\b(estatuto|regulamento interno|\bri\b|artigo|norma|regra|penalidade|multa|infracao|infração)\b/.test(t)) return true;
  if (/\b(horario|horário|capacidade|permitido|proibido|pode usar|pode entrar|quantos convidados)\b/.test(t)) return true;
  return false;
}

function lastAssistantQuestion(history = []) {
  const items = normalizeHistory(history);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].role === "assistant" && items[i].text.includes("?")) {
      return items[i].text;
    }
  }
  return null;
}

function fallbackAnalysis({ message, history = [], ticket = null, classification = {}, resident = {} }) {
  const text = normalize(message);
  const lastQuestion = lastAssistantQuestion(history);
  let relation = "DIRECT";

  if (isExplicitExample(text)) relation = "EXAMPLE";
  else if (isHypothetical(text)) relation = "HYPOTHETICAL";
  else if (isCorrection(text)) relation = "CORRECTION";
  else if (ticket && lastQuestion && text.length <= 220) relation = "DETAIL";

  const documentary = likelyDocumentaryQuestion(text);
  const explicitClosure = /\b(nao lembro de nada diferente|não lembro de nada diferente|nada mais|so isso|só isso|por enquanto e isso|por enquanto é isso)\b/.test(text);
  const enough = Boolean(
    ticket &&
    (explicitClosure || relation === "EXAMPLE" || relation === "HYPOTHETICAL" || relation === "CORRECTION" || text.length >= 45)
  );

  const fallbackSummary =
    relation === "EXAMPLE" || relation === "HYPOTHETICAL"
      ? ticket?.summary || classification.summary || message
      : classification.summary || ticket?.summary || message;

  return {
    mode: documentary ? "DOCUMENTARY" : "OPERATIONAL",
    relation,
    sameSubject: relation !== "NEW_OCCURRENCE",
    intakeComplete: enough || Boolean(classification.intake_complete),
    needsSeparateOccurrenceClarification: false,
    nextQuestion: enough ? null : cleanText(classification.next_question || null, 300),
    actionableSummary: cleanText(fallbackSummary, 500),
    responseNote: null,
    reason: "fallback local",
  };
}

async function analyzeOperationalConversation({
  message,
  history = [],
  ticket = null,
  tickets = [],
  classification = {},
  resident = {},
}) {
  const explicitExample = isExplicitExample(message);
  const hypothetical = isHypothetical(message);
  const correction = isCorrection(message);

  const prompt = `
Você controla a QUALIDADE DA CONVERSA de um atendimento operacional da AARS.
Seu objetivo é evitar interrogatórios desnecessários e produzir uma OS clara e acionável.

PRINCÍPIOS OBRIGATÓRIOS:
1. Uma OS existente JÁ É UM REGISTRO. Nunca sugira "posso registrar?", "gostaria que registrasse?" ou equivalente se ticket.protocol existir.
2. Diferencie o ASSUNTO PRINCIPAL de exemplos, hipóteses e casos passados usados apenas para explicar uma preocupação.
3. Marcadores como "por exemplo", "foi só um exemplo", "caso aconteça", "como já aconteceu em outras casas" normalmente NÃO criam nova ocorrência.
4. Se um fato passado pode ser tanto uma ocorrência separada quanto apenas um exemplo e o usuário não deixou claro, use AMBIGUOUS_EXAMPLE e pergunte UMA ÚNICA vez se ele quer registrá-lo separadamente.
   Exemplo: se o assunto principal é cobertura de câmeras e o associado cita uma bola levada da garagem apenas para ilustrar o risco, não transforme isso automaticamente em uma investigação de furto.
5. Se o usuário corrige uma interpretação (ex.: "não é pelos fundos, é pela frente"), trate como CORRECTION, atualize o entendimento e não reinicie a coleta.
6. Faça no máximo UMA pergunta por resposta.
7. Pare de perguntar assim que houver informação suficiente para a equipe agir.
8. Considere suficiente quando houver: problema/objetivo operacional claro + local ou referência razoável + providência pretendida ou avaliação esperada. A unidade do associado pode servir como referência de local quando fizer sentido.
9. Não investigue data, horário, autor ou detalhes de um fato antigo se ele foi mencionado apenas como exemplo.
10. Perguntas técnicas operacionais como "por que a câmera está assim?" ou "como a segurança vai identificar?" NÃO são automaticamente perguntas documentais. Use DOCUMENTARY apenas quando a resposta depende de Estatuto, RI, regra, horário, capacidade, permissão, penalidade ou norma oficial.
11. Nunca invente critérios técnicos, políticas, decisões ou fatos que não estejam no histórico.
12. O resumo deve ser curto, técnico e orientado à ação, descrevendo o que a equipe precisa avaliar/fazer. Evite frases vagas como "solicitação conforme informado".

MODOS:
- OPERATIONAL: assunto técnico/operacional; não precisa consultar documentos oficiais.
- DOCUMENTARY: pergunta sobre norma/documento oficial.
- MIXED: há ao mesmo tempo pergunta documental e solicitação operacional.

RELAÇÕES:
- DIRECT: mensagem principal da solicitação.
- DETAIL: complemento/resposta à pergunta anterior.
- CORRECTION: corrige entendimento anterior.
- EXAMPLE: exemplo explicitamente declarado.
- HYPOTHETICAL: hipótese futura usada para explicar risco/preocupação.
- AMBIGUOUS_EXAMPLE: fato pode ser exemplo ou nova ocorrência e precisa de uma única clarificação.
- NEW_OCCURRENCE: usuário claramente quer registrar outro fato independente.

ASSOCIADO:
${JSON.stringify({ name: resident?.name || null, unit: resident?.unit || null }, null, 2)}

OS ATIVA:
${JSON.stringify(ticket ? {
  id: ticket.id,
  protocol: ticket.protocol,
  category: ticket.category,
  summary: ticket.summary,
  description: ticket.description,
  status: ticket.status,
} : null, null, 2)}

OUTRAS OS DA MESMA CONVERSA:
${JSON.stringify((tickets || []).filter((x) => !ticket || x.id !== ticket.id).slice(-8).map((x) => ({
  id: x.id,
  protocol: x.protocol,
  category: x.category,
  summary: x.summary,
  status: x.status,
})), null, 2)}

HISTÓRICO RECENTE:
${JSON.stringify(normalizeHistory(history), null, 2)}

CLASSIFICAÇÃO ATUAL:
${JSON.stringify({
  intent: classification.intent,
  category: classification.category,
  priority: classification.priority,
  summary: classification.summary,
  intake_complete: classification.intake_complete,
  next_question: classification.next_question,
}, null, 2)}

MENSAGEM ATUAL:
${JSON.stringify(String(message || "").slice(0, 2000))}

Retorne SOMENTE JSON válido:
{
  "mode": "OPERATIONAL|DOCUMENTARY|MIXED",
  "relation": "DIRECT|DETAIL|CORRECTION|EXAMPLE|HYPOTHETICAL|AMBIGUOUS_EXAMPLE|NEW_OCCURRENCE",
  "same_subject": true,
  "intake_complete": true,
  "needs_separate_occurrence_clarification": false,
  "next_question": null,
  "actionable_summary": "resumo técnico e acionável da OS",
  "response_note": null,
  "reason": "explicação curta"
}

Regras para response_note:
- Use somente se o usuário fez uma pergunta operacional direta cuja causa/critério não pode ser afirmada com os dados disponíveis.
- Nesse caso escreva uma frase curta como: "Não tenho informações técnicas suficientes para afirmar por que essa configuração foi adotada."
- Nunca invente a resposta.
`;

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt,
    });
    const raw = String(response.output_text || "").trim();
    const clean = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const data = JSON.parse(clean);

    let relation = normalizeRelation(data.relation);
    if (explicitExample) relation = "EXAMPLE";
    else if (correction) relation = "CORRECTION";
    else if (hypothetical && relation !== "NEW_OCCURRENCE") relation = "HYPOTHETICAL";

    let mode = normalizeMode(data.mode);
    if (!likelyDocumentaryQuestion(message) && mode === "DOCUMENTARY" && relation !== "DIRECT") {
      mode = "OPERATIONAL";
    }

    const sameSubject = relation === "NEW_OCCURRENCE" ? false : data.same_subject !== false;
    const clarification = relation === "AMBIGUOUS_EXAMPLE" || Boolean(data.needs_separate_occurrence_clarification);
    let nextQuestion = cleanText(data.next_question, 320);
    if (clarification) {
      nextQuestion = "Esse fato que você mencionou foi apenas um exemplo da sua preocupação ou você quer registrá-lo como uma ocorrência separada?";
    }

    return {
      mode,
      relation,
      sameSubject,
      intakeComplete: clarification ? false : Boolean(data.intake_complete),
      needsSeparateOccurrenceClarification: clarification,
      nextQuestion,
      actionableSummary: cleanText(data.actionable_summary, 600),
      responseNote: cleanText(data.response_note, 320),
      reason: cleanText(data.reason, 300) || "análise operacional",
    };
  } catch (error) {
    console.warn("Falha na politica de conversa operacional:", { message: error.message, status: error.status });
    return fallbackAnalysis({ message, history, ticket, classification, resident });
  }
}

function shouldForceContinuation(policy, ticket) {
  if (!ticket || !policy) return false;
  return ["DETAIL", "CORRECTION", "EXAMPLE", "HYPOTHETICAL", "AMBIGUOUS_EXAMPLE"].includes(policy.relation);
}

function shouldUseOfficialDocuments(classification = {}, policy = null) {
  if (!policy) {
    return classification.intent === "CONSULTA" || classification.intent === "CONSULTA_ATENDIMENTO";
  }
  if (policy.mode === "DOCUMENTARY" || policy.mode === "MIXED") return true;
  return classification.intent === "CONSULTA" && policy.mode !== "OPERATIONAL";
}

function buildOperationalPolicyReply({ policy, ticket, isNewTopic = false, hadExistingTickets = false }) {
  if (!policy || !ticket) return null;

  const protocol = ticket.protocol;
  const parts = [];

  if (isNewTopic && hadExistingTickets) {
    parts.push("Separei este assunto em uma nova solicitação para que ele possa ser acompanhado de forma independente.");
  }

  if (policy.responseNote) parts.push(policy.responseNote);

  if (policy.needsSeparateOccurrenceClarification) {
    parts.push(`Mantive o protocolo ${protocol} focado no assunto principal.`);
    parts.push(policy.nextQuestion);
    return parts.filter(Boolean).join("\n\n");
  }

  if (policy.intakeComplete || !policy.nextQuestion) {
    const summary = policy.actionableSummary || ticket.summary || "a solicitacao informada";
    parts.push(`Entendi. O protocolo ${protocol} está registrado com o seguinte encaminhamento: ${summary}`);
    parts.push("A equipe responsável fará a análise e o encaminhamento adequado. Se surgir uma informação nova e relevante sobre este mesmo assunto, pode enviá-la por aqui.");
    return parts.filter(Boolean).join("\n\n");
  }

  parts.push(`O protocolo ${protocol} já está registrado.`);
  parts.push(policy.nextQuestion);
  return parts.filter(Boolean).join("\n\n");
}

module.exports = {
  analyzeOperationalConversation,
  shouldForceContinuation,
  shouldUseOfficialDocuments,
  buildOperationalPolicyReply,
  likelyDocumentaryQuestion,
};
