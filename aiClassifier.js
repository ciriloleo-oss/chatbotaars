const OpenAI = require("openai");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY não configurada");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

function normalizeHistory(history = []) {
  return history
    .slice(-12)
    .map((item) => ({
      sender: item.sender === "assistant" ? "Assistente" : "Morador",
      message: String(item.message || "").slice(0, 1200),
    }));
}

function fallbackClassification(message) {
  const emergencyRegex =
    /\b(inc[eê]ndio|pegando fogo|fogo|invas[aã]o|agress[aã]o|amea[cç]a|acidente|viol[eê]ncia|socorro|emerg[eê]ncia)\b/i;

  const emergency = emergencyRegex.test(message);

  return {
    category: emergency ? "Emergência" : "Outros",
    priority: emergency ? "CRÍTICA" : "MÉDIA",
    responsible: emergency ? ["Supervisor de Segurança"] : ["Recepção"],
    requires_manager: false,
    requires_human: true,
    emergency,
    sentiment: "Indefinido",
    summary: message.slice(0, 300),
    missing_information: ["Nome do morador", "Unidade"],
    suggested_reply: emergency
      ? "Identificamos uma possível situação de emergência. Preserve sua segurança e mantenha distância do risco. A ocorrência foi registrada para encaminhamento à Segurança."
      : "Sua solicitação foi recebida e será analisada pela equipe responsável.",
  };
}

async function classifyMessage(message, history = [], resident = {}) {
  const context = normalizeHistory(history);

  const prompt = `
Você é o assistente virtual do Reserva da Serra, responsável pelo primeiro atendimento aos moradores.

DADOS DO MORADOR:
Nome: ${resident.name || "não informado"}
Unidade/Casa: ${resident.unit || "não informada"}
Bloco/Setor: ${resident.block || "não informado"}
Telefone: ${resident.phone || "não informado"}

HISTÓRICO RECENTE:
${context.length ? JSON.stringify(context, null, 2) : "Sem mensagens anteriores."}

MENSAGEM ATUAL:
${JSON.stringify(message)}

OBJETIVOS:
1. Entender o pedido.
2. Classificar a categoria e prioridade.
3. Identificar o responsável.
4. Responder ao morador com clareza e cordialidade.
5. Solicitar somente as informações realmente necessárias que ainda estiverem faltando.
6. Em emergência, priorizar segurança. Não espere dados complementares para reconhecer a urgência.

CATEGORIAS:
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
- Portaria / Acesso -> Recepção
- Manutenção -> Recepção
- Limpeza -> Recepção
- Área comum -> Recepção
- Encomendas -> Recepção
- Sugestão -> Recepção
- Outros -> Recepção

PRIORIDADE CRÍTICA:
incêndio, fogo, invasão, agressão, ameaça, violência, acidente grave,
emergência médica, tentativa de furto ou qualquer risco imediato.

PRIORIDADE ALTA:
problema relevante de segurança, portão travado, vazamento grave,
falta de energia em área comum, reclamação formal ou ameaça jurídica.

PRIORIDADE MÉDIA:
barulho, manutenção comum, dúvida financeira, reclamação sem risco imediato.

PRIORIDADE BAIXA:
sugestão, elogio, pedido simples de informação.

REGRAS:
- Nunca exponha dados pessoais de terceiros.
- Nunca acuse outro morador como fato.
- Nunca assuma culpa do condomínio.
- Não prometa prazo ou solução que não esteja garantida.
- Em emergência, oriente o morador a preservar a própria segurança e, quando aplicável, acionar serviços públicos de emergência.
- Não peça novamente nome, telefone ou unidade se eles já constarem nos dados acima.
- A resposta deve ser curta e adequada para chat no celular.
- Não invente regras internas do condomínio.

Retorne SOMENTE JSON válido:
{
  "category": "",
  "priority": "",
  "responsible": [],
  "requires_manager": false,
  "requires_human": true,
  "emergency": false,
  "sentiment": "",
  "summary": "",
  "missing_information": [],
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
      category: result.category || "Outros",
      priority: result.priority || "MÉDIA",
      responsible: Array.isArray(result.responsible)
        ? result.responsible
        : ["Recepção"],
      requires_manager: Boolean(result.requires_manager),
      requires_human: result.requires_human !== false,
      emergency: Boolean(result.emergency),
      sentiment: result.sentiment || "neutro",
      summary: result.summary || message.slice(0, 300),
      missing_information: Array.isArray(result.missing_information)
        ? result.missing_information
        : [],
      suggested_reply:
        result.suggested_reply || "Sua solicitação foi registrada.",
    };
  } catch (error) {
    console.error("Erro OpenAI/classificação:", {
      message: error.message,
      status: error.status,
      code: error.code,
    });

    return fallbackClassification(message);
  }
}

function buildWebReply(classification, protocol) {
  let reply =
    classification.suggested_reply || "Sua solicitação foi registrada.";

  if (classification.emergency) {
    return `🚨 POSSÍVEL EMERGÊNCIA\n\n${reply}\n\nProtocolo: ${protocol}`;
  }

  return `${reply}\n\nProtocolo: ${protocol}`;
}

module.exports = {
  classifyMessage,
  buildWebReply,
};
