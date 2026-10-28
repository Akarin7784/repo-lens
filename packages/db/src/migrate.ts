import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/mysql2';
import { migrate } from 'drizzle-orm/mysql2/migrator';
import mysql from 'mysql2/promise';

/** 包内 migrations 目录(drizzle-kit generate 产出,随包发布) */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));

/** 执行未应用的迁移(API/Worker 启动时调用,幂等) */
export async function runMigrations(url: string): Promise<void> {
  const conn = await mysql.createConnection({ uri: url, multipleStatements: true });
  try {
    await migrate(drizzle(conn), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await conn.end();
  }
}
