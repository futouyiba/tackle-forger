export interface GridColumn {
  key: string;
  label: string;
  group?: "ROD" | "REEL" | "LINE" | "SHARED";
  width?: number;
  editable?: boolean;
}

export interface GridSelection {
  rowStart: number;
  rowEnd: number;
  columnStart: number;
  columnEnd: number;
}

export type BatchGridCommand =
  | { type: "SET"; value: unknown }
  | { type: "INCREMENT"; amount: number }
  | { type: "CLEAR" }
  | { type: "FILL_DOWN" }
  | { type: "FILL_RIGHT" };
