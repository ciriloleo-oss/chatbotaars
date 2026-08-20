const { detectKnowledgeTopic } = require("./knowledgeTopics");

function normalize(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

const QUESTION_CUES = [
  /\bqual\b/,
  /\bquais\b/,
  /\bquando\b/,
  /\bonde\b/,
  /\bcomo\b/,
  /\bquanto(?:s|as)?\b/,
  /\bate que horas\b/,
  /\bque horas\b/,
  /\bhorario\b/,
  /\bfuncionamento\b/,
  /\bposso\b/,
  /\bpode\b/,
  /\be permitido\b/,
  /\be proibido\b/,
  /\bprecisa\b/,
  /\bdevo\b/,
  /\bregra(?:s)?\b/,
  /\bregulamento\b/,
  /\bestatuto\b/,
  /\bconvidado(?:s)?\b/,
  /\breserva(?:r|s)?\b/,
];

const DOCUMENT_SUBJECTS = [
  /\bacademia\b/,
  /\bpiscina(?:s)?\b/,
  /\bsociety\b/,
  /\bminicampo\b/,
  /\bcampo de futebol\b/,
  /\bquadra(?:s)?\b/,
  /\btenis\b/,
  /\bsauna\b/,
  /\bchurrasqueira(?:s)?\b/,
  /\bsalao(?:es)?\b/,
  /\blago\b/,
  /\bbrinquedoteca\b/,
  /\bobra(?:s)?\b/,
  /\breforma(?:s)?\b/,
  /\bprestador(?:es)?\b/,
  /\bvisitante(?:s)?\b/,
  /\bportaria\b/,
  /\bacesso\b/,
  /\bentrega(?:s)?\b/,
  /\bencomenda(?:s)?\b/,
  /\blixo\b/,
  /\banimal(?:is)?\b/,
  /\bcachorro(?:s)?\b/,
  /\bcaes\b/,
  /\bgatos?\b/,
  /\btransito\b/,
  /\bvelocidade\b/,
  /\bbarulho\b/,
  /\bruido\b/,
  /\bassembleia(?:s)?\b/,
  /\bcontribuicao\b/,
  /\bpenalidade(?:s)?\b/,
  /\bmulta(?:s)?\b/,
];

const STRONG_OPERATIONAL_CUES = [
  /\bquero\s+(?:reclamar|registrar|abrir|solicitar|denunciar)\b/,
  /\bpreciso\s+que\b/,
  /\bsolicito\b/,
  /\bprovidencia(?:s)?\b/,
  /\bocorrencia\b/,
  /\breclamacao\b/,
  /\bdenuncia\b/,
  /\bnao\s+funciona\b/,
  /\bparou\s+de\s+funcionar\b/,
  /\besta\s+(?:quebrad[oa]|vazando|pegando fogo|ocorrendo|acontecendo)\b/,
  /\btem\s+(?:um\s+|uma\s+)?(?:vazamento|fogo|incendio|problema|som alto|barulho alto)\b/,
  /\bha\s+(?:um\s+|uma\s+)?(?:vazamento|fogo|incendio|problema|som alto|barulho alto)\b/,
  /\b(?:vazamento|incendio|fogo)\s+(?:na|no|em|perto|proximo)\b/,
  /\b(?:som alto|barulho alto)\s+(?:na|no|em|perto|proximo)\b/,
];

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function isStrongDocumentConsultation(message = "") {
  const text = normalize(message);
  if (!text) return false;

  const topic = detectKnowledgeTopic(message);
  const hasQuestionCue = matchesAny(text, QUESTION_CUES) || /\?$/.test(String(message).trim());
  const hasDocumentSubject = Boolean(topic) || matchesAny(text, DOCUMENT_SUBJECTS);
  const hasOperationalCue = matchesAny(text, STRONG_OPERATIONAL_CUES);

  return hasQuestionCue && hasDocumentSubject && !hasOperationalCue;
}

function enforceNewConversationIntent(classification = {}, message = "") {
  if (!isStrongDocumentConsultation(message)) return classification;

  const topic = detectKnowledgeTopic(message);

  return {
    ...classification,
    intent: "CONSULTA",
    document_scope: topic?.scope || (
      /\b(?:estatuto|assembleia|contribuicao)\b/.test(normalize(message))
        ? "ESTATUTO"
        : "RI"
    ),
    requires_human: false,
    requires_manager: false,
    emergency: false,
    intake_complete: true,
    next_question: "",
  };
}

function csvSet(value = "") {
  return new Set(
    String(value || "")
      .split(",")
      .map((item) => normalize(item).replace(/\D/g, "") || normalize(item))
      .filter(Boolean)
  );
}

function resolveTicketType(resident = {}) {
  const testPhones = csvSet(process.env.TEST_PHONE_NUMBERS);
  const testUnits = new Set(
    String(process.env.TEST_UNITS || "")
      .split(",")
      .map((item) => normalize(item))
      .filter(Boolean)
  );

  const phone = String(resident.phone || "").replace(/\D/g, "");
  const unit = normalize(resident.unit || "");

  if ((phone && testPhones.has(phone)) || (unit && testUnits.has(unit))) {
    return "TESTE";
  }

  return "REAL";
}

module.exports = {
  isStrongDocumentConsultation,
  enforceNewConversationIntent,
  resolveTicketType,
};
