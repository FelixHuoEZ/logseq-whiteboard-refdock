import type { GraphState, ItemStatus, ReferenceState, Snapshot, SnapshotItem, SnapshotSourceType } from "./types";

const STORAGE_PREFIX = "whiteboard-refdock:v1";
export const DEFAULT_DOCK_WIDTH = 420;

function normalizeWidth(value: unknown, fallback = DEFAULT_DOCK_WIDTH): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(240, Math.round(value));
}

function normalizeStatus(value: unknown): ItemStatus {
  return value === "seen" || value === "skipped" || value === "unseen" ? value : "unseen";
}

function normalizeReferenceState(value: unknown): ReferenceState {
  return value === "linked" || value === "unlinked" ? value : "unlinked";
}

function normalizeSourceType(value: unknown): SnapshotSourceType {
  return value === "page" || value === "keyword" ? value : "keyword";
}

function normalizeSnapshotItem(item: unknown, index: number): SnapshotItem | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id : null;
  const type = record.type === "page" || record.type === "block" ? record.type : null;
  if (!id || !type) {
    return null;
  }

  return {
    id,
    type,
    label: typeof record.label === "string" && record.label.trim() ? record.label : type === "page" ? "Untitled page" : "Untitled block",
    referenceState: normalizeReferenceState(record.referenceState),
    pageName: typeof record.pageName === "string" ? record.pageName : undefined,
    pageTitle: typeof record.pageTitle === "string" ? record.pageTitle : undefined,
    blockUuid: typeof record.blockUuid === "string" ? record.blockUuid : undefined,
    order: typeof record.order === "number" && Number.isFinite(record.order) ? record.order : index,
    status: normalizeStatus(record.status),
    matchedTitle: typeof record.matchedTitle === "string" ? record.matchedTitle : undefined,
  };
}

function normalizeSnapshot(snapshot: unknown): Snapshot | null {
  if (!snapshot || typeof snapshot !== "object") {
    return null;
  }

  const record = snapshot as Record<string, unknown>;
  const whiteboardId = typeof record.whiteboardId === "string" ? record.whiteboardId : "";
  const whiteboardName = typeof record.whiteboardName === "string" ? record.whiteboardName : "Whiteboard";
  const id = typeof record.id === "string" && record.id.trim() ? record.id : `${whiteboardId || "snapshot"}:${record.createdAt ?? Date.now()}`;
  const items = Array.isArray(record.items)
    ? record.items
        .map((item, index) => normalizeSnapshotItem(item, index))
        .filter((item): item is SnapshotItem => item !== null)
    : [];

  return {
    id,
    whiteboardId,
    whiteboardName,
    sourceType: normalizeSourceType(record.sourceType),
    sourceValue: typeof record.sourceValue === "string" ? record.sourceValue : "",
    keyword: typeof record.keyword === "string" ? record.keyword : "",
    createdAt: typeof record.createdAt === "number" && Number.isFinite(record.createdAt) ? record.createdAt : Date.now(),
    items,
    diagnostics:
      record.diagnostics && typeof record.diagnostics === "object" && Array.isArray((record.diagnostics as Record<string, unknown>).lines)
        ? {
            lines: ((record.diagnostics as Record<string, unknown>).lines as unknown[]).filter(
              (line): line is string => typeof line === "string",
            ),
          }
        : undefined,
  };
}

function normalizeSnapshotsByWhiteboard(value: unknown): Record<string, Snapshot> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>)
    .map(([whiteboardId, snapshot]) => {
      const normalized = normalizeSnapshot(snapshot);
      if (!normalized) {
        return null;
      }

      return [
        whiteboardId,
        {
          ...normalized,
          whiteboardId: normalized.whiteboardId || whiteboardId,
        },
      ] as const;
    })
    .filter((entry): entry is readonly [string, Snapshot] => entry !== null);

  return Object.fromEntries(entries);
}

export function getDefaultGraphState(): GraphState {
  return {
    dockVisible: true,
    dockWidth: DEFAULT_DOCK_WIDTH,
    dockWidthsByWhiteboard: {},
    snapshotsByWhiteboard: {},
    scrollByWhiteboard: {},
  };
}

export function getGraphStorageKey(graph: unknown): string {
  if (!graph || typeof graph !== "object") {
    return `${STORAGE_PREFIX}:default`;
  }

  const graphRecord = graph as Record<string, unknown>;
  const identifier =
    graphRecord.path ??
    graphRecord.url ??
    graphRecord.name ??
    graphRecord.id ??
    "default";

  return `${STORAGE_PREFIX}:${String(identifier)}`;
}

export function loadGraphState(storageKey: string): GraphState {
  const raw = localStorage.getItem(storageKey);
  if (!raw) {
    return getDefaultGraphState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<GraphState>;
    const defaultState = getDefaultGraphState();
    const normalizedDockWidth = normalizeWidth(parsed.dockWidth, defaultState.dockWidth);
    const normalizedWidths = Object.fromEntries(
      Object.entries(parsed.dockWidthsByWhiteboard ?? {}).map(([whiteboardId, width]) => [
        whiteboardId,
        normalizeWidth(width, normalizedDockWidth),
      ]),
    );

    return {
      ...defaultState,
      ...parsed,
      dockWidth: normalizedDockWidth,
      dockWidthsByWhiteboard: normalizedWidths,
      snapshotsByWhiteboard: normalizeSnapshotsByWhiteboard(parsed.snapshotsByWhiteboard),
      scrollByWhiteboard: parsed.scrollByWhiteboard ?? {},
    };
  } catch (_error) {
    return getDefaultGraphState();
  }
}

export function saveGraphState(storageKey: string, state: GraphState): void {
  localStorage.setItem(storageKey, JSON.stringify(state));
}
