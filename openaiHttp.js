function getApiKey() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY não configurada");
  return apiKey;
}

async function openaiRequest(path, options = {}) {
  const response = await fetch(`https://api.openai.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      ...(options.body instanceof FormData ? {} : { "Content-Type": "application/json" }),
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    const err = new Error(
      data?.error?.message || `OpenAI API retornou HTTP ${response.status}`
    );
    err.status = response.status;
    err.data = data;
    throw err;
  }

  return data;
}

function extractOutputText(response) {
  const parts = [];
  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      if (part?.type === "output_text" && part.text) parts.push(part.text);
    }
  }
  return parts.join("\n").trim();
}

function extractFileCitations(response) {
  const citations = [];

  for (const item of response?.output || []) {
    if (item?.type !== "message") continue;
    for (const part of item.content || []) {
      if (part?.type !== "output_text") continue;
      for (const ann of part.annotations || []) {
        if (ann?.type !== "file_citation") continue;
        citations.push({
          fileId: ann.file_id || null,
          filename: ann.filename || "Documento oficial",
        });
      }
    }
  }

  const unique = new Map();
  citations.forEach((item) => unique.set(`${item.fileId}:${item.filename}`, item));
  return [...unique.values()];
}

function extractFileSearchResults(response) {
  const results = [];
  for (const item of response?.output || []) {
    if (item?.type === "file_search_call" && Array.isArray(item.results)) {
      results.push(...item.results);
    }
  }
  return results;
}

module.exports = {
  openaiRequest,
  extractOutputText,
  extractFileCitations,
  extractFileSearchResults,
};
