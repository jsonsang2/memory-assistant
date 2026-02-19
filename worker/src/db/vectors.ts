import type { Collection } from 'chromadb';

let collection: Collection | null = null;
let available = false;

const CHROMA_URL = `http://localhost:${process.env.CHROMA_PORT || 8000}`;
const COLLECTION_NAME = 'memory_assistant_observations';

export async function initChroma(): Promise<void> {
  try {
    const { ChromaClient, DefaultEmbeddingFunction } = await import('chromadb');

    const client = new ChromaClient({ path: CHROMA_URL });
    await client.heartbeat();

    const ef = new DefaultEmbeddingFunction();

    // Delete old collection if it has no embedding function, then recreate
    try {
      const existing = await client.getCollection({ name: COLLECTION_NAME });
      // @ts-ignore - check config
      const hasEmbedding = existing.metadata?.embedding_function != null ||
        (existing as any).embeddingFunction != null;
      if (!hasEmbedding) {
        await client.deleteCollection({ name: COLLECTION_NAME });
        console.log('Deleted old ChromaDB collection (no embedding function)');
      }
    } catch {
      // collection doesn't exist yet, that's fine
    }

    collection = await client.getOrCreateCollection({
      name: COLLECTION_NAME,
      embeddingFunction: ef,
    });

    available = true;
    console.log(`ChromaDB connected at ${CHROMA_URL} (semantic search enabled)`);
  } catch (e: any) {
    available = false;
    console.log(`ChromaDB not available - semantic search disabled. Start with: chroma run --path ~/.memory-assistant/chroma\n  Reason: ${e?.message}`);
  }
}

export function isChromaAvailable(): boolean {
  return available;
}

export async function upsertObservationVector(obs: {
  id: number;
  tool_name: string;
  tool_input: string | null;
  ai_summary: string | null;
  session_id: number;
}): Promise<void> {
  if (!available || !collection) return;

  const document = [
    obs.tool_name,
    obs.tool_input?.slice(0, 500) || '',
    obs.ai_summary || '',
  ].filter(Boolean).join('\n');

  try {
    await collection.upsert({
      ids: [String(obs.id)],
      documents: [document],
      metadatas: [{
        session_id: obs.session_id,
        tool_name: obs.tool_name,
      }],
    });
  } catch {
    // silently ignore
  }
}

export async function semanticSearch(query: string, limit: number = 10): Promise<number[]> {
  if (!available || !collection) return [];

  try {
    const results = await collection.query({
      queryTexts: [query],
      nResults: Math.min(limit, 100),
    });
    return (results.ids[0] || []).map(id => parseInt(id, 10));
  } catch {
    return [];
  }
}
