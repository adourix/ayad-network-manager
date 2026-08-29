import type { FastifyInstance } from "fastify";
import type { VpnService } from "../../../application/vpn/VpnService.js";
export async function vpnRoutes(app:FastifyInstance,service:VpnService){
  app.get("/api/vpn/status",async()=>service.status());
  app.post<{Body:{vmessLink:string}}>("/api/vpn/config",{schema:{body:{type:"object",required:["vmessLink"],additionalProperties:false,properties:{vmessLink:{type:"string",minLength:16,maxLength:8192,pattern:"^vmess://"}}}}},async r=>service.configure(r.body.vmessLink));
  app.post("/api/vpn/enable",async()=>service.setEnabled(true));
  app.post("/api/vpn/disable",async()=>service.setEnabled(false));
}
