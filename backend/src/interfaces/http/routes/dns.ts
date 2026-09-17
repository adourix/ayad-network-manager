import type { FastifyInstance } from "fastify";
import type { DnsProfileService } from "../../../application/policies/DnsProfileService.js";
import type { DnsProfile } from "../../../domain/entities/DevicePolicy.js";

const profiles = ["GOOGLE", "CLOUDFLARE", "ADGUARD", "UNFILTERED"] as const;

export async function dnsRoutes(app: FastifyInstance, service: DnsProfileService): Promise<void> {
  app.get<{ Params: { mac: string } }>("/api/devices/:mac/dns-profile", async (request, reply) => {
    const result = await service.get(request.params.mac);
    if (!result) return reply.code(404).send({ error: "Device not found" });
    return result;
  });

  app.put<{ Params: { mac: string }; Body: { dnsProfile: DnsProfile } }>(
    "/api/devices/:mac/dns-profile",
    { schema: { body: { type: "object", required: ["dnsProfile"], additionalProperties: false, properties: { dnsProfile: { type: "string", enum: [...profiles] } } } } },
    async (request, reply) => service.set(request.params.mac, request.body.dnsProfile),
  );
}
