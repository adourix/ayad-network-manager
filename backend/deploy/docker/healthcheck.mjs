import https from "node:https";
const port=Number(process.env.DASHBOARD_PORT??5000);
const request=https.get({hostname:"127.0.0.1",port,path:"/api/health",rejectUnauthorized:false,timeout:5000},response=>{
 let body="";response.setEncoding("utf8");response.on("data",chunk=>body+=chunk);response.on("end",()=>{try{const payload=JSON.parse(body);process.exit(response.statusCode===200&&payload.status==="ok"?0:1);}catch{process.exit(1);}});
});
request.on("timeout",()=>request.destroy(new Error("healthcheck timeout")));
request.on("error",()=>process.exit(1));
