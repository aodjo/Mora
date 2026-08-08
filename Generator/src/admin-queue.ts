import type { AdminClient } from "./admin-client.js";
import type { GeneratorQueue, LeasedMessage } from "./queue.js";

export class AdminJobQueue implements GeneratorQueue {
  constructor(private readonly admin: AdminClient) {}
  pull(): Promise<LeasedMessage | null> {
    return this.admin.pullJob();
  }
  ack(leaseId: string): Promise<void> {
    return this.admin.ackJob(leaseId);
  }
  retry(leaseId: string, delaySeconds = 30): Promise<void> {
    return this.admin.retryJob(leaseId, delaySeconds);
  }
}
