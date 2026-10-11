import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { loadEnvConfig } from "@next/env";
import { GeminiProtocolEmbedder } from "../src/lib/handoff/gemini-embeddings";

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required to ingest protocol chunks.`);
  return value;
}

function splitIntoChunks(markdown: string): string[] {
  const chunks = markdown
    .split(/(?=^#{1,3}\s)/m)
    .map((chunk) => chunk.trim())
    .filter(Boolean);
  if (chunks.length === 0 && markdown.trim()) return [markdown.trim()];
  return chunks;
}

async function ingestProtocols(): Promise<void> {
  loadEnvConfig(process.cwd());
  const projectUrl = requiredEnvironment("NEXT_PUBLIC_SUPABASE_URL");
  const serviceRoleKey = requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY");
  requiredEnvironment("GOOGLE_API_KEY");

  const root = process.cwd();
  const protocolDirectory = join(root, "data", "protocols");
  const files = (await readdir(protocolDirectory))
    .filter((file) => file.endsWith(".md"))
    .sort();
  if (files.length === 0) throw new Error("No Markdown protocol files were found in data/protocols/.");

  const supabase = createClient(projectUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const embedder = new GeminiProtocolEmbedder();
  let ingestedCount = 0;

  for (const file of files) {
    const filePath = join(protocolDirectory, file);
    const sourcePath = relative(root, filePath);
    const markdown = await readFile(filePath, "utf8");
    const chunks = splitIntoChunks(markdown);
    if (chunks.length === 0) throw new Error(`${sourcePath} is empty and cannot be ingested.`);
    const rows = [];

    for (const [chunkIndex, content] of chunks.entries()) {
      rows.push({
        source_path: sourcePath,
        chunk_index: chunkIndex,
        content,
        embedding: await embedder.embed(content, "RETRIEVAL_DOCUMENT"),
      });
    }

    const { error } = await supabase
      .from("knowledge_chunks")
      .upsert(rows, { onConflict: "source_path,chunk_index" });
    if (error) throw new Error(`Could not store ${sourcePath}: ${error.message}`);
    ingestedCount += rows.length;
  }

  console.log(`Ingested ${ingestedCount} protocol chunks from ${files.length} Markdown files.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await ingestProtocols();
}
