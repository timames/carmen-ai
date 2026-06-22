export type Env = {
  AI: Ai;
  DB: D1Database;
  SESSIONS: KVNamespace;
  FILES: R2Bucket;
  ENTRA_TENANT_ID: string;
  ENTRA_CLIENT_ID: string;
  ENTRA_CLIENT_SECRET: string;
  APP_URL: string;
  ANTHROPIC_API_KEY?: string;
  BRAVE_SEARCH_API_KEY?: string;
  NINJA_CLIENT_ID?: string;
  NINJA_CLIENT_SECRET?: string;
};

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
}

export interface Conversation {
  id: string;
  user_id: string;
  title: string;
  model: string;
  created_at: string;
  updated_at: string;
}

export interface Message {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  created_at: string;
}

export interface Session {
  userId: string;
  email: string;
  name: string;
  accessToken: string;
  refreshToken: string;
  tokenExpiresAt: number;
  expiresAt: number;
}
