export interface Session {
  id: number;
  session_id: string;
  editor: string;
  project_path: string | null;
  status: 'active' | 'completed' | 'aborted';
  started_at: string;
  ended_at: string | null;
}

export interface Observation {
  id: number;
  session_id: number;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  cwd: string | null;
  duration_ms: number | null;
  prompt_number: number;
  ai_summary: string | null;
  observed_at: string;
}

export interface SessionSummary {
  id: number;
  session_id: number;
  summary: string;
  key_learnings: string[];
  created_at: string;
}

export interface PromptSummary {
  id: number;
  session_id: number;
  prompt_number: number;
  summary: string;
  key_learnings: string[];
  user_prompt: string | null;
  assistant_response: string | null;
  created_at: string;
}

export interface StructuredPromptSummary {
  request: string;
  investigated: string;
  learned: string;
  completed: string;
  next_steps: string;
}

export interface SearchResult {
  id: number;
  snippet: string;
  tool_name: string;
  observed_at: string;
  session_id: string;
  rank: number;
}

export interface AISummarizer {
  summarizeObservations(observations: Observation[]): Promise<{ id: number; summary: string }[]>;
  summarizeSession(session: Session, observations: Observation[]): Promise<{ summary: string; key_learnings: string[] }>;
  summarizePrompt(session: Session, promptNumber: number, observations: Observation[]): Promise<{ summary: string; key_learnings: string[] }>;
  summarizePromptStructured(
    userPrompt: string,
    assistantResponse: string,
    observations: Observation[]
  ): Promise<StructuredPromptSummary>;
}
