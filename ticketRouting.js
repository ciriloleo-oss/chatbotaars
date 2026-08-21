const OpenAI = require("openai");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY não configurada");
}

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function normalize(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function normalizedHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-10).map((item) => ({
    role:
      item.role === "assistant" || item.sender === "assistant"
        ? "assistant"
        : item.role === "user" || item.sender === "resident"
          ? "user"
          : String(item.role || item.sender || "system"),
    text: String(item.text || item.message || "").slice(0, 900),
  }));
}

function ticketDigest(ticket) {
  return {
    id: ticket.id,
    protocol: ticket.protocol,
    category: ticket.category || "Outros",
    summary: String(ticket.summary || "").slice(0, 500),
    status: ticket.status || "Novo",
    created_at: ticket.created_at || null,
  };
}

function fallbackRouting({ message, classification = {}, tickets = [], activeTicketId, history = [] }) {
  const active = tickets.find((ticket) => ticket.id === activeTicketId) || tickets[tickets.length - 1] || null;
  if (!active) return { action: "NEW", targetTicketId: null, reason: "sem ticket existente" };

  const text = normalize(message);
  const currentCategory = normalize(classification.category || "");
  const activeCategory = normalize(active.category || "");
  const explicitNew = /\b(outro assunto|outra coisa|outra solicitacao|outra reclamacao|tambem preciso|tambem gostaria|alem disso|mais uma solicitacao|novo pedido|nova solicitacao)\b/.test(text);
  const obviousContinuation = /^(sim|nao|não|agora|ontem|hoje|isso|isso mesmo|correto|exato|ok|certo|perto|proximo|próximo|desde|por volta|na|no|em|quadra|lote)\b/.test(text);
  const lastAssistant = [...normalizedHistory(history)].reverse().find((item) => item.role === "assistant");
  const answeringQuestion = Boolean(lastAssistant?.text?.includes("?")) && text.length <= 180;

  if (explicitNew) {
    return { action: "NEW", targetTicketId: null, reason: "marcador explícito de novo assunto" };
  }

  if (
    currentCategory &&
    activeCategory &&
    currentCategory !== "outros" &&
    activeCategory !== "outros" &&
    currentCategory !== activeCategory
  ) {
    return { action: "NEW", targetTicketId: null, reason: "categoria diferente" };
  }

  if (obviousContinuation || answeringQuestion) {
    return { action: "CONTINUE", targetTicketId: active.id, reason: "resposta complementar" };
  }

  // Na dúvida, é mais seguro separar duas demandas do que misturá-las na mesma OS.
  return { action: "NEW", targetTicketId: null, reason: "fallback conservador" };
}

async function planTicketRouting({
  message,
  classification = {},
  tickets = [],
  activeTicketId = null,
  history = [],
}) {
  if (!Array.isArray(tickets) || tickets.length === 0) {
    return { action: "NEW", targetTicketId: null, reason: "primeira OS da conversa" };
  }

  const active = tickets.find((ticket) => ticket.id === activeTicketId) || tickets[tickets.length - 1];
  const validIds = new Set(tickets.map((ticket) => ticket.id));
  const recentHistory = normalizedHistory(history);

  const prompt = `
Você decide em qual Ordem de Serviço (OS) uma nova mensagem operacional deve entrar.

REGRA CENTRAL:
- UMA OS representa UM ÚNICO assunto operacional.
- Não misture solicitações independentes só porque são do mesmo associado, da mesma conversa ou da mesma categoria ampla.
- Dois problemas de Manutenção também podem exigir duas OS diferentes (ex.: vazamento e iluminação; grades e caixas de fibra).

DECIDA APENAS ENTRE:
- CONTINUE: a mensagem complementa, responde, detalha, corrige ou atualiza uma OS já existente nesta conversa.
- NEW: a mensagem inicia uma solicitação/reclamação/ocorrência operacional diferente das OS já existentes.

REGRAS IMPORTANTES:
1. Respostas a perguntas de coleta do atendimento, como local, horário, equipamento, confirmação, "sim", "não", "agora", devem continuar a OS correspondente.
2. Se o usuário muda de problema, objeto, local ou providência pretendida de forma independente, use NEW.
3. Se o usuário acabou de fazer uma CONSULTA sem OS e depois diz "registre", "abra registro", "sim" ou equivalente para formalizar aquele novo assunto, use NEW se esse assunto não corresponde à OS ativa.
4. O usuário pode retomar uma OS anterior. Nesse caso escolha CONTINUE e o id daquela OS, mesmo que ela não seja a OS ativa.
5. Não use a categoria isoladamente para decidir. Compare o assunto/resumo.
6. Na dúvida entre misturar assuntos e separar, prefira NEW.

OS ATIVA:
${JSON.stringify(ticketDigest(active), null, 2)}

OS EXISTENTES NESTA CONVERSA:
${JSON.stringify(tickets.map(ticketDigest), null, 2)}

HISTÓRICO RECENTE DA CONVERSA (inclui consultas que não viraram OS):
${JSON.stringify(recentHistory, null, 2)}

CLASSIFICAÇÃO OPERACIONAL DA MENSAGEM ATUAL:
${JSON.stringify({
  category: classification.category,
  summary: classification.summary,
  priority: classification.priority,
  intake_complete: classification.intake_complete,
}, null, 2)}

MENSAGEM ATUAL:
${JSON.stringify(message)}

Retorne SOMENTE JSON válido neste formato:
{
  "action": "CONTINUE|NEW",
  "target_ticket_id": "id exato de uma OS existente quando CONTINUE; vazio quando NEW",
  "reason": "explicação curta"
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
    const action = result.action === "CONTINUE" ? "CONTINUE" : "NEW";
    const targetTicketId = String(result.target_ticket_id || "").trim();

    if (action === "CONTINUE" && validIds.has(targetTicketId)) {
      return {
        action,
        targetTicketId,
        reason: String(result.reason || "continuação identificada").slice(0, 300),
      };
    }

    if (action === "NEW") {
      return {
        action: "NEW",
        targetTicketId: null,
        reason: String(result.reason || "novo assunto identificado").slice(0, 300),
      };
    }

    return fallbackRouting({ message, classification, tickets, activeTicketId, history });
  } catch (error) {
    console.warn("Falha ao decidir vínculo da mensagem com OS existente:", {
      message: error.message,
      status: error.status,
    });
    return fallbackRouting({ message, classification, tickets, activeTicketId, history });
  }
}

module.exports = {
  planTicketRouting,
  fallbackRouting,
};
