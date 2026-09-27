import "dotenv/config";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "./generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL ?? "file:/etc/lncs/lncs.db";

const adapter = new PrismaBetterSqlite3({
  url: connectionString,
});

export const prisma = new PrismaClient({
  adapter,
});
