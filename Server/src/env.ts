export interface WorkerEnv {
  PUBLIC_DB: D1Database;
  ADMIN_DB: D1Database;
  ADMIN_ARTIFACTS: R2Bucket;
  PUBLIC_DUMPS: R2Bucket;
  GENERATION_QUEUE: Queue;
  ASSETS: Fetcher;
  BOOTSTRAP_TOKEN?: string;
  ADMIN_RP_ID?: string;
  ADMIN_ORIGIN?: string;
  DUMP_URL?: string;
  ARTIFACT_PRIVATE_KEY?: string;
  SECRET_ENCRYPTION_KEY?: string;
  /** 공개 플레이리스트를 읽기 위한 앱 자격. 사람의 계정에는 들어가지 않는다. */
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;
}
