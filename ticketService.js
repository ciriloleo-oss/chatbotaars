const { supabase } = require("./supabase");

function generateProtocol() {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `RS-${year}-${random}`;
}

async function findOrCreateResident(phone) {
  const { data: existing, error: selectError } = await supabase
    .from("residents")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  if (selectError) {
    throw selectError;
  }

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

async function createTicket({ phone, message, classification }) {
  const resident = await findOrCreateResident(phone);
  const protocol = generateProtocol();

  const { data: ticket, error } = await supabase
    .from("tickets")
    .insert({
      protocol,
      resident_id: resident.id,
      category: classification.category || "Outros",
      priority: classification.priority || "Média",
      description: message,
      summary: classification.summary || message,
      sentiment: classification.sentiment || null,
      emergency: classification.emergency || false,
      requires_manager: classification.requires_manager || false,
      requires_human:
        classification.requires_human === undefined
          ? true
          : classification.requires_human,
      assigned_to: classification.responsible || ["Recepção"],
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
  });

  await supabase.from("ticket_status_history").insert({
    ticket_id: ticket.id,
    old_status: null,
    new_status: "Novo",
    changed_by: "chatbot",
    note: "Chamado criado automaticamente pelo WhatsApp.",
  });

  return ticket;
}

module.exports = {
  createTicket,
  findOrCreateResident,
  generateProtocol,
};
