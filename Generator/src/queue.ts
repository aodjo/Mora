import type { QueueJobMessage } from "../../packages/contracts/src/index.js";

export interface LeasedMessage {
  id: string;
  body: QueueJobMessage;
  attempts: number;
  leaseId: string;
}

export interface GeneratorQueue {
  pull(): Promise<LeasedMessage | null>;
  ack(leaseId: string): Promise<void>;
  retry(leaseId: string, delaySeconds?: number): Promise<void>;
}
