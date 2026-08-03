import { isQueueJobMessage } from "../../packages/contracts/src/index.js";
import type { GeneratorQueue, LeasedMessage } from "./queue.js";

interface PullMessage {id:string;body:unknown;attempts:number;lease_id:string;metadata?:Record<string,string>}
export class CloudflarePullQueue implements GeneratorQueue {
  readonly #url:string;
  constructor(accountId:string,queueId:string,private readonly token:string,private readonly fetcher:typeof fetch=fetch){this.#url=`https://api.cloudflare.com/client/v4/accounts/${accountId}/queues/${queueId}/messages`;}
  async pull(visibilityTimeoutMs=12*60*60_000):Promise<LeasedMessage|null>{
    const response=await this.fetcher(`${this.#url}/pull`,{method:"POST",headers:{authorization:`Bearer ${this.token}`,"content-type":"application/json"},body:JSON.stringify({batch_size:1,visibility_timeout_ms:visibilityTimeoutMs})});
    if(!response.ok)throw new Error(`QUEUE_PULL_${response.status}`);const payload=await response.json() as {result?:{messages?:PullMessage[]}|PullMessage[]};const messages=Array.isArray(payload.result)?payload.result:payload.result?.messages??[];const item=messages[0];if(item===undefined)return null;let raw=item.body;if(typeof raw==="string"&&item.metadata?.["CF-Content-Type"]==="json")raw=Buffer.from(raw,"base64").toString("utf8");const parsed=typeof raw==="string"?JSON.parse(raw) as unknown:raw;if(!isQueueJobMessage(parsed)){await this.retry(item.lease_id,0);throw new Error("INVALID_QUEUE_MESSAGE");}return{id:item.id,body:parsed,attempts:item.attempts,leaseId:item.lease_id};
  }
  async ack(leaseId:string):Promise<void>{await this.action("ack",{acks:[{lease_id:leaseId}]});}
  async retry(leaseId:string,delaySeconds=30):Promise<void>{await this.action("ack",{retries:[{lease_id:leaseId,delay_seconds:delaySeconds}]});}
  private async action(path:string,value:unknown):Promise<void>{const response=await this.fetcher(`${this.#url}/${path}`,{method:"POST",headers:{authorization:`Bearer ${this.token}`,"content-type":"application/json"},body:JSON.stringify(value)});if(!response.ok)throw new Error(`QUEUE_ACK_${response.status}`);}
}
