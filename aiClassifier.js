const OpenAI = require("openai");
const institution = require("./institution");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY não configurada");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function normalizeHistory(history = []) {
  return history.slice(-12).map((item) => ({
    sender:
      item.sender === "assistant" || item.role === "assistant"
        ? "Assistente"
        : "Associado",
    message: String(item.message || item.text || "").slice(0, 1200),
  }));
}

function fallback(message) {
  const emergencyRegex =
    /\b(inc[eê]ndio|pegando fogo|fogo|invas[aã]o|agress[aã]o|amea[cç]a|acidente|viol[eê]ncia|socorro|emerg[eê]ncia|tentativa de furto)\b/i;
  const emergency = emergencyRegex.test(message);

  return {
    intent: "ATENDIMENTO",
    document_scope: "NENHUM",
    category: emergency ? "Emergência" : "Outros",
    priority: emergency ? "CRÍTICA" : "MÉDIA",
    responsible: emergency ? ["Supervisor de Segurança"] : ["Recepção"],
    requires_manager: false,
    requires_human: true,
    emergency,
    summary: message.slice(0, 300),
    intake_complete: emergency,
    next_question: emergency
      ? ""
      : "Pode me dar um pouco mais de detalhe sobre o que aconteceu?",
    suggested_reply: emergency
      ? "Identifiquei uma possível situação de emergência. Preserve sua segurança e mantenha distância do risco."
      : "Entendi sua solicitação.",
  };
}

async function classifyInteraction(message, history = [], resident = {}) {
  const context = normalizeHistory(history);

  const prompt = `
Você é o classificador de atendimento da ${institution.legalName} (${institution.shortName}).
A organização é uma ASSOCIAÇÃO. No atendimento institucional, chame o usuário de ASSOCIADO. Nunca use "condomínio" ou "condômino" como nomenclatura institucional.

DADOS JÁ CONHECIDOS:
Nome: ${resident.name || "não informado"}
Unidade/Casa: ${resident.unit || "não informada"}
Bloco/Setor: ${resident.block || "não informado"}
Telefone: ${resident.phone || "não informado"}

HISTÓRICO RECENTE:
${context.length ? JSON.stringify(context, null, 2) : "Sem histórico."}

MENSAGEM ATUAL:
${JSON.stringify(message)}

CLASSIFIQUE A INTENÇÃO:
- CONSULTA: pergunta sobre regras, horários, direitos, deveres, assembleias, áreas comuns, portaria, obras, animais, trânsito, penalidades, Estatuto ou Regulamento Interno, sem pedido de registrar ocorrência.
- ATENDIMENTO: relato de problema, solicitação operacional, reclamação, incidente, pedido de providência ou pedido explícito de registro.
- CONSULTA_ATENDIMENTO: a mensagem ao mesmo tempo pergunta sobre uma regra e relata uma situação que pode exigir providência.
- CONVERSA: saudação ou mensagem sem conteúdo suficiente para consulta ou atendimento.

ESCOPO DOCUMENTAL:
- RI: regras operacionais e de convivência do Regulamento Interno.
- ESTATUTO: direitos/deveres estatutários, quadro social, assembleias, administração, governança, contribuições, Regimento Interno e penalidades estatutárias.
- AMBOS: quando a resposta exige cruzar os dois documentos.
- NENHUM: quando não é uma consulta documental.

CATEGORIAS DE ATENDIMENTO:
Segurança
Emergência
Barulho
Portaria / Acesso
Manutenção
Limpeza
Área comum
Encomendas
Financeiro
Reclamação / SAC
Sugestão
Outros

ENCAMINHAMENTO:
- Segurança -> Supervisor de Segurança
- Emergência -> Supervisor de Segurança
- Barulho -> Supervisor de Segurança + Gestor
- Financeiro -> Administrador + Gestor
- Reclamação / SAC -> Gestor
- demais categorias -> Recepção, salvo necessidade evidente de outro responsável.

PRIORIDADES:
- CRÍTICA: incêndio, invasão, agressão, violência, acidente grave, emergência médica, tentativa de furto, ameaça ou risco imediato.
- ALTA: problema relevante de segurança, portão travado, vazamento grave, falta de energia em área comum, reclamação formal com risco relevante.
- MÉDIA: barulho, manutenção comum, dúvida financeira, problema operacional sem risco imediato.
- BAIXA: sugestão, elogio, pedido simples de informação.

CONDUÇÃO DO ATENDIMENTO:
Faça NO MÁXIMO UMA pergunta complementar por resposta. Não peça nome, unidade ou telefone se já foram informados acima.

Para BARULHO, priorize nesta ordem:
1. saber se está acontecendo neste momento;
2. local aproximado/origem;
3. horário aproximado de início.
Não pergunte o que já estiver claro no histórico.

Para SEGURANÇA, descubra local e se há risco imediato. Em emergência, não condicione o registro a perguntas complementares.

Para MANUTENÇÃO, descubra local e qual problema foi observado.

Para FINANCEIRO, identifique o assunto (boleto, pagamento, contribuição, cobrança etc.). Nunca peça senha, cartão, dados bancários completos ou credenciais.

Para RECLAMAÇÃO/SAC, obtenha fato, data/horário aproximado e local/setor quando necessários. Não faça interrogatório.

Para PORTARIA/ACESSO, entenda se é visitante, prestador, cadastro, autorização ou falha de acesso.

intake_complete deve ser true quando já há informação mínima suficiente para encaminhamento. Emergência sempre deve ser true.

Retorne SOMENTE JSON válido:
{
  "intent": "CONSULTA|ATENDIMENTO|CONSULTA_ATENDIMENTO|CONVERSA",
  "document_scope": "RI|ESTATUTO|AMBOS|NENHUM",
  "category": "",
  "priority": "BAIXA|MÉDIA|ALTA|CRÍTICA",
  "responsible": [],
  "requires_manager": false,
  "requires_human": false,
  "emergency": false,
  "summary": "",
  "intake_complete": false,
  "next_question": "",
  "suggested_reply": ""
}
`;

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt,
    });

    const raw = String(response.output_text || "").trim();
    const clean = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const result = JSON.parse(clean);

    return {
      intent: ["CONSULTA", "ATENDIMENTO", "CONSULTA_ATENDIMENTO", "CONVERSA"].includes(result.intent)
        ? result.intent
        : "ATENDIMENTO",
      document_scope: ["RI", "ESTATUTO", "AMBOS", "NENHUM"].includes(result.document_scope)
        ? result.document_scope
        : "NENHUM",
      category: result.category || "Outros",
      priority: result.priority || "MÉDIA",
      responsible: Array.isArray(result.responsible) ? result.responsible : ["Recepção"],
      requires_manager: Boolean(result.requires_manager),
      requires_human: Boolean(result.requires_human),
      emergency: Boolean(result.emergency),
      summary: result.summary || message.slice(0, 300),
      intake_complete: Boolean(result.intake_complete),
      next_question: String(result.next_question || "").trim(),
      suggested_reply: String(result.suggested_reply || "Entendi.").trim(),
    };
  } catch (error) {
    console.error("Erro OpenAI/classificação:", {
      message: error.message,
      status: error.status,
      code: error.code,
    });
    return fallback(message);
  }
}

function buildOperationalReply(classification, protocol) {
  if (classification.emergency) {
    return [
      "🚨 POSSÍVEL EMERGÊNCIA",
      "",
      classification.suggested_reply ||
        "Preserve sua segurança e mantenha distância do risco.",
      "",
      "Se houver risco imediato à vida, incêndio ou crime em andamento, acione também o serviço público de emergência apropriado.",
      protocol ? `Protocolo: ${protocol}` : null,
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (!classification.intake_complete && classification.next_question) {
    return `${classification.suggested_reply}\n\n${classification.next_question}`.trim();
  }

  return [
    classification.suggested_reply || "Sua solicitação foi registrada.",
    protocol ? `Protocolo: ${protocol}` : null,
  ]
    .filter(Boolean)
    .join("\n\n");
}

module.exports = {
  classifyInteraction,
  buildOperationalReply,
};
