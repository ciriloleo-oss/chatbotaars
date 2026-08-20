function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function firstNameOf(fullName = "") {
  return String(fullName || "").trim().split(/\s+/)[0] || "";
}

function naturalizeUserAddress(text = "", fullName = "") {
  let value = String(text || "").trim();
  const firstName = firstNameOf(fullName);

  if (firstName) {
    const name = escapeRegExp(firstName);

    // "Associado Leo" / "Associada Maria" -> "Leo" / "Maria"
    value = value.replace(
      new RegExp(`\\b(?:associado|associada)\\s+${name}\\b`, "gi"),
      firstName
    );

    // "Prezado Associado Leo" -> "Olá, Leo"
    value = value.replace(
      new RegExp(`\\bprezad[oa]\\s+(?:associado|associada)\\s+${name}\\b`, "gi"),
      `Olá, ${firstName}`
    );
  }

  // Remove "associado" quando usado apenas como vocativo.
  value = value
    .replace(/(^|[.!?]\s+)(?:associado|associada)\s*,\s*/gi, "$1")
    .replace(/,\s*(?:associado|associada)\s*(?=[.!?]|$)/gi, "")
    .replace(/\b(?:sr\.?|sra\.?)\s+(?:associado|associada)\b/gi, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();

  return value;
}

function statementWithoutQuestions(text = "", fullName = "") {
  const natural = naturalizeUserAddress(text, fullName);
  if (!natural) return "";

  // Se next_question será exibida separadamente, nenhuma pergunta deve permanecer
  // em suggested_reply. Isso evita duplicidade mesmo quando o modelo gerar duas
  // versões semanticamente equivalentes da mesma pergunta.
  const pieces = natural.match(/[^.!?\n]+[.!?]?|\n+/g) || [];
  const kept = pieces
    .filter((piece) => !piece.includes("?"))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return kept;
}

function singleQuestion(text = "", fullName = "") {
  let value = naturalizeUserAddress(text, fullName)
    .replace(/\s+/g, " ")
    .trim();

  if (!value) return "";

  const firstQuestionMark = value.indexOf("?");
  if (firstQuestionMark >= 0) {
    value = value.slice(0, firstQuestionMark + 1);
  } else {
    value = value.replace(/[.!]+$/, "").trim();
    if (value) value += "?";
  }

  return value;
}

module.exports = {
  firstNameOf,
  naturalizeUserAddress,
  statementWithoutQuestions,
  singleQuestion,
};
