export interface WorkerEnv {
  PUBLIC_DB: D1Database;
  ADMIN_DB: D1Database;
  ADMIN_ARTIFACTS: R2Bucket;
  PUBLIC_DUMPS: R2Bucket;
  GENERATION_QUEUE: Queue;
  ADMIN_EVENTS: DurableObjectNamespace;
  ASSETS: Fetcher;
  BOOTSTRAP_TOKEN?: string;
  ADMIN_RP_ID?: string;
  ADMIN_ORIGIN?: string;
  DUMP_URL?: string;
  ARTIFACT_PRIVATE_KEY?: string;
  SECRET_ENCRYPTION_KEY?: string;
}
