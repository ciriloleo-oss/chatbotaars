require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { openaiRequest } = require("../openaiHttp");

const ROOT = path.resolve(__dirname, "..");
const sources = [
  {
    path: path.join(ROOT, "knowledge", "official", "estatuto-social-aars.pdf"),
    type: "estatuto",
    title: "Estatuto Social da Associação dos Amigos do Reserva da Serra",
  },
  {
    path: path.join(ROOT, "knowledge", "official", "regulamento-interno-aars.pdf"),
    type: "regulamento_interno",
    title: "Regulamento Interno do Reserva da Serra",
  },
];

async function uploadFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Arquivo não encontrado: ${filePath}`);
  }

  const bytes = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("purpose", "user_data");
  form.append(
    "file",
    new Blob([bytes], { type: "application/pdf" }),
    path.basename(filePath)
  );

  return openaiRequest("/files", {
    method: "POST",
    body: form,
  });
}

async function createVectorStore() {
  return openaiRequest("/vector_stores", {
    method: "POST",
    body: JSON.stringify({
      name: "AARS - Documentos Oficiais Vigentes",
    }),
  });
}

async function attachFile(vectorStoreId, file, source) {
  return openaiRequest(`/vector_stores/${vectorStoreId}/files`, {
    method: "POST",
    body: JSON.stringify({
      file_id: file.id,
      attributes: {
        document_type: source.type,
        title: source.title,
        status: "vigente",
      },
      chunking_strategy: {
        type: "static",
        static: {
          max_chunk_size_tokens: 1000,
          chunk_overlap_tokens: 250,
        },
      },
    }),
  });
}

async function waitForIndex(vectorStoreId, fileId) {
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const current = await openaiRequest(
      `/vector_stores/${vectorStoreId}/files/${fileId}`,
      { method: "GET" }
    );

    process.stdout.write(`Indexando ${fileId}: ${current.status} (${attempt}/60)\r`);

    if (current.status === "completed") {
      process.stdout.write("\n");
      return current;
    }
    if (current.status === "failed" || current.status === "cancelled") {
      throw new Error(
        `Falha na indexação de ${fileId}: ${JSON.stringify(current.last_error || current)}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  throw new Error(`Tempo excedido aguardando indexação do arquivo ${fileId}.`);
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("Defina OPENAI_API_KEY no .env antes de executar.");
  }

  console.log("Criando base oficial da AARS...\n");

  const vectorStore = await createVectorStore();
  console.log(`Vector Store criado: ${vectorStore.id}`);

  const uploaded = {};

  for (const source of sources) {
    console.log(`\nEnviando: ${source.title}`);
    const file = await uploadFile(source.path);
    uploaded[source.type] = file;
    console.log(`File ID: ${file.id}`);

    await attachFile(vectorStore.id, file, source);
    await waitForIndex(vectorStore.id, file.id);
  }

  console.log("\n============================================================");
  console.log("BASE DOCUMENTAL CONFIGURADA");
  console.log("============================================================");
  console.log("Adicione estas variáveis no Railway:\n");
  console.log(`OPENAI_VECTOR_STORE_ID=${vectorStore.id}`);
  console.log(`OPENAI_ESTATUTO_FILE_ID=${uploaded.estatuto.id}`);
  console.log(`OPENAI_RI_FILE_ID=${uploaded.regulamento_interno.id}`);
  console.log("\nDepois clique em Apply Changes / Redeploy.");
  console.log("\nObservação: os PDFs da pasta knowledge/official estão no .gitignore e não devem ser enviados ao GitHub.");
}

main().catch((error) => {
  console.error("\nErro ao configurar base documental:", error.message);
  if (error.data) console.error(JSON.stringify(error.data, null, 2));
  process.exit(1);
});
