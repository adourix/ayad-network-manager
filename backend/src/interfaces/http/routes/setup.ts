import type { FastifyInstance } from "fastify";
import type { SetupApplyInput, SetupService } from "../../../application/setup/SetupService.js";
export async function setupRoutes(app:FastifyInstance,service:SetupService){
  app.get("/api/setup/preflight",async()=>service.preflight());
  app.get("/api/setup/network",async()=>service.inspectNetwork());
  app.get<{Querystring:{interface?:string}}>("/api/setup/diagnostics",async request=>service.diagnostics(request.query.interface));
  app.post<{Body:SetupApplyInput}>("/api/setup/apply",async request=>service.apply(request.body));
  app.post("/api/setup/rollback",async()=>{await service.rollbackLatest();return {rolledBack:true};});
}
