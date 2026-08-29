import type { FastifyInstance } from "fastify";
import type { OperationsService } from "../../../application/operations/OperationsService.js";
const json=(v:unknown)=>JSON.parse(JSON.stringify(v,(_,x)=>typeof x==="bigint"?x.toString():x));
export async function operationsRoutes(app:FastifyInstance,service:OperationsService){
  app.get<{Querystring:{limit?:string}}>("/api/audit-log",{schema:{querystring:{type:"object",additionalProperties:false,properties:{limit:{type:"string",pattern:"^[1-9][0-9]{0,3}$"}}}}},async r=>json(await service.audits(Number(r.query.limit??100))));
  app.get("/api/notifications",async()=>json(await service.notifications()));
  app.post<{Params:{id:string}}>("/api/notifications/:id/read",{schema:{params:{type:"object",required:["id"],additionalProperties:false,properties:{id:{type:"string",pattern:"^[1-9][0-9]*$"}}}}},async r=>{await service.markNotificationRead(Number(r.params.id));return {read:true};});
}
