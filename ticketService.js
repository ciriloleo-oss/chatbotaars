const { supabase } = require("./supabase");

function generateProtocol() {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `RS-${year}-${random}`;
}

async function createOrUpdateResident({
  name,
  phone,
  unit,
  block = "",
  email = null,
}) {
  const { data: existing, error: selectError } = await supabase
    .from("residents")
    .select("*")
    .eq("phone", phone)
    .maybeSingle();

  if (selectError) throw selectError;

  if (existing) {
    const updates = {
      name: name || existing.name,
      unit: unit || existing.unit,
      block: block || existing.block,
      status: "active",
    };

    if (email) updates.email = email;

    const { data, error } = await supabase
      .from("residents")
      .update(updates)
      .eq("id", existing.id)
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  const { data, error } = await supabase
    .from("residents")
    .insert({
      name,
      phone,
      unit,
      block: block || null,
      email,
      status: "active",
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function createTicket({
  residentId,
  message,
  classification,
  source,
  resident,
}) {
  const protocol = generateProtocol();

  const description = [
    resident?.name ? `Morador: ${resident.name}` : null,
    resident?.unit ? `Unidade: ${resident.unit}` : null,
    resident?.block ? `Bloco/Setor: ${resident.block}` : null,
    `Solicitação: ${message}`,
  ]
    .filter(Boolean)
    .join("\n");

  const { data, error } = await supabase
    .from("tickets")
    .insert({
      protocol,
      resident_id: residentId,
      category: classification.category || "Outros",
      priority: classification.priority || "MÉDIA",
      status: "Novo",
      description,
      summary: classification.summary || message,
      sentiment: classification.sentiment || null,
      emergency: Boolean(classification.emergency),
      requires_manager: Boolean(classification.requires_manager),
      requires_human: classification.requires_human !== false,
      assigned_to: classification.responsible || ["Recepção"],
      source: source || "web",
    })
    .select()
    .single();

  if (error) throw error;

  await supabase.from("ticket_status_history").insert({
    ticket_id: data.id,
    old_status: null,
    new_status: "Novo",
    changed_by: "chatbot",
    note: `Chamado criado automaticamente via ${source || "web"}.`,
  });

  return data;
}

async function appendTicketMessage(
  ticketId,
  sender,
  message,
  attachmentUrl = null
) {
  const { data, error } = await supabase
    .from("ticket_messages")
    .insert({
      ticket_id: ticketId,
      sender,
      message,
      attachment_url: attachmentUrl,
      message_type: "text",
    })
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function updateTicketClassification(ticketId, classification) {
  const { data, error } = await supabase
    .from("tickets")
    .update({
      category: classification.category || "Outros",
      priority: classification.priority || "MÉDIA",
      summary: classification.summary || null,
      sentiment: classification.sentiment || null,
      emergency: Boolean(classification.emergency),
      requires_manager: Boolean(classification.requires_manager),
      requires_human: classification.requires_human !== false,
      assigned_to: classification.responsible || ["Recepção"],
      updated_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function getConversationMessages(ticketId, limit = 12) {
  const { data, error } = await supabase
    .from("ticket_messages")
    .select("sender,message,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []).reverse();
}

async function getTicketById(ticketId) {
  const { data, error } = await supabase
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

module.exports = {
  createOrUpdateResident,
  createTicket,
  appendTicketMessage,
  updateTicketClassification,
  getConversationMessages,
  getTicketById,
  generateProtocol,
};
