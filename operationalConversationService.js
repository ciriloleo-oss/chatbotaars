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
  return (Array.isArray(history) ? history : []).slice(-14).map((item) => ({
    role:
      item.role === "assistant" || item.sender === "assistant"
        ? "assistant"
        : "user",
    text: String(item.text || item.message || "").slice(0, 1000),
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

function recentAssistantQuestionCount(history = []) {
  const items = normalizeHistory(history);
  let count = 0;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (item.role === "assistant" && item.text.includes("?")) count += 1;
    if (count >= 3) break;
  }
  return count;
}

function isCftvCoverageCase(message, history = [], ticket = null) {
  const text = normalize([
    ticket?.summary || "",
    ticket?.description || "",
    ...(normalizeHistory(history).map((x) => x.text)),
    message || "",
  ].join(" "));
  const camera = /\b(camera|cameras|cftv|filmagem|campo de visao|campo de visão|ponto cego|cobertura)\b/.test(text);
  const coverage = /\b(final da rua|fim da rua|apontad|sentido contrario|sentido contrário|nao pega|não pega|fora do campo|cobertura parcial|cobertura total|ultimas casas|últimas casas|residencia|residência|vizinhos)\b/.test(text);
  return camera && coverage;
}

function hasCftvPositionDetail(message, history = []) {
  const text = normalize([
    ...(normalizeHistory(history).filter((x) => x.role === "user").map((x) => x.text)),
    message || "",
  ].join(" "));
  return /\b(aponta|apontada|apontado|sentido contrario|sentido contrário|antes da minha|antes da residencia|antes da residência|fora do campo|nao pega minha|não pega minha|nao pega as|não pega as|cobertura parcial|cobertura total|pega so|pega só|ultimas casas|últimas casas)\b/.test(text);
}

function neutralCftvSummary(resident = {}) {
  const unit = cleanText(resident?.unit, 80);
  const where = unit ? ` na região da unidade ${unit}` : " no local informado";
  return `Avaliar a cobertura de CFTV${where}, verificando o campo de visão da câmera existente, possíveis pontos cegos e eventual necessidade de ajuste ou ampliação após análise técnica.`;
}

function applyDeterministicQualityGuards(result, { message, history = [], ticket = null, resident = {} }) {
  const guarded = { ...result };

  // Caso de regressão importante: dúvidas sobre cobertura de CFTV não devem encerrar
  // antes de sabermos se existe cobertura total, parcial ou ausência de campo de visão.
  // Também não devemos prescrever instalação/realocação antes da análise técnica.
  if (isCftvCoverageCase(message, history, ticket)) {
    guarded.mode = "OPERATIONAL";
    guarded.actionableSummary = neutralCftvSummary(resident);

    const hasPosition = hasCftvPositionDetail(message, history);
    const questionsAlreadyAsked = recentAssistantQuestionCount(history);

    if (!hasPosition && questionsAlreadyAsked < 2) {
      guarded.intakeComplete = false;
      guarded.nextQuestion = "A câmera atual deixa sua residência e as últimas casas totalmente fora do campo de visão ou existe alguma cobertura parcial?";
    } else {
      guarded.intakeComplete = true;
      guarded.nextQuestion = null;
      if (ticket && lastAssistantQuestion(history)) guarded.relation = "DETAIL";
    }

    const asksCauseNow = /\b(por que|porque|qual motivo|motivo)\b/.test(normalize(message));
    if (asksCauseNow && !guarded.responseNote) {
      guarded.responseNote = "Não tenho informações técnicas suficientes para afirmar por que a configuração atual das câmeras foi adotada.";
    } else if (!asksCauseNow) {
      guarded.responseNote = null;
    }
  }

  // Uma OS já existente nunca volta a perguntar se o usuário quer registrá-la.
  if (ticket?.protocol && guarded.nextQuestion && /\b(registrar|abrir (um )?registro|abrir (uma )?solicitacao|abrir (uma )?solicitação)\b/i.test(guarded.nextQuestion)) {
    guarded.nextQuestion = null;
    guarded.intakeComplete = true;
  }

  return guarded;
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

  return applyDeterministicQualityGuards({
    mode: documentary ? "DOCUMENTARY" : "OPERATIONAL",
    relation,
    sameSubject: relation !== "NEW_OCCURRENCE",
    intakeComplete: enough || Boolean(classification.intake_complete),
    needsSeparateOccurrenceClarification: false,
    nextQuestion: enough ? null : cleanText(classification.next_question || null, 300),
    actionableSummary: cleanText(fallbackSummary, 500),
    responseNote: null,
    reason: "fallback local",
  }, { message, history, ticket, resident });
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
Seu objetivo é obter a MENOR quantidade de informação que permita uma primeira ação útil da equipe, sem encerrar cedo demais e sem transformar a conversa em interrogatório.

PRINCÍPIOS OBRIGATÓRIOS:
1. Uma OS existente JÁ É UM REGISTRO. Nunca sugira "posso registrar?", "gostaria que registrasse?" ou equivalente se ticket.protocol existir.
2. Diferencie o ASSUNTO PRINCIPAL de exemplos, hipóteses e casos passados usados apenas para explicar uma preocupação.
3. Marcadores como "por exemplo", "foi só um exemplo", "caso aconteça", "como já aconteceu em outras casas" normalmente NÃO criam nova ocorrência.
4. Se um fato passado pode ser tanto uma ocorrência separada quanto apenas um exemplo e o usuário não deixou claro, use AMBIGUOUS_EXAMPLE e pergunte UMA ÚNICA vez se ele quer registrá-lo separadamente.
5. Se o usuário corrige uma interpretação, trate como CORRECTION, atualize o entendimento e não reinicie a coleta.
6. Faça no máximo UMA pergunta por resposta.
7. Use o critério VALOR DA INFORMAÇÃO: só pergunte algo se a resposta puder mudar materialmente a primeira ação, prioridade, local de atuação ou tipo de avaliação da equipe.
8. Pare de perguntar quando já houver: problema/objetivo claro + referência de local suficiente + contexto mínimo para a equipe iniciar a avaliação.
9. A unidade do associado pode servir como referência de local quando fizer sentido. Não peça endereço completo se a unidade já resolve a localização inicial.
10. NÃO encerre cedo demais. Se ainda faltar UMA informação curta que muda de forma importante a avaliação técnica, faça essa pergunta e então encerre após a resposta.
11. Não investigue data, horário, autor ou detalhes de um fato antigo se ele foi mencionado apenas como exemplo.
12. Perguntas técnico-operacionais como "por que a câmera está assim?" ou "como a segurança vai identificar?" NÃO são automaticamente documentais.
13. Nunca invente critérios técnicos, políticas, decisões ou fatos que não estejam no histórico.
14. O resumo deve ser curto, técnico, NEUTRO e orientado à ação. Descreva a condição observada e o que deve ser AVALIADO.
15. Não prescreva solução antes da análise técnica. Ex.: não determine "instalar câmera" ou "realocar câmera" se o associado apenas relatou falta de cobertura. Prefira "avaliar cobertura, campo de visão, pontos cegos e eventual necessidade de ajuste ou ampliação".
16. Se o usuário perguntou a CAUSA de uma configuração técnica e não há dados para explicá-la, use response_note curto e transparente, sem inventar justificativa.
17. Evite repetir avisos documentais e frases burocráticas. A conversa deve soar natural, objetiva e profissional.

REGRA ESPECIAL DE COBERTURA / CFTV:
Se o associado questiona falta de câmera, posição, sentido ou cobertura de CFTV, uma informação costuma ter alto valor: se a câmera existente deixa o local totalmente fora do campo de visão ou se existe cobertura parcial.
- Se isso ainda NÃO estiver claro, faça UMA pergunta sobre cobertura total/parcial/campo de visão.
- Se o associado já explicou a posição/sentido da câmera e o ponto cego, considere a coleta suficiente e encerre.
- O resumo nunca deve assumir que a solução será instalar ou realocar câmera antes da análise técnica.

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
  "actionable_summary": "resumo técnico, neutro e acionável da OS",
  "response_note": null,
  "reason": "explicação curta"
}

Regras para next_question:
- Deve ser uma única pergunta curta.
- Só faça se a resposta tiver valor operacional real.
- Não pergunte algo já respondido no histórico.

Regras para actionable_summary:
- Registre o PROBLEMA/CONDIÇÃO e a AVALIAÇÃO esperada.
- Não transforme uma hipótese de solução em decisão já tomada.
- Evite termos emocionais/vagos como "preocupação contínua" quando há uma demanda técnica concreta.

Regras para response_note:
- Use somente se o usuário fez uma pergunta operacional direta cuja causa/critério não pode ser afirmada com os dados disponíveis.
- Ex.: "Não tenho informações técnicas suficientes para afirmar por que essa configuração foi adotada."
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

    const result = {
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

    return applyDeterministicQualityGuards(result, { message, history, ticket, resident });
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

  const summary = policy.actionableSummary || ticket.summary || "a solicitação informada";
  const relation = policy.relation || "DIRECT";

  if (!policy.intakeComplete && policy.nextQuestion) {
    if (!hadExistingTickets) {
      parts.push(`Registrei o protocolo ${protocol} para ${lowercaseFirst(summary)}`);
    } else if (["DETAIL", "CORRECTION"].includes(relation)) {
      parts.push(`Atualizei o protocolo ${protocol} com essa informação.`);
    } else {
      parts.push(`O protocolo ${protocol} segue registrado para ${lowercaseFirst(summary)}`);
    }
    parts.push(`Para complementar a avaliação: ${policy.nextQuestion}`);
    return parts.filter(Boolean).join("\n\n");
  }

  if (["DETAIL", "CORRECTION"].includes(relation) && hadExistingTickets) {
    parts.push(`Perfeito. Acrescentei essa informação ao protocolo ${protocol}.`);
  } else if (!hadExistingTickets) {
    parts.push(`Registrei o protocolo ${protocol} para ${lowercaseFirst(summary)}`);
  } else {
    parts.push(`O protocolo ${protocol} está atualizado para ${lowercaseFirst(summary)}`);
  }

  parts.push("A solicitação está completa para a primeira análise da equipe responsável.");
  return parts.filter(Boolean).join("\n\n");
}

function lowercaseFirst(text) {
  const value = String(text || "").trim();
  if (!value) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

module.exports = {
  analyzeOperationalConversation,
  shouldForceContinuation,
  shouldUseOfficialDocuments,
  buildOperationalPolicyReply,
  likelyDocumentaryQuestion,
};
