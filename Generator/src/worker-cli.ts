import { writeFile } from "node:fs/promises";
import { AdminClient } from "./admin-client.js";
import { CloudflarePullQueue } from "./cloudflare-queue.js";
import { MlDaemon } from "./ml-daemon.js";
import { GeneratorWorker } from "./worker.js";

const adminUrl=required("MORA_ADMIN_URL");const daemon=new MlDaemon();const selfTest=await daemon.selfTest();
const enrollment=process.env.MORA_ENROLLMENT_TOKEN;
if(enrollment!==undefined){const workerId=process.env.MORA_WORKER_ID??crypto.randomUUID();const result=await AdminClient.enroll(adminUrl,enrollment,process.env.MORA_WORKER_NAME??workerId,{worker_id:workerId,version:"0.1.0",backend:selfTest.backend as "mps"|"cuda"|"xpu"|"rocm",hardware:selfTest.hardware,capabilities:Object.entries(selfTest.checks).filter(([,value])=>value==="passed").map(([key])=>key),production_ready:selfTest.production_ready,self_test:Object.fromEntries(Object.entries(selfTest.checks).map(([key,value])=>[key,value==="passed"?"passed":"failed"]))});await writeFile(process.env.MORA_CREDENTIAL_FILE??".mora-worker.json",JSON.stringify(result,null,2),{mode:0o600});process.stdout.write(`worker enrolled: ${result.worker_id}\n`);daemon.close();process.exit(0);}
const token=required("MORA_GENERATOR_TOKEN");const workerId=required("MORA_WORKER_ID");if(!selfTest.production_ready)throw new Error("worker self-test did not pass the production profile");
const worker=new GeneratorWorker({workerId,version:"0.1.0",admin:new AdminClient(adminUrl,token),queue:new CloudflarePullQueue(required("CF_ACCOUNT_ID"),required("CF_QUEUE_ID"),required("CF_API_TOKEN")),daemon,artifactPublicKey:required("MORA_ARTIFACT_PUBLIC_KEY")});process.on("SIGINT",()=>worker.stop());process.on("SIGTERM",()=>worker.stop());await worker.run();
function required(name:string):string{const value=process.env[name];if(!value)throw new Error(`${name} is required`);return value;}
