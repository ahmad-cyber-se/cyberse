import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL || 'postgresql://invalid:invalid@127.0.0.1:5432/invalid';

const globalForDb = globalThis as unknown as { cyberseSql?: ReturnType<typeof postgres> };

export const sql = globalForDb.cyberseSql ?? postgres(connectionString, {
  prepare: false,
  max: 5,
  idle_timeout: 20,
  connect_timeout: 15,
  ssl: process.env.DATABASE_SSL === 'disable' ? false : 'require'
});

if (process.env.NODE_ENV !== 'production') globalForDb.cyberseSql = sql;
