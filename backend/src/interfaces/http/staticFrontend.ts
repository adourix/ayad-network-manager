import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

const MIME_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function frontendRoot(): string {
  return resolve(process.env.FRONTEND_DIST_PATH ?? join(process.cwd(), "../frontend/dist"));
}

function safePath(root: string, pathname: string): string | null {
  const candidate = resolve(root, `.${pathname.startsWith("/") ? pathname : `/${pathname}`}`);
  const rel = relative(root, candidate);
  if (rel.startsWith("..") || rel.includes("..${process.platform === "win32" ? "\\" : "/"}")) return null;
  return candidate;
}

function sendFile(reply: FastifyReply, path: string): void {
  reply.type(MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream").send(readFileSync(path));
}

export function registerFrontend(app: FastifyInstance): void {
  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;

    if (request.method !== "GET" && request.method !== "HEAD") {
      return reply.code(404).send({ error: "Not found" });
    }

    if (pathname.startsWith("/api/")) {
      return reply.code(404).send({ error: "Not found" });
    }

    const root = frontendRoot();
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return reply.code(404).send({ error: "Frontend build not found" });
    }

    const requested = safePath(root, decodeURIComponent(pathname));
    if (!requested) return reply.code(400).send({ error: "Invalid path" });

    if (existsSync(requested) && statSync(requested).isFile()) {
      if (request.method === "HEAD") return reply.code(200).send();
      sendFile(reply, requested);
      return;
    }

    const index = join(root, "index.html");
    if (!existsSync(index) || !statSync(index).isFile()) {
      return reply.code(404).send({ error: "Frontend entrypoint not found" });
    }

    if (request.method === "HEAD") return reply.code(200).send();
    sendFile(reply, index);
  });
}
