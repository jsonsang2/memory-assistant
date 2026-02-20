import type { AISummarizer, Observation, Session, StructuredPromptSummary } from '../types.js';

export function createSummarizer(): AISummarizer {
  // Lazy-load Anthropic SDK to avoid errors when API key is not set
  let client: any = null;

  async function getClient() {
    if (!client) {
      const { default: Anthropic } = await import('@anthropic-ai/sdk');
      client = new Anthropic();
    }
    return client;
  }

  return {
    async summarizeObservations(observations: Observation[]): Promise<{ id: number; summary: string }[]> {
      const anthropic = await getClient();
      const results: { id: number; summary: string }[] = [];

      for (const obs of observations) {
        const prompt = `Summarize this tool usage in 1-2 sentences. Focus on what was done and why.
Tool: ${obs.tool_name}
Input: ${obs.tool_input || 'N/A'}
Output: ${(obs.tool_output || 'N/A').slice(0, 500)}`;

        try {
          const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 150,
            messages: [{ role: 'user', content: prompt }],
          });

          const summary = response.content[0]?.type === 'text'
            ? response.content[0].text
            : 'Unable to summarize';

          results.push({ id: obs.id, summary });
        } catch (e) {
          console.error(`Failed to summarize observation ${obs.id}:`, e);
          results.push({ id: obs.id, summary: `[${obs.tool_name}] ${obs.tool_input?.slice(0, 100) || 'no input'}` });
        }
      }

      return results;
    },

    async summarizeSession(session: Session, observations: Observation[]): Promise<{ summary: string; key_learnings: string[] }> {
      const anthropic = await getClient();

      const obsText = observations.map(o =>
        `- [${o.tool_name}] ${o.ai_summary || o.tool_input?.slice(0, 100) || 'no details'}`
      ).join('\n');

      const prompt = `Summarize this coding session concisely. Return JSON with "summary" (string, 2-3 sentences) and "key_learnings" (array of strings, max 5 items).

Session: ${session.session_id}
Editor: ${session.editor}
Project: ${session.project_path || 'unknown'}
Duration: ${session.started_at} to ${session.ended_at || 'ongoing'}

Observations:
${obsText}`;

      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        });

        const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
        const parsed = JSON.parse(text);
        return {
          summary: parsed.summary || 'Session completed',
          key_learnings: Array.isArray(parsed.key_learnings) ? parsed.key_learnings : [],
        };
      } catch (e) {
        console.error('Failed to summarize session:', e);
        return {
          summary: `Session with ${observations.length} observations in ${session.project_path || 'unknown project'}`,
          key_learnings: [],
        };
      }
    },

    async summarizePrompt(session: Session, promptNumber: number, observations: Observation[]): Promise<{ summary: string; key_learnings: string[] }> {
      const anthropic = await getClient();

      const obsText = observations.map(o =>
        `- [${o.tool_name}] ${o.ai_summary || o.tool_input?.slice(0, 100) || 'no details'}`
      ).join('\n');

      const prompt = `Summarize this specific prompt/turn from a coding session. Return JSON with "summary" (string, 2-3 sentences) and "key_learnings" (array of strings, max 3 items).

Session: ${session.session_id}
Prompt: #${promptNumber}
Project: ${session.project_path || 'unknown'}

Observations:
${obsText}`;

      try {
        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: prompt }],
        });

        const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
        const parsed = JSON.parse(text);
        return {
          summary: parsed.summary || `Prompt #${promptNumber} completed`,
          key_learnings: Array.isArray(parsed.key_learnings) ? parsed.key_learnings : [],
        };
      } catch (e) {
        console.error(`Failed to summarize prompt ${promptNumber}:`, e);
        return {
          summary: `Prompt #${promptNumber} with ${observations.length} observations`,
          key_learnings: [],
        };
      }
    },

    async summarizePromptStructured(userPrompt: string, assistantResponse: string, observations: Observation[]): Promise<StructuredPromptSummary> {
      const fallback: StructuredPromptSummary = {
        request: userPrompt.slice(0, 200) || 'Unknown request',
        investigated: observations.map(o => o.tool_name).join(', ') || 'N/A',
        learned: 'N/A',
        completed: `${observations.length} tool calls executed`,
        next_steps: 'N/A',
      };

      try {
        const anthropic = await getClient();

        const obsText = observations.map(o =>
          `- [${o.tool_name}] ${o.ai_summary || o.tool_input?.slice(0, 100) || 'no details'}`
        ).join('\n');

        const prompt = `Summarize this coding session prompt. Return JSON with exactly these fields:
- request: What the user asked for (1 sentence)
- investigated: What files/areas were examined (1 sentence)
- learned: Key discoveries or findings (1 sentence)
- completed: What was actually done (1 sentence)
- next_steps: Remaining work or follow-ups (1 sentence)

User prompt: ${userPrompt}
Assistant response: ${assistantResponse.slice(0, 500)}
Tool usage: ${obsText}`;

        const response = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: prompt }],
        });

        const text = response.content[0]?.type === 'text' ? response.content[0].text : '{}';
        const parsed = JSON.parse(text);
        return {
          request: parsed.request || fallback.request,
          investigated: parsed.investigated || fallback.investigated,
          learned: parsed.learned || fallback.learned,
          completed: parsed.completed || fallback.completed,
          next_steps: parsed.next_steps || fallback.next_steps,
        };
      } catch (e) {
        console.error('Failed to summarize prompt structured:', e);
        return fallback;
      }
    },
  };
}
