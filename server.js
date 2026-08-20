require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const institution = require("./institution");
const {
  createOrUpdateResident,
  createTicket,
  appendTicketMessage,
  updateTicketClassification,
  getConversationMessages,
  getTicketById,
} = require("./ticketService");
const {
  classifyInteraction,
  buildOperationalReply,
} = require("./aiClassifier");
const { answerFromOfficialDocuments } = require("./knowledgeService");
const { enforceNewConversationIntent, resolveTicketType } = require("./interactionPolicy");
const { sendWhatsAppMessage } = require("./whatsappService");
const { listTicketsForAdmin, getTicketDetailForAdmin } = require("./adminService");
const { sendWhatsAppReturnForAdmin } = require("./whatsappReturnService");

const app = express();
app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "120kb" }));

const allowedOrigins = (process.env.WEB_ALLOWED_ORIGINS || "")
  .split(",")
  .map((x) => x.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes("*")) {
        return callback(null, true);
      }
      if (allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origem não autorizada pelo CORS."));
    },
  })
);

const chatLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Muitas mensagens em pouco tempo. Aguarde alguns minutos e tente novamente.",
  },
});
app.use("/api/chat", chatLimiter);

const signingSecret =
  process.env.WEB_CHAT_SIGNING_SECRET ||
  process.env.WHATSAPP_VERIFY_TOKEN ||
  crypto.randomBytes(32).toString("hex");

if (!process.env.WEB_CHAT_SIGNING_SECRET) {
  console.warn("WEB_CHAT_SIGNING_SECRET não configurado. Configure no Railway.");
}

const adminSigningSecret = process.env.ADMIN_SESSION_SECRET || signingSecret;

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function signSession(ticket) {
  const payload = {
    ticketId: ticket.id,
    protocol: ticket.protocol,
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000,
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", signingSecret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifySession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;

  try {
    const [encoded, signature] = token.split(".");
    const expected = crypto
      .createHmac("sha256", signingSecret)
      .update(encoded)
      .digest("base64url");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!payload.ticketId || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function signAdminSession() {
  const payload = {
    scope: "admin",
    exp: Date.now() + 8 * 60 * 60 * 1000,
  };
  const encoded = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac("sha256", adminSigningSecret)
    .update(encoded)
    .digest("base64url");
  return `${encoded}.${signature}`;
}

function verifyAdminSession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return null;
  try {
    const [encoded, signature] = token.split(".");
    const expected = crypto
      .createHmac("sha256", adminSigningSecret)
      .update(encoded)
      .digest("base64url");
    const a = Buffer.from(signature);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (payload.scope !== "admin" || !payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function requireAdmin(req, res, next) {
  const auth = String(req.headers.authorization || "");
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!verifyAdminSession(token)) {
    return res.status(401).json({ error: "Sessão administrativa inválida ou expirada." });
  }
  return next();
}

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Muitas tentativas de acesso. Aguarde alguns minutos." },
});

function sanitizeResident(input = {}) {
  const digits = String(input.phone || "").replace(/\D/g, "");
  return {
    name: String(input.name || "").trim().slice(0, 100),
    unit: String(input.unit || "").trim().slice(0, 60),
    block: String(input.block || "").trim().slice(0, 60),
    phone: digits.slice(0, 20),
  };
}

function sanitizeClientHistory(input = []) {
  if (!Array.isArray(input)) return [];
  return input.slice(-12).map((item) => ({
    role: item.role === "assistant" ? "assistant" : "user",
    text: String(item.text || "").slice(0, 1500),
  }));
}

function validateWebRequest(resident, message) {
  if (!resident.name) return "Informe o nome do associado.";
  if (!resident.unit) return "Informe a unidade/casa.";
  if (resident.phone.length < 12) return "Informe um telefone válido com DDD.";
  if (!message || message.length < 2) return "Digite uma mensagem.";
  if (message.length > 2000) return "A mensagem ultrapassa o limite permitido.";
  return null;
}

function conversationReply(resident) {
  const firstName = resident.name?.split(" ")?.[0] || "";
  return `Olá${firstName ? `, ${firstName}` : ""}! Posso ajudar com uma dúvida sobre as regras da Associação ou registrar uma solicitação, reclamação ou ocorrência.`;
}

function combineHybrid(knowledgeAnswer, operationalReply) {
  return [knowledgeAnswer, operationalReply].filter(Boolean).join("\n\n---\n\n");
}

app.get("/", (req, res) => {
  res.status(200).send(`${institution.shortName} - Atendimento digital online`);
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: `${institution.shortName} Atendimento Digital`,
    knowledgeConfigured: Boolean(process.env.OPENAI_VECTOR_STORE_ID),
    timestamp: new Date().toISOString(),
  });
});

// ----------------------
// ÁREA ADMINISTRATIVA - SOMENTE LEITURA
// ----------------------

app.post("/api/admin/login", adminLoginLimiter, (req, res) => {
  const configuredPassword = String(process.env.ADMIN_DASHBOARD_PASSWORD || "");
  const suppliedPassword = String(req.body?.password || "");

  if (!configuredPassword) {
    return res.status(503).json({ error: "Painel administrativo ainda não configurado." });
  }

  const a = Buffer.from(suppliedPassword);
  const b = Buffer.from(configuredPassword);
  const valid = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!valid) {
    return res.status(401).json({ error: "Senha inválida." });
  }

  return res.json({
    success: true,
    token: signAdminSession(),
    expiresInHours: 8,
  });
});

app.get("/api/admin/tickets", requireAdmin, async (req, res) => {
  try {
    const requestedType = String(req.query.type || "REAL").toUpperCase();
    const ticketType = ["REAL", "TESTE", "TODOS"].includes(requestedType)
      ? requestedType
      : "REAL";

    const tickets = await listTicketsForAdmin({
      ticketType: ticketType === "TODOS" ? null : ticketType,
      limit: req.query.limit || 300,
    });

    return res.json({ success: true, tickets });
  } catch (error) {
    console.error("Erro ao listar OS no painel:", { message: error.message });
    return res.status(500).json({ error: "Não foi possível carregar as OS." });
  }
});

app.get("/api/admin/tickets/:id", requireAdmin, async (req, res) => {
  try {
    const detail = await getTicketDetailForAdmin(req.params.id);
    if (!detail) return res.status(404).json({ error: "OS não encontrada." });
    return res.json({ success: true, ...detail });
  } catch (error) {
    console.error("Erro ao carregar OS no painel:", { message: error.message });
    return res.status(500).json({ error: "Não foi possível carregar os detalhes da OS." });
  }
});

app.post("/api/admin/tickets/:id/whatsapp", requireAdmin, async (req, res) => {
  try {
    const result = await sendWhatsAppReturnForAdmin(req.params.id, req.body?.message);
    return res.json(result);
  } catch (error) {
    console.error("Erro ao enviar retorno da OS por WhatsApp:", { message: error.message });
    const status = Number(error.statusCode) || 500;
    return res.status(status).json({ error: error.message || "Não foi possível enviar o WhatsApp." });
  }
});

app.post("/api/chat", async (req, res) => {
  try {
    const resident = sanitizeResident(req.body?.resident);
    const message = String(req.body?.message || "").trim();
    const sessionToken = req.body?.sessionToken || null;
    const clientHistory = sanitizeClientHistory(req.body?.history);

    const validationError = validateWebRequest(resident, message);
    if (validationError) return res.status(400).json({ error: validationError });

    let ticket = null;
    let databaseHistory = [];
    let sessionPayload = null;

    if (sessionToken) {
      sessionPayload = verifySession(sessionToken);
      if (!sessionPayload) {
        return res.status(401).json({
          error: "A sessão deste atendimento expirou. Inicie um novo atendimento.",
        });
      }

      ticket = await getTicketById(sessionPayload.ticketId);
      if (!ticket) {
        return res.status(404).json({
          error: "Atendimento não encontrado. Inicie um novo atendimento.",
        });
      }
      databaseHistory = await getConversationMessages(ticket.id, 14);
    }

    const contextHistory = ticket ? databaseHistory : clientHistory;
    let classification = await classifyInteraction(message, contextHistory, resident);

    // Em uma nova conversa, aplica uma trava determinística para impedir que
    // perguntas documentais claras virem OS por erro de classificação do modelo.
    if (!ticket) {
      classification = enforceNewConversationIntent(classification, message);
    }

    if (classification.intent === "CONVERSA" && !ticket) {
      return res.json({
        success: true,
        reply: conversationReply(resident),
        protocol: null,
        sessionToken: null,
        intent: classification.intent,
        sources: [],
      });
    }

    let knowledge = null;
    if (
      classification.intent === "CONSULTA" ||
      classification.intent === "CONSULTA_ATENDIMENTO"
    ) {
      knowledge = await answerFromOfficialDocuments({
        question: message,
        history: contextHistory,
        resident,
        scope: classification.document_scope,
      });
    }

    if (classification.intent === "CONSULTA" && !ticket) {
      return res.json({
        success: true,
        reply: knowledge?.answer ||
          "Não consegui consultar os documentos oficiais agora. Posso registrar a dúvida para análise da Associação.",
        protocol: null,
        sessionToken: null,
        intent: classification.intent,
        grounded: Boolean(knowledge?.grounded),
        sources: knowledge?.sources || [],
      });
    }

    // Se já existe ticket, toda nova mensagem permanece no mesmo atendimento.
    if (ticket) {
      await appendTicketMessage(ticket.id, "resident", message);
      await updateTicketClassification(ticket.id, classification);
    } else {
      const residentRecord = await createOrUpdateResident(resident);
      const ticketType = resolveTicketType(resident);
      ticket = await createTicket({
        residentId: residentRecord.id,
        message,
        classification,
        source: "web",
        resident,
        ticketType,
      });
      await appendTicketMessage(ticket.id, "resident", message);
    }

    const operationalReply = buildOperationalReply(classification, ticket.protocol);
    let reply = operationalReply;

    if (classification.intent === "CONSULTA_ATENDIMENTO") {
      reply = combineHybrid(knowledge?.answer, operationalReply);
    } else if (classification.intent === "CONSULTA") {
      reply = knowledge?.answer || operationalReply;
    }

    await appendTicketMessage(ticket.id, "assistant", reply);

    const finalSessionToken = sessionToken || signSession(ticket);

    return res.status(sessionToken ? 200 : 201).json({
      success: true,
      protocol: ticket.protocol,
      sessionToken: finalSessionToken,
      reply,
      intent: classification.intent,
      category: classification.category,
      priority: classification.priority,
      emergency: classification.emergency,
      responsible: classification.responsible,
      intakeComplete: classification.intake_complete,
      grounded: Boolean(knowledge?.grounded),
      sources: knowledge?.sources || [],
      ticketType: ticket?.ticket_type || null,
    });
  } catch (error) {
    console.error("Erro no chat web:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      status: error.status,
      stack: error.stack,
    });

    return res.status(500).json({
      error: "Não foi possível concluir o atendimento agora. Tente novamente em alguns instantes.",
    });
  }
});

// Mantém o webhook para retomada futura do WhatsApp.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const status = value?.statuses?.[0];

    if (status) {
      console.log("Status WhatsApp:", {
        id: status.id,
        status: status.status,
        recipient_id: status.recipient_id,
        errors: status.errors,
      });
      return res.sendStatus(200);
    }

    const whatsappMessage = value?.messages?.[0];
    if (!whatsappMessage) return res.sendStatus(200);

    if (whatsappMessage.type !== "text") {
      await sendWhatsAppMessage(
        whatsappMessage.from,
        "Recebi sua mensagem. No momento, descreva sua solicitação em texto para que eu possa ajudar."
      );
      return res.sendStatus(200);
    }

    const phone = whatsappMessage.from;
    const text = whatsappMessage.text?.body || "";
    const resident = { name: "Associado", phone, unit: "Não informada", block: "" };
    let classification = await classifyInteraction(text, [], resident);
    classification = enforceNewConversationIntent(classification, text);

    if (classification.intent === "CONSULTA") {
      const knowledge = await answerFromOfficialDocuments({
        question: text,
        resident,
        scope: classification.document_scope,
      });
      await sendWhatsAppMessage(phone, knowledge.answer);
      return res.sendStatus(200);
    }

    const residentRecord = await createOrUpdateResident(resident);
    const ticketType = resolveTicketType(resident);
    const ticket = await createTicket({
      residentId: residentRecord.id,
      message: text,
      classification,
      source: "whatsapp",
      resident,
      ticketType,
    });
    await appendTicketMessage(ticket.id, "resident", text, whatsappMessage.id);

    let reply = buildOperationalReply(classification, ticket.protocol);
    if (classification.intent === "CONSULTA_ATENDIMENTO") {
      const knowledge = await answerFromOfficialDocuments({
        question: text,
        resident,
        scope: classification.document_scope,
      });
      reply = combineHybrid(knowledge.answer, reply);
    }

    await appendTicketMessage(ticket.id, "assistant", reply);
    await sendWhatsAppMessage(phone, reply);
    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return res.sendStatus(500);
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Servidor rodando na porta ${port}`));
