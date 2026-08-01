import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { resolve } from "node:path";

interface RpcResponse<T>{id:number;result?:T;error?:{code:string;message:string}}
export interface MlArtifact {kind:string;path:string;content_type:string;speaker_id?:number}
export interface MlVariantResult {variant_id:string;line_spans:Array<[number,number]>;word_spans:Array<[number,number,number,number]>;quality:Record<string,number>}
export interface MlRunResult {backend:string;hardware:string;detected_languages:string[];variants:MlVariantResult[];speaker_turns:Array<[number,number,number,number]>;word_speakers:Array<[string,number,number,number]>;line_speakers:Array<[string,number,number,number]>;artifacts:MlArtifact[];quality:Record<string,number>;work_dir:string}

export class MlDaemon {
  readonly #process:ChildProcessWithoutNullStreams;#id=0;readonly #pending=new Map<number,{resolve:(value:unknown)=>void;reject:(reason:unknown)=>void}>();
  onStage:((value:{stage:string;state:string;progress:number;metrics:Record<string,number>})=>void)|undefined;
  constructor(command=process.env.MORA_PYTHON??"python3",script=process.env.MORA_ML_DAEMON_SCRIPT??resolve(process.cwd(),"Generator/python/mora_ml_daemon.py")){
    this.#process=spawn(command,[script],{stdio:["pipe","pipe","pipe"],env:process.env});const lines=createInterface({input:this.#process.stdout});lines.on("line",line=>{try{const response=JSON.parse(line) as RpcResponse<unknown>&{method?:string;params?:{stage:string;state:string;progress:number;metrics:Record<string,number>}};if(response.method==="stage"&&response.params!==undefined){this.onStage?.(response.params);return;}const pending=this.#pending.get(response.id);if(!pending)return;this.#pending.delete(response.id);response.error?pending.reject(new Error(response.error.code)):pending.resolve(response.result);}catch{/* daemon stdout is protocol-only */}});this.#process.on("exit",code=>{for(const pending of this.#pending.values())pending.reject(new Error(`ML_DAEMON_EXIT_${code}`));this.#pending.clear();});
  }
  call<T>(method:string,params:unknown):Promise<T>{const id=++this.#id;return new Promise<T>((resolve,reject)=>{this.#pending.set(id,{resolve:value=>resolve(value as T),reject});this.#process.stdin.write(`${JSON.stringify({jsonrpc:"2.0",id,method,params})}\n`);});}
  selfTest():Promise<{backend:string;hardware:string;checks:Record<string,string>;production_ready:boolean}>{return this.call("self_test",{});}
  run(params:unknown):Promise<MlRunResult>{return this.call("run_job",params);}
  close():void{this.#process.kill("SIGTERM");}
}
