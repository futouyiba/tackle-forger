import { createFileAIBackupPurgeAdapterFromEnvironment } from "../lib/ai-backup-purge";
import { createAIRuntimeStoreFromEnvironment } from "../lib/ai-runtime-store";

const store = createAIRuntimeStoreFromEnvironment();
await store.initialize();
const summary = await store.sweepRetention({
  now: new Date(),
  backupAdapter: createFileAIBackupPurgeAdapterFromEnvironment(),
});
console.log(JSON.stringify(summary));
if (summary.backupPurgeFailures > 0) process.exitCode = 1;
