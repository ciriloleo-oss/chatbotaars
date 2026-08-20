require("dotenv").config();

const crypto = require("crypto");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const {
  createOrUpdateResident,
  createTicket,
  appendTicketMessage,
  updateTicketClassification,
  getConversationMessages,
  getTicketById,
} = require("./ticketService");

const { classifyMessage, buildWebReply } = require("./aiClassifier");
const { sendWhatsAppMessage } = require("./whatsappService");

const app = express();

app.set("trust proxy", 1);
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(express.json({ limit: "100kb" }));

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
      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
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
  console.warn(
    "WEB_CHAT_SIGNING_SECRET não configurado. Configure essa variável no Railway para manter as sessões após redeploy."
  );
}

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
  if (!token || typeof token !== "string" || !token.includes(".")) {
    return null;
  }

  try {
    const [encoded, signature] = token.split(".");
    const expected = crypto
      .createHmac("sha256", signingSecret)
      .update(encoded)
      .digest("base64url");

    const a = Buffer.from(signature);
    const b = Buffer.from(expected);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const payload = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    );

    if (!payload.ticketId || !payload.exp || payload.exp < Date.now()) return null;

    return payload;
  } catch {
    return null;
  }
}

function sanitizeResident(input = {}) {
  const digits = String(input.phone || "").replace(/\D/g, "");

  return {
    name: String(input.name || "").trim().slice(0, 100),
    unit: String(input.unit || "").trim().slice(0, 60),
    block: String(input.block || "").trim().slice(0, 60),
    phone: digits.slice(0, 20),
  };
}

function validateWebRequest(resident, message) {
  if (!resident.name) return "Informe o nome do morador.";
  if (!resident.unit) return "Informe a unidade/casa.";
  if (resident.phone.length < 12) return "Informe um telefone válido com DDD.";
  if (!message || message.length < 2) return "Digite uma mensagem.";
  if (message.length > 2000) return "A mensagem ultrapassa o limite permitido.";
  return null;
}

app.get("/", (req, res) => {
  res.status(200).send("Bot do condomínio online");
});

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    service: "Reserva da Serra Atendimento",
    timestamp: new Date().toISOString(),
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const resident = sanitizeResident(req.body?.resident);
    const message = String(req.body?.message || "").trim();
    const sessionToken = req.body?.sessionToken || null;

    const validationError = validateWebRequest(resident, message);
    if (validationError) {
      return res.status(400).json({ error: validationError });
    }

    let ticket;
    const sessionPayload = verifySession(sessionToken);

    if (sessionToken && !sessionPayload) {
      return res.status(401).json({
        error: "A sessão deste atendimento expirou. Inicie um novo atendimento.",
      });
    }

    if (sessionPayload) {
      ticket = await getTicketById(sessionPayload.ticketId);

      if (!ticket) {
        return res.status(404).json({
          error: "Atendimento não encontrado. Inicie um novo atendimento.",
        });
      }

      await appendTicketMessage(ticket.id, "resident", message);

      const conversation = await getConversationMessages(ticket.id, 12);
      const classification = await classifyMessage(message, conversation, resident);

      await updateTicketClassification(ticket.id, classification);

      const reply = buildWebReply(classification, ticket.protocol);
      await appendTicketMessage(ticket.id, "assistant", reply);

      return res.json({
        success: true,
        protocol: ticket.protocol,
        sessionToken,
        reply,
        category: classification.category,
        priority: classification.priority,
        emergency: classification.emergency,
        responsible: classification.responsible,
      });
    }

    const residentRecord = await createOrUpdateResident(resident);
    const classification = await classifyMessage(message, [], resident);

    ticket = await createTicket({
      residentId: residentRecord.id,
      message,
      classification,
      source: "web",
      resident,
    });

    await appendTicketMessage(ticket.id, "resident", message);

    const reply = buildWebReply(classification, ticket.protocol);
    await appendTicketMessage(ticket.id, "assistant", reply);

    const newSessionToken = signSession(ticket);

    return res.status(201).json({
      success: true,
      protocol: ticket.protocol,
      sessionToken: newSessionToken,
      reply,
      category: classification.category,
      priority: classification.priority,
      emergency: classification.emergency,
      responsible: classification.responsible,
    });
  } catch (error) {
    console.error("Erro no chat web:", {
      message: error.message,
      code: error.code,
      details: error.details,
      hint: error.hint,
      stack: error.stack,
    });

    return res.status(500).json({
      error: "Não foi possível registrar o atendimento agora. Tente novamente em alguns instantes.",
    });
  }
});

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    console.log("Webhook verificado com sucesso.");
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

    const message = value?.messages?.[0];
    if (!message) return res.sendStatus(200);

    if (message.type !== "text") {
      await sendWhatsAppMessage(
        message.from,
        "Recebi sua mensagem. No momento, consigo interpretar melhor mensagens de texto. Por favor, descreva sua solicitação em poucas palavras."
      );
      return res.sendStatus(200);
    }

    const phone = message.from;
    const text = message.text?.body || "";

    console.log("Mensagem WhatsApp recebida:", {
      phone,
      text,
      messageId: message.id,
    });

    const resident = await createOrUpdateResident({
      name: "Morador via WhatsApp",
      phone,
      unit: "Não informada",
      block: "",
    });

    const classification = await classifyMessage(text, [], {
      name: resident.name,
      phone,
      unit: resident.unit,
      block: resident.block,
    });

    const ticket = await createTicket({
      residentId: resident.id,
      message: text,
      classification,
      source: "whatsapp",
      resident,
    });

    await appendTicketMessage(ticket.id, "resident", text, message.id);

    const reply = buildWebReply(classification, ticket.protocol);
    await appendTicketMessage(ticket.id, "assistant", reply);

    await sendWhatsAppMessage(phone, reply);

    console.log("Chamado WhatsApp criado:", ticket.protocol);
    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", {
      message: error.message,
      status: error.response?.status,
      data: error.response?.data,
      stack: error.stack,
    });

    return res.sendStatus(500);
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
