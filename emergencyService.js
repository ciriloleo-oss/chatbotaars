const { supabase } = require("./supabase");

function onlyDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeBrazilPhone(value) {
  let phone = onlyDigits(value).replace(/^0+/, "");
  if (phone.length === 10 || phone.length === 11) phone = `55${phone}`;
  if (!phone.startsWith("55")) return null;
  return phone.length === 12 || phone.length === 13 ? phone : null;
}

function formatPhoneBR(value) {
  let digits = onlyDigits(value);
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.length === 11) return `(${digits.slice(0,2)}) ${digits.slice(2,7)}-${digits.slice(7)}`;
  if (digits.length === 10) return `(${digits.slice(0,2)}) ${digits.slice(2,6)}-${digits.slice(6)}`;
  return value || "Não informado";
}

function evolutionConfig() {
  const baseUrl = String(process.env.EVOLUTION_BASE_URL || "").replace(/\/$/, "");
  const apiKey = String(process.env.EVOLUTION_API_KEY || "");
  const instance = String(process.env.EVOLUTION_INSTANCE || "");
  if (!baseUrl || !apiKey || !instance) {
    const error = new Error("Evolution API não configurada no Railway.");
    error.statusCode = 503;
    throw error;
  }
  return { baseUrl, apiKey, instance };
}

async function callEvolutionText(phone, text) {
  const { baseUrl, apiKey, instance } = evolutionConfig();
  const response = await fetch(`${baseUrl}/message/sendText/${encodeURIComponent(instance)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: apiKey },
    body: JSON.stringify({ number: phone, text, delay: 800, linkPreview: false }),
  });

  const raw = await response.text();
  let json = null;
  try { json = raw ? JSON.parse(raw) : null; }
  catch { json = { raw: raw.slice(0, 1500) }; }
  return { response, raw, json };
}

function providerMessageId(payload) {
  return String(
    payload?.key?.id ||
    payload?.messageId ||
    payload?.id ||
    payload?.response?.key?.id ||
    ""
  ) || null;
}

function buildEmergencyAlertText({ ticket, resident, message, dispatchType = "ALERT" }) {
  const update = dispatchType === "UPDATE";
  const heading = update ? "🚨 ATUALIZAÇÃO DE EMERGÊNCIA AARS" : "🚨 EMERGÊNCIA AARS";
  const parts = [
    heading,
    "",
    `Protocolo: ${ticket.protocol}`,
    resident?.name ? `Associado: ${resident.name}` : null,
    resident?.unit ? `Quadra/Lote: ${resident.unit}` : null,
    resident?.phone ? `Telefone: ${formatPhoneBR(resident.phone)}` : null,
    "",
    update ? "Nova informação:" : "Ocorrência:",
    String(message || ticket.summary || ticket.description || "Emergência identificada.").trim(),
    "",
    "Acompanhe a ocorrência pela Central de OS.",
  ];
  return parts.filter((v) => v !== null).join("\n");
}

async function getTicketResident(ticketId) {
  const { data: ticket, error: ticketError } = await supabase
    .from("tickets")
    .select("id,protocol,resident_id,summary,description,ticket_type,created_at")
    .eq("id", ticketId)
    .maybeSingle();
  if (ticketError) throw ticketError;
  if (!ticket) return null;

  let resident = null;
  if (ticket.resident_id) {
    const { data, error } = await supabase
      .from("residents")
      .select("id,name,unit,phone")
      .eq("id", ticket.resident_id)
      .maybeSingle();
    if (error) throw error;
    resident = data || null;
  }
  return { ticket, resident };
}

async function listEmergencyRecipients({ includeInactive = true } = {}) {
  let query = supabase
    .from("emergency_recipients")
    .select("id,name,role,phone,active,receive_test_alerts,sort_order,created_at,updated_at")
    .order("sort_order", { ascending: true })
    .order("name", { ascending: true });
  if (!includeInactive) query = query.eq("active", true);
  const { data, error } = await query;
  if (error) throw error;
  return data || [];
}

async function saveEmergencyRecipient({ id = null, name, role = "", phone, active = true, receiveTestAlerts = false, sortOrder = 100 }) {
  const normalized = normalizeBrazilPhone(phone);
  if (!String(name || "").trim()) {
    const error = new Error("Informe o nome do contato."); error.statusCode = 400; throw error;
  }
  if (!normalized) {
    const error = new Error("Informe um celular válido com DDD."); error.statusCode = 400; throw error;
  }

  const payload = {
    name: String(name).trim().slice(0, 100),
    role: String(role || "").trim().slice(0, 100) || null,
    phone: normalized,
    active: Boolean(active),
    receive_test_alerts: Boolean(receiveTestAlerts),
    sort_order: Math.max(0, Math.min(Number(sortOrder) || 100, 9999)),
    updated_at: new Date().toISOString(),
  };

  let query = supabase.from("emergency_recipients");
  if (id) query = query.update(payload).eq("id", id);
  else query = query.insert(payload);
  const { data, error } = await query.select().single();
  if (error) {
    if (error.code === "23505") {
      const e = new Error("Este telefone já está cadastrado como contato de emergência.");
      e.statusCode = 409; throw e;
    }
    throw error;
  }
  return data;
}

async function dispatchEmergencyMessage({ ticketId, ticketMessageId, message, dispatchType = "ALERT" }) {
  const context = await getTicketResident(ticketId);
  if (!context) return { success: false, reason: "ticket_not_found", dispatches: [] };
  const { ticket, resident } = context;

  let recipients = await listEmergencyRecipients({ includeInactive: false });
  if (ticket.ticket_type === "TESTE") {
    recipients = recipients.filter((r) => r.receive_test_alerts);
  }

  if (!recipients.length) {
    console.warn("Emergência identificada sem destinatários ativos configurados", {
      protocol: ticket.protocol,
      ticketType: ticket.ticket_type,
    });
    return { success: true, noRecipients: true, dispatches: [] };
  }

  const text = buildEmergencyAlertText({ ticket, resident, message, dispatchType });
  const results = [];

  for (const recipient of recipients) {
    const snapshot = {
      ticket_id: ticket.id,
      ticket_message_id: ticketMessageId || null,
      recipient_id: recipient.id,
      recipient_name_snapshot: recipient.name,
      role_snapshot: recipient.role || null,
      phone_snapshot: recipient.phone,
      ticket_type: ticket.ticket_type === "TESTE" ? "TESTE" : "REAL",
      dispatch_type: dispatchType,
      status: "pending",
      attempt_count: 0,
    };

    let dispatch = null;
    if (ticketMessageId) {
      const { data: existing, error: existingError } = await supabase
        .from("emergency_dispatches")
        .select("*")
        .eq("ticket_message_id", ticketMessageId)
        .eq("recipient_id", recipient.id)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existing?.status === "sent") {
        results.push(existing);
        continue;
      }
      dispatch = existing || null;
    }

    if (!dispatch) {
      const { data, error } = await supabase
        .from("emergency_dispatches")
        .insert(snapshot)
        .select()
        .single();
      if (error) {
        if (error.code === "23505" && ticketMessageId) {
          const { data: existing } = await supabase
            .from("emergency_dispatches").select("*")
            .eq("ticket_message_id", ticketMessageId).eq("recipient_id", recipient.id).maybeSingle();
          dispatch = existing || null;
        } else throw error;
      } else dispatch = data;
    }

    if (!dispatch) continue;

    try {
      const evo = await callEvolutionText(recipient.phone, text);
      const update = evo.response.ok ? {
        status: "sent",
        attempt_count: Number(dispatch.attempt_count || 0) + 1,
        provider_message_id: providerMessageId(evo.json),
        provider_response: evo.json,
        last_error: null,
        sent_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } : {
        status: "failed",
        attempt_count: Number(dispatch.attempt_count || 0) + 1,
        provider_response: evo.json,
        last_error: `HTTP ${evo.response.status}: ${String(evo.raw || "").slice(0, 800)}`,
        updated_at: new Date().toISOString(),
      };

      const { data: saved, error } = await supabase
        .from("emergency_dispatches")
        .update(update)
        .eq("id", dispatch.id)
        .select()
        .single();
      if (error) throw error;
      results.push(saved);
    } catch (error) {
      const { data: failed } = await supabase
        .from("emergency_dispatches")
        .update({
          status: "failed",
          attempt_count: Number(dispatch.attempt_count || 0) + 1,
          last_error: String(error.message || error).slice(0, 1000),
          updated_at: new Date().toISOString(),
        })
        .eq("id", dispatch.id)
        .select()
        .maybeSingle();
      if (failed) results.push(failed);
      console.error("Falha ao despachar emergência:", { protocol: ticket.protocol, recipient: recipient.name, message: error.message });
    }
  }

  return { success: true, text, dispatches: results };
}

async function sendEmergencyTest(recipientId) {
  const { data: recipient, error } = await supabase
    .from("emergency_recipients")
    .select("*")
    .eq("id", recipientId)
    .maybeSingle();
  if (error) throw error;
  if (!recipient) { const e = new Error("Contato não encontrado."); e.statusCode = 404; throw e; }

  const text = [
    "🧪 TESTE DE ALERTA AARS",
    "",
    `Olá, ${recipient.name}.`,
    "Este é um teste da rotina automática de emergências da Central de OS.",
    "",
    "Se você recebeu esta mensagem, o canal de alerta está funcionando.",
  ].join("\n");

  const evo = await callEvolutionText(recipient.phone, text);
  const { data: row, error: insertError } = await supabase
    .from("emergency_dispatches")
    .insert({
      ticket_id: null,
      ticket_message_id: null,
      recipient_id: recipient.id,
      recipient_name_snapshot: recipient.name,
      role_snapshot: recipient.role || null,
      phone_snapshot: recipient.phone,
      ticket_type: "TESTE",
      dispatch_type: "TEST",
      status: evo.response.ok ? "sent" : "failed",
      attempt_count: 1,
      provider_message_id: providerMessageId(evo.json),
      provider_response: evo.json,
      last_error: evo.response.ok ? null : `HTTP ${evo.response.status}: ${String(evo.raw || "").slice(0, 800)}`,
      sent_at: evo.response.ok ? new Date().toISOString() : null,
    })
    .select()
    .single();
  if (insertError) throw insertError;

  if (!evo.response.ok) {
    const e = new Error(`A Evolution API recusou o teste (HTTP ${evo.response.status}).`);
    e.statusCode = 502; throw e;
  }
  return row;
}

async function getEmergencyDispatchesForTicket(ticketId) {
  const { data, error } = await supabase
    .from("emergency_dispatches")
    .select("id,recipient_name_snapshot,role_snapshot,phone_snapshot,ticket_type,dispatch_type,status,attempt_count,last_error,sent_at,created_at")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

module.exports = {
  normalizeBrazilPhone,
  listEmergencyRecipients,
  saveEmergencyRecipient,
  dispatchEmergencyMessage,
  sendEmergencyTest,
  getEmergencyDispatchesForTicket,
};
