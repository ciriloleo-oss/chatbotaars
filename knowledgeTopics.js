const TOPICS = [
  {
    key: "SOCIETY",
    match: /\bsociety\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 10 - uso da Quadra Poliesportiva e Campos de Futebol, com atenção ao Minicampo de Futebol.",
    directPdfFirst: true,
    guard: [
      "O Regulamento Interno não nomeia uma instalação como 'Society'. Ele menciona Campo de Futebol, Minicampo de Futebol e também a expressão 'chuteira de Society'.",
      "Nunca interprete a expressão 'chuteira de Society' como nome de uma instalação.",
      "Se o usuário disser 'society' referindo-se a uma instalação, não aplique automaticamente regras exclusivas do Campo de Futebol (campo maior).",
      "Para horário, reserva, duração de reserva e número de convidados, use somente regras que o item 10 declare conjuntamente para Quadra Poliesportiva, Campo de Futebol e Minicampo de Futebol.",
      "Se a pergunta depender de uma diferença entre Campo de Futebol e Minicampo e o termo 'society' não permitir concluir qual deles é, informe que o RI usa o nome 'Minicampo de Futebol' e peça confirmação de forma breve."
    ],
    forbiddenLeak: /\b14\s+jogadores\b|\bcampo maior\b|\bgrama natural\b|\bdias secos\b/i,
  },
  {
    key: "ACADEMIA",
    match: /\bacademia\b|\bsala de gin[aá]stica\b|\bgin[aá]stica\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 9 - DO USO DA ACADEMIA, especialmente o item 9.1 quando a pergunta for sobre horário ou idade.",
    directPdfFirst: true,
    guard: [
      "Use exclusivamente as regras do item 9 para responder sobre a academia.",
      "Não empreste horários, regras de convidados ou reservas das seções de quadras, campos, salões ou salão de jogos.",
      "Se o trecho recuperado continuar para o item 10, desconsidere as regras do item 10 ao responder sobre academia."
    ],
    forbiddenLeak: /\bquadra\b|\bcampo\b|\bminicampo\b|\bsociety\b|\bsal[aã]o de jogos\b/i,
  },
  {
    key: "MINICAMPO",
    match: /\bminicampo\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 10 - Minicampo de Futebol.",
    directPdfFirst: true,
    guard: [
      "Diferencie Minicampo de Futebol de Campo de Futebol (campo maior).",
      "Não aplique ao Minicampo regras que o texto declare apenas para o Campo de Futebol (campo maior), salvo se o próprio item disser que a regra vale para os campos em conjunto."
    ],
    forbiddenLeak: /\bcampo maior\b.*\b14\s+jogadores\b/i,
  },
  {
    key: "CAMPO_MAIOR",
    match: /\bcampo maior\b|\bcampo de futebol\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 10 - Campo de Futebol. Diferencie do Minicampo de Futebol.",
    directPdfFirst: true,
    guard: [
      "Quando a regra for exclusiva do Campo de Futebol (campo maior), deixe isso claro.",
      "Não atribua regras exclusivas do campo maior ao Minicampo."
    ],
  },
  {
    key: "QUADRA_POLIESPORTIVA",
    match: /\bquadra poliesportiva\b|\bpoliesportiva\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 10 - Quadra Poliesportiva.",
    directPdfFirst: true,
    guard: ["Não confunda a Quadra Poliesportiva com Campo de Futebol, Minicampo ou quadras de tênis."],
  },
  {
    key: "TENIS",
    match: /\bquadra(?:s)? de t[eê]nis\b|\bt[eê]nis\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 11 - DO USO DAS QUADRAS DE TÊNIS.",
    directPdfFirst: true,
    guard: ["Use somente as regras do item 11 ao responder sobre quadras de tênis."],
  },
  {
    key: "QUADRA_AREIA",
    match: /\bquadra(?:s)? de areia\b|\bbeach tennis\b|\bfutev[oô]lei\b|\bv[oô]lei de areia\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 13 - DO USO DAS QUADRAS DE AREIA.",
    directPdfFirst: true,
    guard: ["Use somente as regras do item 13 para as quadras de areia."],
  },
  {
    key: "PISCINA",
    match: /\bpiscina(?:s)?\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 7 - DO USO DAS PISCINAS.",
    directPdfFirst: true,
    guard: ["Use somente as regras do item 7 ao responder sobre piscinas."],
  },
  {
    key: "CHURRASQUEIRA",
    match: /\bchurrasqueira(?:s)?\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 8 - DO USO DAS CHURRASQUEIRAS.",
    directPdfFirst: true,
    guard: ["Use somente as regras do item 8 ao responder sobre churrasqueiras."],
  },
  {
    key: "SAUNA",
    match: /\bsauna\b|\bsala de massagem\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 12 - DO USO DA SAUNA / SALA DE MASSAGEM.",
    directPdfFirst: true,
    guard: ["Use o item 12 e preserve eventuais remissões expressas feitas pelo próprio item a outras seções."],
  },
  {
    key: "LAGO",
    match: /\blago\b|\bpesca\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 14 - DO USO DO LAGO.",
    directPdfFirst: true,
    guard: ["Use somente as regras do item 14 para uso do lago e pesca."],
  },
  {
    key: "BRINQUEDOTECA",
    match: /\bbrinquedoteca\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 15 - DO USO DA BRINQUEDOTECA.",
    directPdfFirst: true,
    guard: ["Use somente as regras do item 15 para a brinquedoteca."],
  },
  {
    key: "SALAO_FESTAS",
    match: /\bsal[aã]o(?:es)? de festa(?:s)?\b|\bsal[aã]o do lago\b|\bsal[aã]o da piscina\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 16 - DO USO DOS SALÕES DE FESTAS, observando os subitens específicos de cada salão.",
    directPdfFirst: true,
    guard: ["Diferencie Salão do Lago de Salão da Piscina quando a regra for específica de um deles."],
  },
  {
    key: "SALAO_JOGOS",
    match: /\bsal[aã]o(?:es)? de jogos\b|\bsinuca\b/i,
    scope: "RI",
    focus: "Regulamento Interno, item 17 - DO USO DOS SALÕES DE JOGOS.",
    directPdfFirst: true,
    guard: ["Use somente as regras do item 17 para os salões de jogos."],
  },
];

function detectKnowledgeTopic(question = "") {
  const text = String(question || "").trim();
  return TOPICS.find((topic) => topic.match.test(text)) || null;
}

function buildTopicInstruction(topic) {
  if (!topic) return "";

  const guard = (topic.guard || []).map((item, index) => `${index + 1}. ${item}`).join("\n");

  return `
ALVO DOCUMENTAL OBRIGATÓRIO:
- Assunto identificado: ${topic.key}
- Foco: ${topic.focus}
${guard ? `- Regras de desambiguação:\n${guard}` : ""}

REGRA DE ISOLAMENTO DE ASSUNTO:
- Uma mesma página ou trecho pode conter o fim de uma seção e o começo da seguinte. Não misture regras entre seções.
- Só use um horário, limite, condição, quantidade, reserva ou restrição se o texto recuperado deixar claro que ele pertence ao assunto perguntado.
- Se houver duas instalações parecidas, preserve o nome exato usado no documento e não transfira regras específicas de uma para outra.
`;
}

function answerLeaksTopic(answer = "", topic = null) {
  if (!topic || !topic.forbiddenLeak) return false;
  return topic.forbiddenLeak.test(String(answer || ""));
}

module.exports = {
  detectKnowledgeTopic,
  buildTopicInstruction,
  answerLeaksTopic,
};
