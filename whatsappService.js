const axios = require("axios");

async function sendWhatsAppMessage(to, text) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;

  if (!token || !phoneNumberId) {
    console.warn("WhatsApp não configurado.", {
      hasToken: Boolean(token),
      phoneNumberId,
    });
    return null;
  }

  const graphVersion = process.env.META_GRAPH_VERSION || "v25.0";
  const url = `https://graph.facebook.com/${graphVersion}/${phoneNumberId}/messages`;

  try {
    const response = await axios.post(
      url,
      {
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { preview_url: false, body: text },
      },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    console.log("Resposta WhatsApp enviada:", response.data);
    return response.data;
  } catch (error) {
    console.error("Erro ao enviar WhatsApp:", {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    throw error;
  }
}

module.exports = { sendWhatsAppMessage };
