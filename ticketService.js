const { supabase } = require("./supabase");

function generateProtocol() {
  const year = new Date().getFullYear();
  const random = Math.floor(10000 + Math.random() * 90000);
  return `RS-${year}-${random}`;
}

async function createOrUpdateResident({ name, phone, unit, block = "", email = null }) {
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
  ticketType = "REAL",
  conversationId = null,
}) {
  const protocol = generateProtocol();

  const description = [
    resident?.name ? `Associado: ${resident.name}` : null,
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
      emergency: Boolean(classification.emergency),
      requires_manager: Boolean(classification.requires_manager),
      requires_human: classification.requires_human !== false,
      assigned_to: classification.responsible || ["Recepção"],
      source: source || "web",
      ticket_type: ticketType === "TESTE" ? "TESTE" : "REAL",
      conversation_id: conversationId || null,
    })
    .select()
    .single();

  if (error) throw error;

  const { error: historyError } = await supabase
    .from("ticket_status_history")
    .insert({
      ticket_id: data.id,
      old_status: null,
      new_status: "Novo",
      changed_by: "chatbot",
      note: `${ticketType === "TESTE" ? "[TESTE] " : ""}Atendimento criado automaticamente via ${source || "web"}.`,
    });

  if (historyError) {
    console.warn("Não foi possível gravar histórico inicial do status:", historyError.message);
  }

  return data;
}

async function appendTicketMessage(ticketId, sender, message, attachmentUrl = null) {
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
  const updates = {
    category: classification.category || "Outros",
    priority: classification.priority || "MÉDIA",
    summary: classification.summary || null,
    emergency: Boolean(classification.emergency),
    requires_manager: Boolean(classification.requires_manager),
    requires_human: classification.requires_human !== false,
    assigned_to: classification.responsible || ["Recepção"],
  };

  const { data, error } = await supabase
    .from("tickets")
    .update(updates)
    .eq("id", ticketId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

async function ensureTicketConversationId(ticketId, conversationId) {
  if (!ticketId || !conversationId) return null;

  const { data, error } = await supabase
    .from("tickets")
    .update({ conversation_id: conversationId })
    .eq("id", ticketId)
    .is("conversation_id", null)
    .select("id,conversation_id")
    .maybeSingle();

  if (error) throw error;
  return data || null;
}

async function getConversationMessages(ticketId, limit = 14) {
  const { data, error } = await supabase
    .from("ticket_messages")
    .select("sender,message,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) throw error;
  return (data || []).reverse();
}

async function getStaffReplies(ticketId, limit = 100) {
  const { data, error } = await supabase
    .from("ticket_messages")
    .select("id,ticket_id,message,created_at")
    .eq("ticket_id", ticketId)
    .eq("sender", "staff")
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 200));

  if (error) throw error;
  return data || [];
}

async function getStaffRepliesForTickets(ticketIds = [], limit = 200) {
  const ids = [...new Set((ticketIds || []).filter(Boolean))].slice(-12);
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("ticket_messages")
    .select("id,ticket_id,message,created_at")
    .in("ticket_id", ids)
    .eq("sender", "staff")
    .order("created_at", { ascending: true })
    .limit(Math.min(Math.max(Number(limit) || 200, 1), 300));

  if (error) throw error;
  return data || [];
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

async function getTicketsByIds(ticketIds = []) {
  const ids = [...new Set((ticketIds || []).filter(Boolean))].slice(-12);
  if (!ids.length) return [];

  const { data, error } = await supabase
    .from("tickets")
    .select("*")
    .in("id", ids);

  if (error) throw error;

  const order = new Map(ids.map((id, index) => [id, index]));
  return (data || []).sort(
    (a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999)
  );
}

module.exports = {
  createOrUpdateResident,
  createTicket,
  appendTicketMessage,
  updateTicketClassification,
  ensureTicketConversationId,
  getConversationMessages,
  getStaffReplies,
  getStaffRepliesForTickets,
  getTicketById,
  getTicketsByIds,
  generateProtocol,
};
