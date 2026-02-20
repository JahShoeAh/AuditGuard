import type {
  D1Database,
  D1PreparedStatement,
  D1RunResult,
} from "../types/runtime";

type SqlStatement = {
  sql: string;
  params?: unknown[];
};

export const prepare = (
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): D1PreparedStatement => db.prepare(sql).bind(...params);

export const queryAll = async <T>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> => {
  const result = await prepare(db, sql, params).all<T>();
  return result.results ?? [];
};

export const queryFirst = async <T>(
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> => prepare(db, sql, params).first<T>();

export const execute = async (
  db: D1Database,
  sql: string,
  params: unknown[] = [],
): Promise<D1RunResult> => prepare(db, sql, params).run();

export const executeBatch = async (
  db: D1Database,
  statements: SqlStatement[],
): Promise<D1RunResult[]> => {
  const prepared = statements.map((statement) =>
    prepare(db, statement.sql, statement.params ?? []),
  );
  return db.batch<D1RunResult>(prepared);
};
