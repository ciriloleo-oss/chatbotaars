const { supabase } = require("./supabase");

function generateProtocol() {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);

  return `RS-${year}-${random}`;
}

async function findOrCreateResident(phone) {
  const { data: existing } = await supabase
    .from("residents")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  if (existing) {
    return existing;
  }

  const { data, error } = await supabase
    .from("residents")
    .insert({
      phone,
      status: "active",
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  return data;
}

async function createTicket({
  phone,
  message,
  classification,
  whatsappMessageId,
}) {
  const resident = await findOrCreateResident(phone);

  const protocol = generateProtocol();

  const { data: ticket, error } = await supabase
    .from("tickets")
    .insert({
      protocol,
      resident_id: resident.id,
      category: classification.category,
      priority: classification.priority,
      description: message,
      summary: classification.summary,
      emergency: classification.emergency,
      status: "Novo",
      source: "whatsapp",
    })
    .select()
    .single();

  if (error) {
    throw error;
  }

  await supabase.from("ticket_messages").insert({
    ticket_id: ticket.id,
    sender: "resident",
    message,
    message_type: "text",
    attachment_url: whatsappMessageId,
  });

  return ticket;
}

module.exports = {
  createTicket,
};