const OpenAI = require("openai");

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function cleanText(value, max = 500) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  return text ? text.slice(0, max) : null;
}

function boolOrNull(value) {
  if (value === true || value === false) return value;
  return null;
}

function normalizeType(value) {
  const allowed = new Set([
    "INCENDIO",
    "INVASAO",
    "AGRESSAO_AMEACA",
    "ACIDENTE",
    "EMERGENCIA_MEDICA",
    "PESSOA_SUSPEITA",
    "FURTO_ROUBO",
    "GAS_ELETRICA",
    "OUTRA",
  ]);
  const type = String(value || "OUTRA").toUpperCase();
  return allowed.has(type) ? type : "OUTRA";
}

function normalizeHistory(history = []) {
  return (Array.isArray(history) ? history : []).slice(-12).map((item) => ({
    role: item.role === "assistant" || item.sender === "assistant" ? "assistant" : "user",
    text: String(item.text || item.message || "").slice(0, 800),
  }));
}


function normalizeLoose(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " " );
}

function inferEmergencyTypeFromText(value) {
  const text = normalizeLoose(value);
  if (!text) return null;
  if (/\b(fogo|incendio|incendiando|fumaca|chamas?)\b/.test(text)) return "INCENDIO";
  if (/\b(invasao|invadindo|invadir|arrombamento|arrombando)\b/.test(text)) return "INVASAO";
  if (/\b(agressao|agredindo|ameaca|ameacando|briga)\b/.test(text)) return "AGRESSAO_AMEACA";
  if (/\b(acidente|atropelamento|colisao|batida|capotamento)\b/.test(text)) return "ACIDENTE";
  if (/\b(desmaiou|desmaio|convulsao|infarto|parada cardiaca|emergencia medica|passando mal)\b/.test(text)) return "EMERGENCIA_MEDICA";
  if (/\b(pessoa suspeita|suspeito|suspeita)\b/.test(text)) return "PESSOA_SUSPEITA";
  if (/\b(furto|roubo|assalto|furtando|roubando)\b/.test(text)) return "FURTO_ROUBO";
  if (/\b(vazamento de gas|cheiro de gas|curto circuito|choque eletrico|fio energizado|rede eletrica)\b/.test(text)) return "GAS_ELETRICA";
  return null;
}

function lastAssistantText(history = []) {
  const items = normalizeHistory(history);
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (items[i].role === "assistant" && items[i].text) return items[i].text;
  }
  return "";
}

function expectedFieldFromHistory(history = []) {
  const text = normalizeLoose(lastAssistantText(history));
  if (!text) return null;
  if (text.includes("onde exatamente isso esta acontecendo")) return "location";
  if (text.includes("a situacao ainda esta acontecendo")) return "ongoing";
  if (text.includes("ha alguem em risco ou ferido")) return "risk_injuries";
  if (text.includes("descrever a pessoa ou veiculo")) return "person_vehicle_description";
  if (text.includes("arma visivel")) return "weapon_visible";
  if (text.includes("gas, rede eletrica") || text.includes("possibilidade de o fogo se espalhar")) return "specific_risk";
  if (text.includes("quantas pessoas estao envolvidas")) return "details";
  return null;
}

function parseYesNo(value) {
  const text = normalizeLoose(value).replace(/[.!?]+$/g, "");
  if (/^(sim|s|ss|isso|esta|continua|ainda esta|positivo)$/.test(text)) return true;
  if (/^(nao|n|nn|negativo|nao esta|parou|acabou|cessou)$/.test(text)) return false;
  return null;
}

function looksLikeClearTopicChange(value) {
  const text = normalizeLoose(value);
  if (!text) return true;
  if (/^(oi|ola|bom dia|boa tarde|boa noite|obrigado|obrigada|valeu|tchau)$/.test(text)) return true;
  if (/[?]/.test(String(value || "")) && /\b(estatuto|regulamento|horario|academia|quadra|assembleia|boleto|financeiro)\b/.test(text)) return true;
  return false;
}

function deterministicFollowup({ message, history = [], previousTriage = {} }) {
  const expected = expectedFieldFromHistory(history);
  const raw = cleanText(message, 600);
  if (!expected || !raw || looksLikeClearTopicChange(raw)) return null;

  const extracted = { type: normalizeType(previousTriage?.type) };
  const yesNo = parseYesNo(raw);

  if (expected === "location") {
    if (yesNo !== null) return { relevant: true, extracted };
    extracted.location = raw;
  } else if (expected === "ongoing") {
    if (yesNo !== null) extracted.ongoing = yesNo;
    else extracted.details = raw;
  } else if (expected === "risk_injuries") {
    if (yesNo === false) {
      extracted.people_at_risk = false;
      extracted.injuries = false;
    } else if (yesNo === true) {
      extracted.people_at_risk = true;
    } else {
      extracted.details = raw;
    }
  } else if (expected === "weapon_visible") {
    if (yesNo !== null) extracted.weapon_visible = yesNo;
    else extracted.details = raw;
  } else if (expected === "person_vehicle_description") {
    extracted.person_vehicle_description = raw;
  } else if (expected === "specific_risk") {
    extracted.specific_risk = raw;
  } else if (expected === "details") {
    extracted.details = raw;
  }

  return { relevant: true, extracted };
}

function mergeTriage(previous = {}, extracted = {}) {
  const next = { ...previous };
  const fields = ["location", "details", "person_vehicle_description", "direction", "specific_risk"];
  for (const key of fields) {
    const value = cleanText(extracted[key], 600);
    if (value) next[key] = value;
  }
  for (const key of ["ongoing", "people_at_risk", "injuries", "weapon_visible"]) {
    const value = boolOrNull(extracted[key]);
    if (value !== null) next[key] = value;
  }
  next.type = normalizeType(extracted.type || previous.type);
  return next;
}

function hasValue(obj, key) {
  return obj && obj[key] !== null && obj[key] !== undefined && obj[key] !== "";
}

function nextEmergencyQuestion(triage = {}, questionCount = 0) {
  if (questionCount >= 3) return null;
  if (!hasValue(triage, "location")) {
    return "Onde exatamente isso est\u00e1 acontecendo? Informe a quadra/lote ou um ponto de refer\u00eancia.";
  }
  if (!hasValue(triage, "ongoing")) {
    return "A situa\u00e7\u00e3o ainda est\u00e1 acontecendo neste momento?";
  }
  if (!hasValue(triage, "people_at_risk") && !hasValue(triage, "injuries")) {
    return "H\u00e1 algu\u00e9m em risco ou ferido?";
  }

  switch (normalizeType(triage.type)) {
    case "INCENDIO":
    case "GAS_ELETRICA":
      if (!hasValue(triage, "specific_risk")) {
        return "Sem se aproximar do risco, voc\u00ea percebe g\u00e1s, rede el\u00e9trica envolvida ou possibilidade de o fogo se espalhar?";
      }
      break;
    case "INVASAO":
    case "PESSOA_SUSPEITA":
    case "FURTO_ROUBO":
      if (!hasValue(triage, "person_vehicle_description")) {
        return "Sem se aproximar, consegue descrever a pessoa ou ve\u00edculo e, se estiver se deslocando, a dire\u00e7\u00e3o seguida?";
      }
      break;
    case "AGRESSAO_AMEACA":
      if (!hasValue(triage, "weapon_visible")) {
        return "H\u00e1 alguma arma vis\u00edvel ou amea\u00e7a imediata? N\u00e3o se aproxime para verificar.";
      }
      break;
    case "ACIDENTE":
    case "EMERGENCIA_MEDICA":
      if (!hasValue(triage, "details")) {
        return "Quantas pessoas est\u00e3o envolvidas e qual \u00e9 a condi\u00e7\u00e3o aparente delas?";
      }
      break;
  }
  return null;
}

async function analyzeEmergencyMessage({ message, history = [], previousTriage = {}, ticket = null }) {
  const deterministic = deterministicFollowup({ message, history, previousTriage });
  if (deterministic) return deterministic;

  const inferredType = inferEmergencyTypeFromText(message);
  const prompt = `
Voc\u00ea faz TRIAGEM DE EMERG\u00caNCIA para a AARS. Seu papel aqui \u00e9 somente extrair dados operacionais e decidir se a mensagem atual complementa a emerg\u00eancia ativa.

REGRAS:
- N\u00c3O forne\u00e7a aconselhamento ao morador.
- N\u00c3O invente local, risco, feridos, armas ou andamento.
- Use null quando n\u00e3o houver informa\u00e7\u00e3o suficiente.
- relevant_to_emergency=true quando a mensagem responde ou acrescenta informa\u00e7\u00e3o sobre a ocorr\u00eancia emergencial ativa, mesmo que seja curta como \"sim\", \"n\u00e3o\", \"quadra H\" ou \"perto do lago\".
- relevant_to_emergency=false quando a mensagem muda claramente para outro assunto independente.

TIPOS permitidos:
INCENDIO, INVASAO, AGRESSAO_AMEACA, ACIDENTE, EMERGENCIA_MEDICA, PESSOA_SUSPEITA, FURTO_ROUBO, GAS_ELETRICA, OUTRA.

OS ATIVA:
${JSON.stringify({
  protocol: ticket?.protocol || null,
  summary: ticket?.summary || null,
  emergency: Boolean(ticket?.emergency),
}, null, 2)}

TRIAGEM J\u00c1 CONHECIDA:
${JSON.stringify(previousTriage || {}, null, 2)}

HIST\u00d3RICO RECENTE:
${JSON.stringify(normalizeHistory(history), null, 2)}

MENSAGEM ATUAL:
${JSON.stringify(String(message || "").slice(0, 2000))}

Retorne SOMENTE JSON v\u00e1lido:
{
  "relevant_to_emergency": true,
  "type": "OUTRA",
  "location": null,
  "ongoing": null,
  "people_at_risk": null,
  "injuries": null,
  "weapon_visible": null,
  "person_vehicle_description": null,
  "direction": null,
  "specific_risk": null,
  "details": null
}
`;

  try {
    const response = await client.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      input: prompt,
    });
    const raw = String(response.output_text || "").trim();
    const clean = raw.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    const data = JSON.parse(clean);
    return {
      relevant: data.relevant_to_emergency !== false,
      extracted: {
        type: normalizeType(inferredType || data.type),
        location: cleanText(data.location),
        ongoing: boolOrNull(data.ongoing),
        people_at_risk: boolOrNull(data.people_at_risk),
        injuries: boolOrNull(data.injuries),
        weapon_visible: boolOrNull(data.weapon_visible),
        person_vehicle_description: cleanText(data.person_vehicle_description),
        direction: cleanText(data.direction),
        specific_risk: cleanText(data.specific_risk),
        details: cleanText(data.details, 800),
      },
    };
  } catch (error) {
    console.warn("Falha na triagem estruturada de emergencia:", { message: error.message });
    return { relevant: true, extracted: { type: normalizeType(inferredType || previousTriage?.type) } };
  }
}

function buildEmergencyResidentReply({ protocol, firstAlert = false, triage = {}, question = null }) {
  const head = firstAlert
    ? "O alerta de emerg\u00eancia j\u00e1 foi encaminhado automaticamente para a equipe respons\u00e1vel."
    : "Obrigado. Essa nova informa\u00e7\u00e3o foi encaminhada automaticamente para a equipe respons\u00e1vel.";
  const parts = [head, `Protocolo: ${protocol}`];
  if (question) {
    parts.push("", "Para ajudar a equipe no atendimento:", question);
  } else {
    parts.push("", "Continue enviando por aqui qualquer mudan\u00e7a importante sobre a ocorr\u00eancia.");
  }
  return parts.join("\n");
}

module.exports = {
  analyzeEmergencyMessage,
  mergeTriage,
  nextEmergencyQuestion,
  buildEmergencyResidentReply,
};
