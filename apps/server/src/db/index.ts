import { drizzle } from 'drizzle-orm/postgres-js';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema';

const createDrizzle = (conn: Sql) => drizzle(conn, { schema });

export const createDb = (url: string, options: postgres.Options<{}> = {}) => {
  const conn = postgres(url, options);
  const db = createDrizzle(conn);
  return { db, conn };
};

export type DB = ReturnType<typeof createDrizzle>;
