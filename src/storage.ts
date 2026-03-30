import type { GraphState } from "./types";

const STORAGE_PREFIX = "whiteboard-refdock:v1";
const DEFAULT_WIDTH = 420;

export function getDefaultGraphState(): GraphState {
  return {
    dockVisible: true,
    dockWidth: DEFAULT_WIDTH,
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
    return {
      ...getDefaultGraphState(),
      ...parsed,
      snapshotsByWhiteboard: parsed.snapshotsByWhiteboard ?? {},
      scrollByWhiteboard: parsed.scrollByWhiteboard ?? {},
    };
  } catch (_error) {
    return getDefaultGraphState();
  }
}

export function saveGraphState(storageKey: string, state: GraphState): void {
  localStorage.setItem(storageKey, JSON.stringify(state));
}
