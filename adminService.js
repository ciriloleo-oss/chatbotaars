const { getEmergencyDispatchesForTicket } = require("./emergencyService");
const { supabase } = require("./supabase");

const CLOSED_STATUSES = new Set(["Resolvido", "Encerrado"]);
const ALLOWED_STATUSES = new Set([
  "Novo",
  "Em atendimento",
  "Aguardando associado",
  "Resolvido",
  "Encerrado",
]);


async function listTicketsForAdmin({ ticketType = "REAL", limit = 300 } = {}) {
  let query = supabase
    .from("tickets")
    .select(
      "id,protocol,resident_id,category,priority,status,summary,emergency,requires_manager,requires_human,assigned_to,source,created_at,updated_at,ticket_type,conversation_id"
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

  let relatedTickets = [];
  if (ticket.conversation_id) {
    const { data: related, error: relatedError } = await supabase
      .from("tickets")
      .select("id,protocol,category,priority,status,summary,ticket_type,created_at,conversation_id")
      .eq("conversation_id", ticket.conversation_id)
      .order("created_at", { ascending: true });

    if (relatedError) {
      console.warn("Não foi possível carregar protocolos relacionados:", relatedError.message);
    } else {
      const rows = related || [];
      const originId = rows.length ? rows[0].id : null;
      relatedTickets = rows.map((item) => ({
        ...item,
        is_origin: item.id === originId,
        is_current: item.id === ticket.id,
      }));
    }
  }

  let emergencyDispatches = [];
  try {
    emergencyDispatches = await getEmergencyDispatchesForTicket(ticketId);
  } catch (dispatchError) {
    console.warn("Não foi possível carregar os disparos de emergência:", dispatchError.message);
  }

  return {
    ticket,
    resident,
    messages: messages || [],
    status_history: history || [],
    related_tickets: relatedTickets,
    emergency_dispatches: emergencyDispatches,
  };
}

async function replyToTicketForAdmin({ ticketId, message, status = null, changedBy = "admin" }) {
  const cleanMessage = String(message || "").trim().slice(0, 3000);
  if (!cleanMessage) throw new Error("Digite uma mensagem para o associado.");

  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id,status,protocol")
    .eq("id", ticketId)
    .maybeSingle();

  if (ticketError) throw ticketError;
  if (!ticket) return null;

  const { error: messageError } = await supabase.from("ticket_messages").insert({
    ticket_id: ticketId,
    sender: "staff",
    message: cleanMessage,
    message_type: "text",
  });
  if (messageError) throw messageError;

  let targetStatus = ALLOWED_STATUSES.has(status) ? status : null;
  if (!targetStatus && ticket.status === "Novo") targetStatus = "Em atendimento";

  if (targetStatus && targetStatus !== ticket.status) {
    const { error: updateError } = await supabase
      .from("tickets")
      .update({ status: targetStatus, updated_at: new Date().toISOString() })
      .eq("id", ticketId);
    if (updateError) throw updateError;

    const { error: historyError } = await supabase.from("ticket_status_history").insert({
      ticket_id: ticketId,
      old_status: ticket.status,
      new_status: targetStatus,
      changed_by: changedBy,
      note: "Status atualizado ao enviar retorno ao associado.",
    });
    if (historyError) {
      console.warn("Não foi possível gravar histórico do retorno:", historyError.message);
    }
  }

  return getTicketDetailForAdmin(ticketId);
}

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeBrazilPhone(value) {
  let phone = onlyDigits(value).replace(/^0+/, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  if (!phone.startsWith("55")) return null;
  return phone.length === 12 || phone.length === 13 ? phone : null;
}

function maskPhone(value) {
  const digits = onlyDigits(value);
  if (digits.length < 4) return "****";
  return `••••${digits.slice(-4)}`;
}

async function updateResidentPhoneForAdmin({ ticketId, phone, changedBy = "admin" }) {
  const normalized = normalizeBrazilPhone(phone);
  if (!normalized) {
    const error = new Error("Informe um celular válido com DDD.");
    error.statusCode = 400;
    throw error;
  }

  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id,protocol,resident_id,status")
    .eq("id", ticketId)
    .maybeSingle();

  if (ticketError) throw ticketError;
  if (!ticket) return null;
  if (!ticket.resident_id) {
    const error = new Error("Esta OS não possui associado vinculado.");
    error.statusCode = 400;
    throw error;
  }

  const { data: resident, error: residentError } = await supabase
    .from("residents")
    .select("id,name,phone")
    .eq("id", ticket.resident_id)
    .maybeSingle();

  if (residentError) throw residentError;
  if (!resident) {
    const error = new Error("Cadastro do associado não encontrado.");
    error.statusCode = 404;
    throw error;
  }

  const { data: duplicate, error: duplicateError } = await supabase
    .from("residents")
    .select("id,name,unit")
    .eq("phone", normalized)
    .neq("id", resident.id)
    .limit(1)
    .maybeSingle();

  if (duplicateError) throw duplicateError;
  if (duplicate) {
    const error = new Error("Este celular já está vinculado a outro cadastro.");
    error.statusCode = 409;
    throw error;
  }

  const previousPhone = resident.phone || "";
  const { error: updateError } = await supabase
    .from("residents")
    .update({ phone: normalized })
    .eq("id", resident.id);

  if (updateError) throw updateError;

  if (onlyDigits(previousPhone) !== normalized) {
    const { error: historyError } = await supabase
      .from("ticket_status_history")
      .insert({
        ticket_id: ticket.id,
        old_status: ticket.status || "Novo",
        new_status: ticket.status || "Novo",
        changed_by: changedBy,
        note: `Celular do associado atualizado no painel: ${maskPhone(previousPhone)} → ${maskPhone(normalized)}.`,
      });

    if (historyError) {
      console.warn("Não foi possível gravar histórico da alteração de celular:", historyError.message);
    }
  }

  return getTicketDetailForAdmin(ticketId);
}

module.exports = {
  listTicketsForAdmin,
  getTicketDetailForAdmin,
  replyToTicketForAdmin,
  updateResidentPhoneForAdmin,
};
