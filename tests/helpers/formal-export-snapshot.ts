import { deterministicHash } from "../../lib/rule-kernel";
import type { ConfigurationSnapshot } from "../../lib/types";
import { testReductionPolicy } from "./reduction-policy";

export function formalExportSnapshot(
  source: ConfigurationSnapshot,
  mutate?: (snapshot: ConfigurationSnapshot) => void,
): ConfigurationSnapshot {
  const snapshot = structuredClone(source);
  snapshot.reductionStackingPolicyVersion = testReductionPolicy().version;
  mutate?.(snapshot);
  const content = structuredClone(snapshot) as Partial<ConfigurationSnapshot>;
  Reflect.deleteProperty(content, "contentHash");
  snapshot.contentHash = deterministicHash(content);
  return snapshot;
}
