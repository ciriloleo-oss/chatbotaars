require("dotenv").config();

const express = require("express");
const { classifyMessage } = require("./aiClassifier");
const { createTicket } = require("./ticketService");
const { sendWhatsAppMessage } = require("./whatsappService");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
  res.status(200).send("Bot do condomínio online");
});

// Verificação webhook Meta
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (
    mode === "subscribe" &&
    token === process.env.WHATSAPP_VERIFY_TOKEN
  ) {
    console.log("Webhook verificado com sucesso.");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Recebimento mensagens
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;

    const value = body.entry?.[0]?.changes?.[0]?.value;

    // Status entrega WhatsApp
    const status = value?.statuses?.[0];

    if (status) {
      console.log("Status WhatsApp:", {
        id: status.id,
        status: status.status,
        recipient_id: status.recipient_id,
        timestamp: status.timestamp,
        errors: status.errors,
      });

      return res.sendStatus(200);
    }

    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    const phone = message.from;
    const text = message.text?.body || "";
    const messageId = message.id;

    console.log("Mensagem recebida:", {
      phone,
      text,
      messageId,
    });

    // IA
    const classification = await classifyMessage(text);

    console.log("Classificação:", classification);

    // Criação chamado
    const ticket = await createTicket({
      phone,
      message: text,
      classification,
      whatsappMessageId: messageId,
    });

    // Resposta
    const reply =
      classification.suggested_reply ||
      "Sua solicitação foi registrada com sucesso.";

    await sendWhatsAppMessage(
      phone,
      `${reply}\n\nProtocolo: ${ticket.protocol}`
    );

    console.log("Chamado criado:", ticket.protocol);

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