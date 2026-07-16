import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspaceState = sqliteTable("workspace_state", {
  id: text("id").primaryKey(),
  stateJson: text("state_json").notNull(),
  revision: integer("revision").notNull().default(1),
  updatedBy: text("updated_by").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const workspaceRevisions = sqliteTable("workspace_revisions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  revision: integer("revision").notNull().unique(),
  stateJson: text("state_json").notNull(),
  author: text("author").notNull(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
});

export const importedFiles = sqliteTable("imported_files", {
  id: text("id").primaryKey(),
  fileName: text("file_name").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  uploadedAt: text("uploaded_at").notNull(),
  r2Key: text("r2_key").notNull(),
});
