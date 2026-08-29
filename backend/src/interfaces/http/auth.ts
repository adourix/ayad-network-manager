import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../infrastructure/database/prisma.js";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const loginFailures = new Map<string, { count:number; resetAt:number }>();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function configured(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function passwordMatches(candidate: string, expected: string): boolean {
  const actual = createHash("sha256").update(candidate).digest();
  const configuredHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actual, configuredHash);
}

function passwordIsValid(candidate: string): boolean {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const salt = process.env.ADMIN_PASSWORD_SALT;
  if (hash && salt) {
    const actual = scryptSync(candidate, salt, 32);
    const expected = Buffer.from(hash, "hex");
    return expected.length === actual.length && timingSafeEqual(actual, expected);
  }
  if (process.env.NODE_ENV === "production") return false;
  const configuredPassword = process.env.ADMIN_PASSWORD;
  if (!configuredPassword || configuredPassword === "change-me") return false;
  return passwordMatches(candidate, configuredPassword);
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function tokenFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export function registerAuthentication(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    if (request.url.split("?")[0] === "/api/auth/login" ||
        request.url.split("?")[0] === "/api/health") return;

    const token = tokenFrom(request);
    const session = token ? await prisma.authSession.findUnique({ where: { tokenHash: tokenHash(token) } }) : null;
    if (!session || session.expiresAt.getTime() <= Date.now()) {
      if (session) await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
      return reply.code(401).send({ error: "Authentication required" });
    }
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    { schema: { body: { type: "object", required: ["username", "password"], additionalProperties: false, properties: { username: { type: "string", minLength: 1, maxLength: 128 }, password: { type: "string", minLength: 1, maxLength: 512 } } } } },
    async (request, reply) => {
      const source = request.ip;
      const now = Date.now();
      const failure = loginFailures.get(source);
      if (failure && failure.resetAt > now && failure.count >= LOGIN_MAX_FAILURES) {
        return reply.code(429).send({ error: "Too many login attempts" });
      }
      const username = configured("ADMIN_USERNAME", "admin");
      const body = request.body ?? {};
      const candidatePassword = body.password;
      if (body.username !== username ||
          typeof candidatePassword !== "string" ||
          !passwordIsValid(candidatePassword)) {
        const current = failure && failure.resetAt > now ? failure : {count:0,resetAt:now + LOGIN_WINDOW_MS};
        current.count += 1;
        loginFailures.set(source,current);
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      loginFailures.delete(source);
      const token = randomBytes(32).toString("base64url");
      await prisma.authSession.create({ data: { tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + SESSION_TTL_MS) } });
      return { token, expiresInSeconds: SESSION_TTL_MS / 1000 };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = tokenFrom(request);
    if (token) await prisma.authSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
    return reply.code(204).send();
  });
}
