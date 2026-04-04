export type SnapshotSourceType = "page" | "keyword";
export type SnapshotItemType = "page" | "block";
export type ItemStatus = "unseen" | "seen" | "skipped";
export type StatusFilter = "all" | ItemStatus;
export type ThemeMode = "light" | "dark";
export type ReferenceState = "linked" | "unlinked";
export type SyncMode = "local-only" | "graph-backed";

export interface WhiteboardInfo {
  id: string;
  name: string;
}

export interface SnapshotItem {
  id: string;
  type: SnapshotItemType;
  label: string;
  referenceState: ReferenceState;
  pageName?: string;
  pageTitle?: string;
  blockUuid?: string;
  order: number;
  status: ItemStatus;
  matchedTitle?: string;
}

export interface SnapshotDiagnostics {
  lines: string[];
}

export interface ReviewStateItem {
  itemId: string;
  status: ItemStatus;
  updatedAt: number;
}

export interface ReviewStateRecord {
  reviewKey: string;
  whiteboardId: string;
  sourceType: SnapshotSourceType;
  sourceValue: string;
  normalizedSourceValue: string;
  updatedAt: number;
  items: Record<string, ReviewStateItem>;
}

export interface SavedSourceMeta {
  reviewKey: string;
  whiteboardId: string;
  whiteboardName: string;
  sourceType: SnapshotSourceType;
  sourceValue: string;
  normalizedSourceValue: string;
  createdAt: number;
  updatedAt: number;
}

export interface SourceTombstone {
  reviewKey: string;
  whiteboardId: string;
  sourceType: SnapshotSourceType;
  sourceValue: string;
  normalizedSourceValue: string;
  deletedAt: number;
}

export interface Snapshot {
  id: string;
  whiteboardId: string;
  whiteboardName: string;
  sourceType: SnapshotSourceType;
  sourceValue: string;
  keyword: string;
  createdAt: number;
  items: SnapshotItem[];
  diagnostics?: SnapshotDiagnostics;
}

export interface GraphState {
  syncMode: SyncMode;
  syncModeSettingInitialized: boolean;
  dockVisible: boolean;
  dockWidth: number;
  dockWidthsByWhiteboard: Record<string, number>;
  savedSourcesByWhiteboard: Record<string, string[]>;
  activeReviewKeyByWhiteboard: Record<string, string>;
  sourceMetaByReviewKey: Record<string, SavedSourceMeta>;
  sourceTombstonesByReviewKey: Record<string, SourceTombstone>;
  snapshotsByReviewKey: Record<string, Snapshot>;
  reviewStateByReviewKey: Record<string, ReviewStateRecord>;
  scrollByReviewKey: Record<string, number>;
}

export interface CandidatePageContext {
  id: number;
  uuid: string;
  name?: string;
  title: string;
}

export interface CandidatePage {
  id: number;
  uuid: string;
  type: SnapshotItemType;
  title: string;
  originalName?: string;
  rawTitle?: string;
  content?: string;
  name?: string;
  page?: CandidatePageContext;
  refIds: number[];
  link: boolean;
  builtIn: boolean;
  blockType?: string;
}
