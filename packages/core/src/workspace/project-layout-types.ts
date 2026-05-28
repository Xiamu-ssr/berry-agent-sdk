// ============================================================
// Berry Agent SDK — Project Shared Layout types
// ============================================================
// Pure interface types extracted from workspace/project-layout.ts so
// browser hosts can import them via core/schema without dragging in
// node:path through the layout helpers.

export interface ProjectSharedPaths {
  root: string;
  contextPath: string;
  berryDir: string;
  teamPath: string;
  teamMessagesPath: string;
  worklistPath: string;
  safetyPath: string;
}
