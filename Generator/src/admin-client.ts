import { createHash, publicEncrypt, randomBytes, constants } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import { basename } from "node:path";
import type { GeneratorCandidateSubmission, GeneratorJobInput, StageEvent, WorkerCapabilities } from "../../packages/contracts/src/index.js";

export class AdminClient {
  constructor(readonly baseUrl:string,readonly token:string,readonly fetcher:typeof fetch=fetch){}
  private async request<T>(path:string,init:RequestInit={}):Promise<T>{
    const response=await this.fetcher(`${this.baseUrl.replace(/\/$/u,"")}/admin/api${path}`,{...init,headers:{authorization:`Bearer ${this.token}`,...(init.body===undefined?{}:{"content-type":"application/json"}),...init.headers}});
    if(!response.ok)throw new Error(`ADMIN_${response.status}_${(await response.text()).slice(0,100)}`);
    return response.status===204?undefined as T:await response.json() as T;
  }
  job(id:string):Promise<GeneratorJobInput>{return this.request(`/generator/jobs/${encodeURIComponent(id)}`);}
  event(value:StageEvent):Promise<{accepted:boolean}>{return this.request("/generator/events",{method:"POST",body:JSON.stringify(value)});}
  candidates(value:GeneratorCandidateSubmission):Promise<{candidate_ids:string[]}>{return this.request("/generator/candidates",{method:"POST",body:JSON.stringify(value)});}
  heartbeat(value:{worker_id:string;version:string}):Promise<{desired_state:string}>{return this.request("/generator/heartbeat",{method:"POST",body:JSON.stringify(value)});}
  static async enroll(baseUrl:string,enrollmentToken:string,name:string,capabilities:WorkerCapabilities):Promise<{worker_id:string;api_key:string}>{
    const response=await fetch(`${baseUrl.replace(/\/$/u,"")}/admin/api/generator/enroll`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:enrollmentToken,name,capabilities})});
    if(!response.ok)throw new Error(`ENROLL_${response.status}`);return response.json() as Promise<{worker_id:string;api_key:string}>;
  }
  async uploadArtifact(input:{jobId:string;kind:string;speakerId?:number;path:string;contentType:string;publicKey:string;chunkSize?:number}):Promise<string>{
    const encrypted=await encryptFile(input.path,input.publicKey,input.chunkSize??4*1024*1024);
    const registered=await this.request<{artifact_id:string;upload_path:string}>("/generator/artifacts",{method:"POST",body:JSON.stringify({job_id:input.jobId,kind:input.kind,...input.speakerId===undefined?{}:{speaker_id:input.speakerId},content_type:input.contentType,byte_size:encrypted.plainSize,sha256:encrypted.sha256,encryption:"mora-aes-256-gcm-chunked-v1",wrapped_key:encrypted.wrappedKey,chunk_size:encrypted.chunkSize,filename:basename(input.path)})});
    const stream=createReadStream(encrypted.path) as unknown as BodyInit;
    const response=await this.fetcher(`${this.baseUrl.replace(/\/$/u,"")}${registered.upload_path}`,{method:"PUT",headers:{authorization:`Bearer ${this.token}`,"content-type":"application/octet-stream"},body:stream,duplex:"half"} as RequestInit & {duplex:string});
    await fs.rm(encrypted.path,{force:true});if(!response.ok)throw new Error(`ARTIFACT_UPLOAD_${response.status}`);return registered.artifact_id;
  }
}

interface EncryptedFile {path:string;plainSize:number;sha256:string;wrappedKey:string;chunkSize:number}
async function encryptFile(path:string,publicKey:string,chunkSize:number):Promise<EncryptedFile>{
  const input=await fs.open(path,"r");const stat=await input.stat();const outputPath=`${path}.moraenc`;const output=await fs.open(outputPath,"w");
  const key=randomBytes(32);const wrapped=publicEncrypt({key:publicKey,padding:constants.RSA_PKCS1_OAEP_PADDING,oaepHash:"sha256"},key);const hash=createHash("sha256");
  const header=Buffer.from(JSON.stringify({v:1,chunk_size:chunkSize,plain_size:stat.size}),"utf8");const prefix=Buffer.alloc(12);prefix.write("MORAENC1",0,"ascii");prefix.writeUInt32BE(header.length,8);await output.write(prefix);await output.write(header);
  let position=0;let counter=0;
  while(position<stat.size){const size=Math.min(chunkSize,stat.size-position);const plain=Buffer.alloc(size);await input.read(plain,0,size,position);hash.update(plain);const nonce=Buffer.alloc(12);nonce.writeUInt32BE(counter,8);const {createCipheriv}=await import("node:crypto");const cipher=createCipheriv("aes-256-gcm",key,nonce);const ciphertext=Buffer.concat([cipher.update(plain),cipher.final()]);const tag=cipher.getAuthTag();const record=Buffer.alloc(4);record.writeUInt32BE(ciphertext.length,0);await output.write(nonce);await output.write(record);await output.write(ciphertext);await output.write(tag);position+=size;counter+=1;}
  await input.close();await output.close();return{path:outputPath,plainSize:stat.size,sha256:hash.digest("hex"),wrappedKey:wrapped.toString("base64"),chunkSize};
}
