export const workbookSheetNames = [
  "00使用说明",
  "01重量模板",
  "02类型材质",
  "03功能定位",
  "04性能定位",
  "05品质规则",
  "06组合SKU",
  "07杆明细",
  "08轮明细",
  "09线明细",
  "10系列规划",
  "11覆盖验算",
  "12现实校准",
] as const;

export interface WorkbookMetadata {
  schemaVersion: number;
  calculationVersion: number;
  exportedAt: string;
  parameterMappings: Record<string, string>;
  ruleVersions: Record<string, number>;
}

export const metadataSheetName = "_TF_METADATA";

export * from "./workbook";
