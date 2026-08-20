const { supabase } = require("./supabase");

const CLOSED_STATUSES = new Set(["Resolvido", "Encerrado"]);

async function listTicketsForAdmin({ ticketType = "REAL", limit = 300 } = {}) {
  let query = supabase
    .from("tickets")
    .select(
      "id,protocol,resident_id,category,priority,status,summary,emergency,requires_manager,requires_human,assigned_to,source,created_at,updated_at,ticket_type"
    )
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(Number(limit) || 300, 1), 500));

  if (ticketType === "REAL" || ticketType === "TESTE") {
    query = query.eq("ticket_type", ticketType);
  }

  const { data: tickets, error } = await query;
  if (error) throw error;

  const residentIds = [...new Set((tickets || []).map((t) => t.resident_id).filter(Boolean))];
  const residentMap = new Map();

  if (residentIds.length) {
    const { data: residents, error: residentError } = await supabase
      .from("residents")
      .select("id,name,unit,block,phone")
      .in("id", residentIds);

    if (residentError) throw residentError;
    (residents || []).forEach((resident) => residentMap.set(resident.id, resident));
  }

  return (tickets || []).map((ticket) => {
    const resident = residentMap.get(ticket.resident_id) || null;
    return {
      ...ticket,
      is_open: !CLOSED_STATUSES.has(ticket.status),
      associated_name: resident?.name || null,
      quadra_lote: resident?.unit || null,
      block: resident?.block || null,
      phone: resident?.phone || null,
    };
  });
}

async function getTicketDetailForAdmin(ticketId) {
  const { data: ticket, error } = await supabase
    .from("tickets")
    .select("*")
    .eq("id", ticketId)
    .maybeSingle();

  if (error) throw error;
  if (!ticket) return null;

  let resident = null;
  if (ticket.resident_id) {
    const { data, error: residentError } = await supabase
      .from("residents")
      .select("id,name,unit,block,phone,status")
      .eq("id", ticket.resident_id)
      .maybeSingle();
    if (residentError) throw residentError;
    resident = data || null;
  }

  const { data: messages, error: messageError } = await supabase
    .from("ticket_messages")
    .select("id,sender,message,message_type,attachment_url,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });
  if (messageError) throw messageError;

  const { data: history, error: historyError } = await supabase
    .from("ticket_status_history")
    .select("id,old_status,new_status,changed_by,note,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: true });

  if (historyError) {
    console.warn("Não foi possível carregar histórico de status:", historyError.message);
  }

  return {
    ticket,
    resident,
    messages: messages || [],
    status_history: history || [],
  };
}

module.exports = {
  listTicketsForAdmin,
  getTicketDetailForAdmin,
};
