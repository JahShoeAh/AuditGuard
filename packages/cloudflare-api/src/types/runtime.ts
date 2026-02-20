export interface D1ExecResult {
  count: number;
  duration: number;
}

export interface D1Meta {
  changes?: number;
  last_row_id?: number;
}

export interface D1RunResult {
  success: boolean;
  meta?: D1Meta;
  error?: string;
}

export interface D1AllResult<T> {
  results?: T[];
  success: boolean;
  meta?: D1Meta;
  error?: string;
}

export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<D1AllResult<T>>;
  run(): Promise<D1RunResult>;
}

export interface D1Database {
  prepare(query: string): D1PreparedStatement;
  batch<T = D1RunResult>(statements: D1PreparedStatement[]): Promise<T[]>;
  exec(query: string): Promise<D1ExecResult>;
}

export type RuntimeEnv = {
  DB: D1Database;
  INGEST_TOKEN?: string;
  FRONTEND_ORIGIN?: string;
  APP_ENV?: string;
};
