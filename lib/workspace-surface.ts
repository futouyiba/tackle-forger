import type { ActionAvailabilityMap } from "./interaction-contracts";
import type { LocalSessionModel } from "./local-session-contracts";
import type { WorkspaceState } from "./types";

export type WorkspaceSurface =
  | {
      kind: "none";
    }
  | {
      kind: "local";
      session: LocalSessionModel;
    }
  | {
      kind: "shared";
      state: WorkspaceState;
      workspaceRevision: number;
      actionAvailability: ActionAvailabilityMap;
    };
