import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "../../infrastructure/database/prisma.js";

const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE = "nm_session";
const loginFailures = new Map<string, { count: number; resetAt: number }>();
const LOGIN_WINDOW_MS = 5 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function passwordMatches(candidate: string, hash: string, salt: string): boolean {
  const actual = scryptSync(candidate, salt, 32);
  const expected = Buffer.from(hash, "hex");
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

function tokenFrom(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length).trim() || null;

  const cookie = request.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      return part.slice(separator + 1).trim() || null;
    }
  }
  return null;
}

async function currentSession(request: FastifyRequest) {
  const token = tokenFrom(request);
  if (!token) return null;
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: tokenHash(token) },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return null;
  }
  return { session, token };
}

export async function validateSessionToken(token: string | null): Promise<boolean> {
  if (!token) return false;
  const session = await prisma.authSession.findUnique({
    where: { tokenHash: tokenHash(token) },
  });
  if (!session) return false;
  if (session.expiresAt.getTime() <= Date.now()) {
    await prisma.authSession.delete({ where: { id: session.id } }).catch(() => undefined);
    return false;
  }
  return true;
}

export function registerAuthentication(app: FastifyInstance): void {
  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url?.split("?")[0] ?? "";
    if (!pathname.startsWith("/api/")) return;

    if (
      pathname === "/api/auth/login" ||
      pathname === "/api/auth/password" ||
      pathname === "/api/auth/logout" ||
      pathname === "/api/health" ||
      pathname === "/api/setup/status"
    ) return;

    const session = await currentSession(request);
    if (!session) return reply.code(401).send({ error: "Authentication required" });

    const admin = await prisma.authUser.findUnique({ where: { id: 1 } });
    if (admin?.mustChangePassword) {
      return reply.code(403).send({ error: "Password change required" });
    }
  });

  app.post<{ Body: { username?: string; password?: string } }>(
    "/api/auth/login",
    {
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, maxLength: 128 },
            password: { type: "string", minLength: 1, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const source = request.ip;
      const now = Date.now();
      const failure = loginFailures.get(source);
      if (failure && failure.resetAt > now && failure.count >= LOGIN_MAX_FAILURES) {
        return reply.code(429).send({ error: "Too many login attempts" });
      }

      const admin = await prisma.authUser.findUnique({ where: { id: 1 } });
      const body = request.body ?? {};
      const valid =
        Boolean(admin) &&
        body.username === admin?.username &&
        typeof body.password === "string" &&
        passwordMatches(body.password, admin.passwordHash, admin.passwordSalt);

      if (!valid) {
        const current =
          failure && failure.resetAt > now
            ? failure
            : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
        current.count += 1;
        loginFailures.set(source, current);
        return reply.code(401).send({ error: "Invalid credentials" });
      }

      loginFailures.delete(source);
      const token = randomBytes(32).toString("base64url");
      await prisma.authSession.create({
        data: {
          tokenHash: tokenHash(token),
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      });

      const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
      reply.header(
        "Set-Cookie",
        `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`,
      );

      return {
        token,
        expiresInSeconds: SESSION_TTL_MS / 1000,
        mustChangePassword: admin.mustChangePassword,
      };
    },
  );

  app.post<{
    Body: { currentPassword?: string; newPassword?: string };
  }>(
    "/api/auth/password",
    {
      schema: {
        body: {
          type: "object",
          required: ["currentPassword", "newPassword"],
          additionalProperties: false,
          properties: {
            currentPassword: { type: "string", minLength: 1, maxLength: 512 },
            newPassword: { type: "string", minLength: 8, maxLength: 512 },
          },
        },
      },
    },
    async (request, reply) => {
      const session = await currentSession(request);
      if (!session) return reply.code(401).send({ error: "Authentication required" });

      const admin = await prisma.authUser.findUnique({ where: { id: 1 } });
      const { currentPassword, newPassword } = request.body ?? {};
      if (!admin || typeof currentPassword !== "string" || typeof newPassword !== "string") {
        return reply.code(400).send({ error: "Invalid password request" });
      }
      if (!passwordMatches(currentPassword, admin.passwordHash, admin.passwordSalt)) {
        return reply.code(401).send({ error: "Current password is incorrect" });
      }
      if (newPassword === currentPassword) {
        return reply.code(400).send({ error: "New password must be different from the current password" });
      }

      const salt = randomBytes(16).toString("hex");
      const hash = scryptSync(newPassword, salt, 32).toString("hex");
      await prisma.authUser.update({
        where: { id: 1 },
        data: { passwordHash: hash, passwordSalt: salt, mustChangePassword: false },
      });

      await prisma.authSession.deleteMany({
        where: { id: { not: session.session.id } },
      });

      return { changed: true, mustChangePassword: false };
    },
  );

  app.post("/api/auth/logout", async (request, reply) => {
    const token = tokenFrom(request);
    if (token) {
      await prisma.authSession.deleteMany({ where: { tokenHash: tokenHash(token) } });
    }
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    reply.header(
      "Set-Cookie",
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    );
    return reply.code(204).send();
  });
}
