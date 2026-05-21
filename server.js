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
    const body = req.body;

    const value = body.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];

    if (!message) {
      return res.sendStatus(200);
    }

    if (message.type !== "text") {
      await sendWhatsAppMessage(
        message.from,
        "Recebi sua mensagem. No momento, consigo interpretar melhor mensagens de texto. Por favor, descreva sua solicitação em poucas palavras."
      );

      return res.sendStatus(200);
    }

    const phone = message.from;
    const text = message.text?.body || "";

    console.log("Mensagem recebida:", { phone, text });

    const classification = await classifyMessage(text);

    const ticket = await createTicket({
      phone,
      message: text,
      classification,
    });

    const reply =
      classification.suggested_reply ||
      `Solicitação registrada com sucesso. Protocolo: ${ticket.protocol}`;

    await sendWhatsAppMessage(phone, `${reply}\n\nProtocolo: ${ticket.protocol}`);

    console.log("Chamado criado:", ticket.protocol);

    return res.sendStatus(200);
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.sendStatus(500);
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Servidor rodando na porta ${port}`);
});
