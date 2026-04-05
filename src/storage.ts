import type {
  GraphState,
  ItemStatus,
  ReferenceState,
  ReviewStateItem,
  ReviewStateRecord,
  SavedSourceMeta,
  Snapshot,
  SnapshotItem,
  SnapshotSourceType,
  SourceTombstone,
  SyncMode,
  ThemePreference,
} from "./types";

const STORAGE_PREFIX = "whiteboard-refdock:v4";
const LEGACY_STORAGE_PREFIXES = ["whiteboard-refdock:v3", "whiteboard-refdock:v2", "whiteboard-refdock:v1"];
export const DEFAULT_DOCK_WIDTH = 420;

type LegacyGraphState = Partial<{
  snapshotsByWhiteboard: Record<string, Snapshot>;
  scrollByWhiteboard: Record<string, number>;
  reviewStateByReviewKey: Record<string, ReviewStateRecord>;
}>;

function normalizeWidth(value: unknown, fallback = DEFAULT_DOCK_WIDTH): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }

  return Math.max(240, Math.round(value));
}

function normalizeStatus(value: unknown): ItemStatus {
  return value === "seen" || value === "pending" || value === "skipped" || value === "unseen" ? value : "unseen";
}

function normalizeReferenceState(value: unknown): ReferenceState {
  return value === "linked" || value === "unlinked" ? value : "unlinked";
}

function normalizeSourceType(value: unknown): SnapshotSourceType {
  return value === "page" || value === "keyword" ? value : "keyword";
}

function normalizeSyncMode(value: unknown): SyncMode {
  return value === "graph-backed" || value === "local-only" ? value : "local-only";
}

function normalizeThemePreference(value: unknown): ThemePreference {
  return value === "dark" || value === "light" || value === "auto" ? value : "auto";
}

function normalizeBoolean(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSourceValue(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function buildReviewKey(whiteboardId: string, sourceType: SnapshotSourceType, sourceValue: string): string {
  return `${whiteboardId}::${sourceType}::${normalizeSourceValue(sourceValue)}`;
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
    blockEntityId: typeof record.blockEntityId === "number" && Number.isFinite(record.blockEntityId) ? record.blockEntityId : undefined,
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

function normalizeReviewStateItem(itemId: string, value: unknown): ReviewStateItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const status = normalizeStatus(record.status);
  return {
    itemId,
    status,
    updatedAt: typeof record.updatedAt === "number" && Number.isFinite(record.updatedAt) ? record.updatedAt : Date.now(),
  };
}

function normalizeReviewStateRecord(record: unknown): ReviewStateRecord | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const raw = record as Record<string, unknown>;
  const whiteboardId = typeof raw.whiteboardId === "string" ? raw.whiteboardId : "";
  const sourceType = normalizeSourceType(raw.sourceType);
  const sourceValue = typeof raw.sourceValue === "string" ? raw.sourceValue : "";
  const normalizedSourceValue =
    typeof raw.normalizedSourceValue === "string" && raw.normalizedSourceValue.trim()
      ? raw.normalizedSourceValue
      : normalizeSourceValue(sourceValue);
  const reviewKey =
    typeof raw.reviewKey === "string" && raw.reviewKey.trim()
      ? raw.reviewKey
      : buildReviewKey(whiteboardId, sourceType, sourceValue);

  const items =
    !raw.items || typeof raw.items !== "object"
      ? {}
      : Object.fromEntries(
          Object.entries(raw.items as Record<string, unknown>)
            .map(([itemId, value]) => {
              const normalized = normalizeReviewStateItem(itemId, value);
              return normalized ? ([itemId, normalized] as const) : null;
            })
            .filter((entry): entry is readonly [string, ReviewStateItem] => entry !== null),
        );

  return {
    reviewKey,
    whiteboardId,
    sourceType,
    sourceValue,
    normalizedSourceValue,
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
    items,
  };
}

function normalizeReviewStateByReviewKey(value: unknown): Record<string, ReviewStateRecord> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([reviewKey, record]) => {
        const normalized = normalizeReviewStateRecord(record);
        if (!normalized) {
          return null;
        }

        return [
          reviewKey,
          {
            ...normalized,
            reviewKey,
          },
        ] as const;
      })
      .filter((entry): entry is readonly [string, ReviewStateRecord] => entry !== null),
  );
}

function normalizeSavedSourceMeta(record: unknown): SavedSourceMeta | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const raw = record as Record<string, unknown>;
  const whiteboardId = typeof raw.whiteboardId === "string" ? raw.whiteboardId : "";
  const whiteboardName = typeof raw.whiteboardName === "string" && raw.whiteboardName.trim() ? raw.whiteboardName : "Whiteboard";
  const sourceType = normalizeSourceType(raw.sourceType);
  const sourceValue = typeof raw.sourceValue === "string" ? raw.sourceValue : "";
  const normalizedSourceValue =
    typeof raw.normalizedSourceValue === "string" && raw.normalizedSourceValue.trim()
      ? raw.normalizedSourceValue
      : normalizeSourceValue(sourceValue);
  const reviewKey =
    typeof raw.reviewKey === "string" && raw.reviewKey.trim()
      ? raw.reviewKey
      : buildReviewKey(whiteboardId, sourceType, sourceValue);

  if (!whiteboardId || !sourceValue || !reviewKey) {
    return null;
  }

  return {
    reviewKey,
    whiteboardId,
    whiteboardName,
    sourceType,
    sourceValue,
    normalizedSourceValue,
    createdAt: typeof raw.createdAt === "number" && Number.isFinite(raw.createdAt) ? raw.createdAt : Date.now(),
    updatedAt: typeof raw.updatedAt === "number" && Number.isFinite(raw.updatedAt) ? raw.updatedAt : Date.now(),
  };
}

function normalizeSourceMetaByReviewKey(value: unknown): Record<string, SavedSourceMeta> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([reviewKey, record]) => {
        const normalized = normalizeSavedSourceMeta(record);
        return normalized ? ([reviewKey, { ...normalized, reviewKey }] as const) : null;
      })
      .filter((entry): entry is readonly [string, SavedSourceMeta] => entry !== null),
  );
}

function normalizeSourceTombstone(record: unknown): SourceTombstone | null {
  if (!record || typeof record !== "object") {
    return null;
  }

  const raw = record as Record<string, unknown>;
  const whiteboardId = typeof raw.whiteboardId === "string" ? raw.whiteboardId : "";
  const sourceType = normalizeSourceType(raw.sourceType);
  const sourceValue = typeof raw.sourceValue === "string" ? raw.sourceValue : "";
  const normalizedSourceValue =
    typeof raw.normalizedSourceValue === "string" && raw.normalizedSourceValue.trim()
      ? raw.normalizedSourceValue
      : normalizeSourceValue(sourceValue);
  const reviewKey =
    typeof raw.reviewKey === "string" && raw.reviewKey.trim()
      ? raw.reviewKey
      : buildReviewKey(whiteboardId, sourceType, sourceValue);
  const deletedAt = typeof raw.deletedAt === "number" && Number.isFinite(raw.deletedAt) ? raw.deletedAt : null;

  if (!whiteboardId || !sourceValue || !reviewKey || !deletedAt) {
    return null;
  }

  return {
    reviewKey,
    whiteboardId,
    sourceType,
    sourceValue,
    normalizedSourceValue,
    deletedAt,
  };
}

function normalizeSourceTombstonesByReviewKey(value: unknown): Record<string, SourceTombstone> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([reviewKey, record]) => {
        const normalized = normalizeSourceTombstone(record);
        return normalized ? ([reviewKey, { ...normalized, reviewKey }] as const) : null;
      })
      .filter((entry): entry is readonly [string, SourceTombstone] => entry !== null),
  );
}

function normalizeSnapshotsByReviewKey(value: unknown): Record<string, Snapshot> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([reviewKey, snapshot]) => {
        const normalized = normalizeSnapshot(snapshot);
        return normalized ? ([reviewKey, normalized] as const) : null;
      })
      .filter((entry): entry is readonly [string, Snapshot] => entry !== null),
  );
}

function normalizeSnapshotsByWhiteboard(value: unknown): Record<string, Snapshot> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
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
      .filter((entry): entry is readonly [string, Snapshot] => entry !== null),
  );
}

function normalizeStringListMap(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, rawList]) => [
      key,
      Array.isArray(rawList)
        ? Array.from(
            new Set(
              rawList.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim()),
            ),
          )
        : [],
    ]),
  );
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, rawValue]) => (typeof rawValue === "string" && rawValue.trim() ? ([key, rawValue] as const) : null))
      .filter((entry): entry is readonly [string, string] => entry !== null),
  );
}

function normalizeNumberMap(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, rawValue]) =>
        typeof rawValue === "number" && Number.isFinite(rawValue) ? ([key, Math.max(0, Math.round(rawValue))] as const) : null,
      )
      .filter((entry): entry is readonly [string, number] => entry !== null),
  );
}

function migrateReviewStateFromSnapshots(
  reviewStateByReviewKey: Record<string, ReviewStateRecord>,
  snapshots: Snapshot[],
): Record<string, ReviewStateRecord> {
  const nextReviewStateByReviewKey = { ...reviewStateByReviewKey };

  for (const snapshot of snapshots) {
    const reviewKey = buildReviewKey(snapshot.whiteboardId, snapshot.sourceType, snapshot.sourceValue);
    if (nextReviewStateByReviewKey[reviewKey]) {
      continue;
    }

    const items = Object.fromEntries(
      snapshot.items
        .filter((item) => item.status !== "unseen")
        .map((item) => [
          item.id,
          {
            itemId: item.id,
            status: item.status,
            updatedAt: snapshot.createdAt,
          } satisfies ReviewStateItem,
        ]),
    );

    if (Object.keys(items).length === 0) {
      continue;
    }

    nextReviewStateByReviewKey[reviewKey] = {
      reviewKey,
      whiteboardId: snapshot.whiteboardId,
      sourceType: snapshot.sourceType,
      sourceValue: snapshot.sourceValue,
      normalizedSourceValue: normalizeSourceValue(snapshot.sourceValue),
      updatedAt: snapshot.createdAt,
      items,
    };
  }

  return nextReviewStateByReviewKey;
}

function applyReviewStateToSnapshot(
  snapshot: Snapshot,
  reviewStateByReviewKey: Record<string, ReviewStateRecord>,
): Snapshot {
  const reviewKey = buildReviewKey(snapshot.whiteboardId, snapshot.sourceType, snapshot.sourceValue);
  const reviewState = reviewStateByReviewKey[reviewKey];
  if (!reviewState) {
    return snapshot;
  }

  return {
    ...snapshot,
    items: snapshot.items.map((item) => ({
      ...item,
      status: reviewState.items[item.id]?.status ?? "unseen",
    })),
  };
}

function deriveSavedSourcesFromSnapshots(snapshotsByReviewKey: Record<string, Snapshot>): Record<string, string[]> {
  const grouped = new Map<string, Array<{ reviewKey: string; createdAt: number }>>();

  for (const [reviewKey, snapshot] of Object.entries(snapshotsByReviewKey)) {
    const current = grouped.get(snapshot.whiteboardId) ?? [];
    current.push({ reviewKey, createdAt: snapshot.createdAt });
    grouped.set(snapshot.whiteboardId, current);
  }

  return Object.fromEntries(
    Array.from(grouped.entries()).map(([whiteboardId, entries]) => [
      whiteboardId,
      entries.sort((left, right) => right.createdAt - left.createdAt).map((entry) => entry.reviewKey),
    ]),
  );
}

function deriveSourceMetaFromSnapshots(snapshotsByReviewKey: Record<string, Snapshot>): Record<string, SavedSourceMeta> {
  return Object.fromEntries(
    Object.entries(snapshotsByReviewKey).map(([reviewKey, snapshot]) => [
      reviewKey,
      {
        reviewKey,
        whiteboardId: snapshot.whiteboardId,
        whiteboardName: snapshot.whiteboardName,
        sourceType: snapshot.sourceType,
        sourceValue: snapshot.sourceValue,
        normalizedSourceValue: normalizeSourceValue(snapshot.sourceValue),
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.createdAt,
      } satisfies SavedSourceMeta,
    ]),
  );
}

export function isSourceTombstoneEffective(
  tombstone: SourceTombstone | null | undefined,
  sourceMeta: SavedSourceMeta | null | undefined,
): boolean {
  if (!tombstone) {
    return false;
  }

  return !sourceMeta || tombstone.deletedAt >= sourceMeta.updatedAt;
}

export function mergeReviewStateRecords(
  localReviewState: ReviewStateRecord | null | undefined,
  syncedReviewState: ReviewStateRecord,
): ReviewStateRecord {
  if (!localReviewState) {
    return syncedReviewState;
  }

  const preferredRecord =
    syncedReviewState.updatedAt >= localReviewState.updatedAt ? syncedReviewState : localReviewState;
  const mergedItems: Record<string, ReviewStateItem> = { ...localReviewState.items };

  for (const [itemId, syncedItem] of Object.entries(syncedReviewState.items)) {
    const localItem = mergedItems[itemId];
    if (!localItem || syncedItem.updatedAt >= localItem.updatedAt) {
      mergedItems[itemId] = syncedItem;
    }
  }

  const newestItemTimestamp = Object.values(mergedItems).reduce(
    (latest, item) => Math.max(latest, item.updatedAt),
    0,
  );

  return {
    ...preferredRecord,
    updatedAt: Math.max(localReviewState.updatedAt, syncedReviewState.updatedAt, newestItemTimestamp),
    items: mergedItems,
  };
}

function sanitizeSavedSources(
  savedSourcesByWhiteboard: Record<string, string[]>,
  sourceMetaByReviewKey: Record<string, SavedSourceMeta>,
  sourceTombstonesByReviewKey: Record<string, SourceTombstone>,
): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(savedSourcesByWhiteboard)
      .map(([whiteboardId, reviewKeys]) => [
        whiteboardId,
        reviewKeys.filter((reviewKey) => {
          const sourceMeta = sourceMetaByReviewKey[reviewKey];
          return Boolean(sourceMeta) && !isSourceTombstoneEffective(sourceTombstonesByReviewKey[reviewKey], sourceMeta);
        }),
      ])
      .filter(([, reviewKeys]) => reviewKeys.length > 0),
  );
}

function sanitizeActiveReviewKeys(
  activeReviewKeyByWhiteboard: Record<string, string>,
  savedSourcesByWhiteboard: Record<string, string[]>,
): Record<string, string> {
  const nextActiveReviewKeyByWhiteboard: Record<string, string> = {};

  for (const [whiteboardId, reviewKeys] of Object.entries(savedSourcesByWhiteboard)) {
    const activeReviewKey = activeReviewKeyByWhiteboard[whiteboardId];
    nextActiveReviewKeyByWhiteboard[whiteboardId] = activeReviewKey && reviewKeys.includes(activeReviewKey) ? activeReviewKey : reviewKeys[0];
  }

  return nextActiveReviewKeyByWhiteboard;
}

export function reconcileSourceTombstonesInGraphState(state: GraphState): void {
  for (const [reviewKey, tombstone] of Object.entries(state.sourceTombstonesByReviewKey)) {
    const sourceMeta = state.sourceMetaByReviewKey[reviewKey];
    if (!isSourceTombstoneEffective(tombstone, sourceMeta)) {
      delete state.sourceTombstonesByReviewKey[reviewKey];
      continue;
    }

    delete state.sourceMetaByReviewKey[reviewKey];
    delete state.snapshotsByReviewKey[reviewKey];
    delete state.reviewStateByReviewKey[reviewKey];
    delete state.scrollByReviewKey[reviewKey];
  }

  state.savedSourcesByWhiteboard = sanitizeSavedSources(
    state.savedSourcesByWhiteboard,
    state.sourceMetaByReviewKey,
    state.sourceTombstonesByReviewKey,
  );
  state.activeReviewKeyByWhiteboard = sanitizeActiveReviewKeys(
    state.activeReviewKeyByWhiteboard,
    state.savedSourcesByWhiteboard,
  );
}

function buildStateFromLegacySnapshots(
  parsed: LegacyGraphState,
  normalizedReviewStateByReviewKey: Record<string, ReviewStateRecord>,
): Pick<
  GraphState,
  | "savedSourcesByWhiteboard"
  | "activeReviewKeyByWhiteboard"
  | "sourceMetaByReviewKey"
  | "sourceTombstonesByReviewKey"
  | "snapshotsByReviewKey"
  | "reviewStateByReviewKey"
  | "scrollByReviewKey"
> {
  const snapshotsByWhiteboard = normalizeSnapshotsByWhiteboard(parsed.snapshotsByWhiteboard);
  const migratedReviewStateByReviewKey = migrateReviewStateFromSnapshots(normalizedReviewStateByReviewKey, Object.values(snapshotsByWhiteboard));
  const scrollByWhiteboard = normalizeNumberMap(parsed.scrollByWhiteboard);

  const snapshotsByReviewKey: Record<string, Snapshot> = {};
  const savedSourcesByWhiteboard: Record<string, string[]> = {};
  const activeReviewKeyByWhiteboard: Record<string, string> = {};
  const sourceMetaByReviewKey: Record<string, SavedSourceMeta> = {};
  const scrollByReviewKey: Record<string, number> = {};

  for (const [whiteboardId, snapshot] of Object.entries(snapshotsByWhiteboard)) {
    const reviewKey = buildReviewKey(snapshot.whiteboardId, snapshot.sourceType, snapshot.sourceValue);
    const hydratedSnapshot = applyReviewStateToSnapshot(snapshot, migratedReviewStateByReviewKey);

    snapshotsByReviewKey[reviewKey] = hydratedSnapshot;
    sourceMetaByReviewKey[reviewKey] = {
      reviewKey,
      whiteboardId: hydratedSnapshot.whiteboardId,
      whiteboardName: hydratedSnapshot.whiteboardName,
      sourceType: hydratedSnapshot.sourceType,
      sourceValue: hydratedSnapshot.sourceValue,
      normalizedSourceValue: normalizeSourceValue(hydratedSnapshot.sourceValue),
      createdAt: hydratedSnapshot.createdAt,
      updatedAt: hydratedSnapshot.createdAt,
    };
    savedSourcesByWhiteboard[whiteboardId] = [reviewKey];
    activeReviewKeyByWhiteboard[whiteboardId] = reviewKey;

    if (typeof scrollByWhiteboard[whiteboardId] === "number") {
      scrollByReviewKey[reviewKey] = scrollByWhiteboard[whiteboardId];
    }
  }

  return {
    savedSourcesByWhiteboard,
    activeReviewKeyByWhiteboard,
    sourceMetaByReviewKey,
    sourceTombstonesByReviewKey: {},
    snapshotsByReviewKey,
    reviewStateByReviewKey: migratedReviewStateByReviewKey,
    scrollByReviewKey,
  };
}

export function getDefaultGraphState(): GraphState {
  return {
    syncMode: "local-only",
    syncModeSettingInitialized: false,
    themePreference: "auto",
    dockVisible: true,
    dockWidth: DEFAULT_DOCK_WIDTH,
    dockWidthsByWhiteboard: {},
    savedSourcesByWhiteboard: {},
    activeReviewKeyByWhiteboard: {},
    sourceMetaByReviewKey: {},
    sourceTombstonesByReviewKey: {},
    snapshotsByReviewKey: {},
    reviewStateByReviewKey: {},
    scrollByReviewKey: {},
  };
}

export function getGraphStorageKey(graph: unknown): string {
  if (!graph || typeof graph !== "object") {
    return `${STORAGE_PREFIX}:default`;
  }

  const graphRecord = graph as Record<string, unknown>;
  const identifier = graphRecord.path ?? graphRecord.url ?? graphRecord.name ?? graphRecord.id ?? "default";

  return `${STORAGE_PREFIX}:${String(identifier)}`;
}

function getLegacyGraphStorageKeys(storageKey: string): string[] {
  const currentPrefix = `${STORAGE_PREFIX}:`;
  if (!storageKey.startsWith(currentPrefix)) {
    return [];
  }

  const suffix = storageKey.slice(currentPrefix.length);
  return LEGACY_STORAGE_PREFIXES.map((prefix) => `${prefix}:${suffix}`);
}

export function loadGraphState(storageKey: string): GraphState {
  const raw = [storageKey, ...getLegacyGraphStorageKeys(storageKey)]
    .map((key) => localStorage.getItem(key))
    .find((value): value is string => Boolean(value));

  if (!raw) {
    return getDefaultGraphState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<GraphState> & LegacyGraphState;
    const defaultState = getDefaultGraphState();
    const normalizedDockWidth = normalizeWidth(parsed.dockWidth, defaultState.dockWidth);
    const normalizedWidths = Object.fromEntries(
      Object.entries(parsed.dockWidthsByWhiteboard ?? {}).map(([whiteboardId, width]) => [
        whiteboardId,
        normalizeWidth(width, normalizedDockWidth),
      ]),
    );

    const hasV3Shape =
      Boolean(parsed.snapshotsByReviewKey) ||
      Boolean(parsed.savedSourcesByWhiteboard) ||
      Boolean(parsed.activeReviewKeyByWhiteboard) ||
      Boolean(parsed.scrollByReviewKey);

    if (!hasV3Shape) {
      const legacyState = buildStateFromLegacySnapshots(parsed, normalizeReviewStateByReviewKey(parsed.reviewStateByReviewKey));

      return {
        ...defaultState,
        ...parsed,
        syncMode: normalizeSyncMode((parsed as Record<string, unknown>).syncMode),
        syncModeSettingInitialized: normalizeBoolean((parsed as Record<string, unknown>).syncModeSettingInitialized),
        themePreference: normalizeThemePreference((parsed as Record<string, unknown>).themePreference),
        dockWidth: normalizedDockWidth,
        dockWidthsByWhiteboard: normalizedWidths,
        ...legacyState,
      };
    }

    let reviewStateByReviewKey = normalizeReviewStateByReviewKey(parsed.reviewStateByReviewKey);
    reviewStateByReviewKey = migrateReviewStateFromSnapshots(
      reviewStateByReviewKey,
      Object.values(normalizeSnapshotsByReviewKey(parsed.snapshotsByReviewKey)),
    );

    const snapshotsByReviewKey = Object.fromEntries(
      Object.entries(normalizeSnapshotsByReviewKey(parsed.snapshotsByReviewKey)).map(([reviewKey, snapshot]) => [
        reviewKey,
        applyReviewStateToSnapshot(snapshot, reviewStateByReviewKey),
      ]),
    );

    const sourceMetaByReviewKey = {
      ...deriveSourceMetaFromSnapshots(snapshotsByReviewKey),
      ...normalizeSourceMetaByReviewKey((parsed as Record<string, unknown>).sourceMetaByReviewKey),
    };
    const sourceTombstonesByReviewKey = normalizeSourceTombstonesByReviewKey(
      (parsed as Record<string, unknown>).sourceTombstonesByReviewKey,
    );

    const savedSourcesByWhiteboard = sanitizeSavedSources(
      Object.keys(normalizeStringListMap(parsed.savedSourcesByWhiteboard)).length > 0
        ? normalizeStringListMap(parsed.savedSourcesByWhiteboard)
        : deriveSavedSourcesFromSnapshots(snapshotsByReviewKey),
      sourceMetaByReviewKey,
      sourceTombstonesByReviewKey,
    );

    const activeReviewKeyByWhiteboard = sanitizeActiveReviewKeys(
      normalizeStringMap(parsed.activeReviewKeyByWhiteboard),
      savedSourcesByWhiteboard,
    );

    const nextState: GraphState = {
      ...defaultState,
      ...parsed,
      syncMode: normalizeSyncMode((parsed as Record<string, unknown>).syncMode),
      syncModeSettingInitialized: normalizeBoolean((parsed as Record<string, unknown>).syncModeSettingInitialized),
      themePreference: normalizeThemePreference((parsed as Record<string, unknown>).themePreference),
      dockWidth: normalizedDockWidth,
      dockWidthsByWhiteboard: normalizedWidths,
      savedSourcesByWhiteboard,
      activeReviewKeyByWhiteboard,
      sourceMetaByReviewKey,
      sourceTombstonesByReviewKey,
      snapshotsByReviewKey,
      reviewStateByReviewKey,
      scrollByReviewKey: normalizeNumberMap(parsed.scrollByReviewKey),
    };

    reconcileSourceTombstonesInGraphState(nextState);

    return nextState;
  } catch (_error) {
    return getDefaultGraphState();
  }
}

export function saveGraphState(storageKey: string, state: GraphState): void {
  localStorage.setItem(storageKey, JSON.stringify(state));
}
