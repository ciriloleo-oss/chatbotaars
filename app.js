(() => {
  const config = window.RESERVA_CONFIG || {};
  const API_BASE_URL = String(config.API_BASE_URL || "").replace(/\/+$/, "");

  const storageKeys = {
    profile: "rs_profile_v1",
    sessionToken: "rs_session_token_v1",
    protocol: "rs_protocol_v1",
    history: "rs_history_v1",
  };

  const $ = (id) => document.getElementById(id);

  const welcomeView = $("welcomeView");
  const chatView = $("chatView");
  const profileForm = $("profileForm");
  const messageForm = $("messageForm");
  const messageInput = $("messageInput");
  const messageList = $("messageList");
  const typingIndicator = $("typingIndicator");
  const protocolBadge = $("protocolBadge");
  const newServiceBtn = $("newServiceBtn");
  const sendBtn = $("sendBtn");
  const privacyLink = $("privacyLink");

  let profile = readJSON(storageKeys.profile);
  let sessionToken = localStorage.getItem(storageKeys.sessionToken) || "";
  let protocol = localStorage.getItem(storageKeys.protocol) || "";
  let history = readJSON(storageKeys.history) || [];
  let sending = false;

  function readJSON(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "null");
    } catch {
      return null;
    }
  }

  function saveHistory() {
    localStorage.setItem(storageKeys.history, JSON.stringify(history.slice(-80)));
  }

  function nowLabel() {
    return new Intl.DateTimeFormat("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  }

  function normalizePhone(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.startsWith("55")) return digits;
    if (digits.length === 10 || digits.length === 11) return `55${digits}`;
    return digits;
  }

  function setView(view) {
    const chatting = view === "chat";
    welcomeView.hidden = chatting;
    chatView.hidden = !chatting;
    newServiceBtn.hidden = !chatting;
  }

  function addMessage(role, text, time = nowLabel(), persist = true) {
    const row = document.createElement("div");
    row.className = `message-row ${role}`;

    const bubble = document.createElement("div");
    bubble.className = "message-bubble";

    const content = document.createElement("div");
    content.textContent = text;

    const meta = document.createElement("span");
    meta.className = "message-meta";
    meta.textContent = role === "user" ? `Você • ${time}` : `Assistente • ${time}`;

    bubble.append(content, meta);
    row.appendChild(bubble);
    messageList.appendChild(row);

    if (persist) {
      history.push({ role, text, time });
      saveHistory();
    }

    requestAnimationFrame(() => {
      messageList.scrollTop = messageList.scrollHeight;
    });
  }

  function renderHistory() {
    messageList.innerHTML = "";
    history.forEach((item) => addMessage(item.role, item.text, item.time, false));
  }

  function updateProtocol(value) {
    protocol = value || "";
    if (protocol) {
      protocolBadge.hidden = false;
      protocolBadge.textContent = `Protocolo ${protocol}`;
      localStorage.setItem(storageKeys.protocol, protocol);
    } else {
      protocolBadge.hidden = true;
      protocolBadge.textContent = "";
      localStorage.removeItem(storageKeys.protocol);
    }
  }

  function autoResize() {
    messageInput.style.height = "auto";
    messageInput.style.height = `${Math.min(messageInput.scrollHeight, 130)}px`;
  }

  function setSending(value) {
    sending = value;
    sendBtn.disabled = value;
    messageInput.disabled = value;
    typingIndicator.hidden = !value;
  }

  async function sendToApi(message) {
    if (!API_BASE_URL) {
      throw new Error("API_BASE_URL não configurada no config.js");
    }

    const response = await fetch(`${API_BASE_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionToken: sessionToken || null,
        resident: profile,
        message,
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.error || "Não foi possível concluir o atendimento.");
    }

    return data;
  }

  profileForm.addEventListener("submit", (event) => {
    event.preventDefault();

    const name = $("nameInput").value.trim();
    const unit = $("unitInput").value.trim();
    const block = $("blockInput").value.trim();
    const phone = normalizePhone($("phoneInput").value);

    if (!name || !unit || phone.length < 12) {
      alert("Confira seu nome, unidade e telefone antes de continuar.");
      return;
    }

    profile = { name, unit, block, phone };
    localStorage.setItem(storageKeys.profile, JSON.stringify(profile));

    sessionToken = "";
    protocol = "";
    history = [];

    localStorage.removeItem(storageKeys.sessionToken);
    localStorage.removeItem(storageKeys.protocol);
    localStorage.removeItem(storageKeys.history);

    setView("chat");

    addMessage(
      "assistant",
      `Olá, ${name.split(" ")[0]}! Sou o assistente virtual do Reserva da Serra. Descreva sua solicitação, reclamação, dúvida ou ocorrência.`
    );

    messageInput.focus();
  });

  messageForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (sending) return;

    const text = messageInput.value.trim();
    if (!text) return;

    messageInput.value = "";
    autoResize();
    addMessage("user", text);
    setSending(true);

    try {
      const data = await sendToApi(text);

      if (data.sessionToken) {
        sessionToken = data.sessionToken;
        localStorage.setItem(storageKeys.sessionToken, sessionToken);
      }

      if (data.protocol) updateProtocol(data.protocol);

      addMessage(
        "assistant",
        data.reply || "Sua mensagem foi registrada. A equipe responsável dará continuidade ao atendimento."
      );
    } catch (error) {
      addMessage(
        "assistant",
        `Não consegui concluir o envio agora. Por favor, tente novamente em alguns instantes.\n\nDetalhe: ${error.message}`
      );
    } finally {
      setSending(false);
      messageInput.focus();
    }
  });

  messageInput.addEventListener("input", autoResize);

  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      messageForm.requestSubmit();
    }
  });

  newServiceBtn.addEventListener("click", () => {
    if (!confirm("Deseja encerrar esta conversa e iniciar um novo atendimento?")) return;

    sessionToken = "";
    protocol = "";
    history = [];

    localStorage.removeItem(storageKeys.sessionToken);
    localStorage.removeItem(storageKeys.protocol);
    localStorage.removeItem(storageKeys.history);

    messageList.innerHTML = "";
    updateProtocol("");

    setView("chat");
    addMessage(
      "assistant",
      `Olá, ${profile?.name?.split(" ")[0] || ""}! Vamos iniciar um novo atendimento. Como posso ajudar?`
    );
    messageInput.focus();
  });

  if (config.PRIVACY_URL) {
    privacyLink.href = config.PRIVACY_URL;
    privacyLink.hidden = false;
  }

  if (profile) {
    $("nameInput").value = profile.name || "";
    $("unitInput").value = profile.unit || "";
    $("blockInput").value = profile.block || "";
    $("phoneInput").value = profile.phone || "";
  }

  if (profile && history.length) {
    setView("chat");
    renderHistory();
    updateProtocol(protocol);
  } else {
    setView("welcome");
  }
})();
