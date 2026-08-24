const { supabase } = require("./supabase");

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeBrazilPhone(value) {
  let phone = onlyDigits(value).replace(/^0+/, "");
  if (!phone.startsWith("55")) phone = `55${phone}`;
  return phone;
}

function firstName(value) {
  return String(value || "").trim().split(/\s+/)[0] || "";
}

function buildWhatsAppReturnText({ name, protocol, message }) {
  const first = firstName(name);
  return [
    `Olá${first ? `, ${first}` : ""}.`,
    "",
    `Sobre o protocolo ${protocol}:`,
    "",
    String(message || "").trim(),
    "",
    "Equipe AARS",
    "Associação dos Amigos do Reserva da Serra",
  ].join("\n");
}

function maskPhone(phone) {
  const digits = onlyDigits(phone);
  if (digits.length < 4) return "****";
  return `••••${digits.slice(-4)}`;
}

function getEvolutionErrorMessage(responseJson, responseText) {
  const candidate =
    responseJson?.response?.message ??
    responseJson?.message ??
    responseJson?.error ??
    responseJson?.response ??
    responseText;

  if (Array.isArray(candidate)) {
    try {
      return JSON.stringify(candidate).slice(0, 350);
    } catch {
      return "Erro retornado pela Evolution API.";
    }
  }

  if (candidate && typeof candidate === "object") {
    try {
      return JSON.stringify(candidate).slice(0, 350);
    } catch {
      return "Erro retornado pela Evolution API.";
    }
  }

  return String(candidate || "Erro retornado pela Evolution API.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 350);
}

async function getTicketAndResident(ticketId) {
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id,protocol,resident_id,status,ticket_type")
    .eq("id", ticketId)
    .maybeSingle();

  if (ticketError) throw ticketError;
  if (!ticket) return null;

  let resident = null;
  if (ticket.resident_id) {
    const { data, error } = await supabase
      .from("residents")
      .select("id,name,phone,unit")
      .eq("id", ticket.resident_id)
      .maybeSingle();
    if (error) throw error;
    resident = data || null;
  }

  return { ticket, resident };
}

async function callEvolution({ evolutionUrl, apiKey, payload }) {
  const response = await fetch(evolutionUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: apiKey,
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let responseJson = null;
  try {
    responseJson = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseJson = { raw: responseText.slice(0, 1000) };
  }

  return { response, responseText, responseJson };
}

async function sendWhatsAppReturnForAdmin(ticketId, message) {
  const cleanMessage = String(message || "").trim();
  if (cleanMessage.length < 2) {
    const error = new Error("Digite uma mensagem para enviar ao associado.");
    error.statusCode = 400;
    throw error;
  }
  if (cleanMessage.length > 1800) {
    const error = new Error("A mensagem ultrapassa o limite permitido.");
    error.statusCode = 400;
    throw error;
  }

  const record = await getTicketAndResident(ticketId);
  if (!record) {
    const error = new Error("OS não encontrada.");
    error.statusCode = 404;
    throw error;
  }

  const { ticket, resident } = record;
  const phone = normalizeBrazilPhone(resident?.phone || "");
  if (phone.length < 12 || phone.length > 13) {
    const error = new Error("O associado não possui um telefone/WhatsApp válido cadastrado.");
    error.statusCode = 400;
    throw error;
  }

  const baseUrl = String(process.env.EVOLUTION_BASE_URL || "").replace(/\/$/, "");
  const apiKey = String(process.env.EVOLUTION_API_KEY || "");
  const instance = String(process.env.EVOLUTION_INSTANCE || "");

  if (!baseUrl || !apiKey || !instance) {
    const error = new Error("Envio por WhatsApp ainda não está configurado no Railway.");
    error.statusCode = 503;
    throw error;
  }

  const text = buildWhatsAppReturnText({
    name: resident?.name,
    protocol: ticket.protocol,
    message: cleanMessage,
  });

  const evolutionUrl = `${baseUrl}/message/sendText/${encodeURIComponent(instance)}`;

  // Evolution API v2.2.x / Baileys: algumas builds esperam o formato
  // legado documentado com options + textMessage. O payload flat
  // { number, text, delay } pode retornar 500 tentando ler textMessage.
  const legacyPayload = {
    number: phone,
    options: {
      delay: 1200,
      presence: "composing",
    },
    textMessage: {
      text,
    },
  };

  let result = await callEvolution({ evolutionUrl, apiKey, payload: legacyPayload });

  // Compatibilidade com builds mais novas que validam "text" no topo.
  // Só fazemos fallback em 400/422 (erro de validação, antes do envio),
  // evitando risco de duplicidade após um eventual 500 do provedor.
  if (!result.response.ok && [400, 422].includes(result.response.status)) {
    const providerMsg = getEvolutionErrorMessage(result.responseJson, result.responseText).toLowerCase();
    const looksLikeNewSchema =
      providerMsg.includes('property "text"') ||
      providerMsg.includes("property 'text'") ||
      providerMsg.includes("text is required") ||
      providerMsg.includes("textmessage is not allowed") ||
      providerMsg.includes("textmessage must not exist");

    if (looksLikeNewSchema) {
      const flatPayload = {
        number: phone,
        text,
        delay: 1200,
        linkPreview: false,
      };
      result = await callEvolution({ evolutionUrl, apiKey, payload: flatPayload });
    }
  }

  if (!result.response.ok) {
    const providerMessage = getEvolutionErrorMessage(result.responseJson, result.responseText);
    console.error("Falha no retorno WhatsApp da OS:", {
      protocol: ticket.protocol,
      status: result.response.status,
      response: result.responseJson,
    });

    let friendly = `A Evolution API recusou o envio (HTTP ${result.response.status})`;
    if (providerMessage) friendly += `: ${providerMessage}`;

    const error = new Error(friendly);
    error.statusCode = 502;
    throw error;
  }

  const { data: savedMessage, error: saveError } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: ticket.id,
      sender: "staff",
      message: text,
      message_type: "whatsapp_outbound",
      attachment_url: null,
    })
    .select("id,sender,message,message_type,created_at")
    .single();

  if (saveError) {
    console.error("WhatsApp enviado, mas falhou ao registrar histórico:", {
      protocol: ticket.protocol,
      message: saveError.message,
    });
    const error = new Error("WhatsApp enviado, mas não foi possível registrar a mensagem no histórico da OS.");
    error.statusCode = 500;
    throw error;
  }

  return {
    success: true,
    protocol: ticket.protocol,
    recipient: resident?.name || "Associado",
    phoneMasked: maskPhone(phone),
    message: savedMessage,
  };
}

module.exports = {
  sendWhatsAppReturnForAdmin,
};
