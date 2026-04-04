import "@logseq/libs";

import { createSnapshotFromKeyword, createSnapshotFromPage, getCurrentWhiteboard } from "./query";
import { getSyncIndexPageName, getWhiteboardSyncPageName, readWhiteboardSyncState, writeWhiteboardSyncState } from "./sync";
import { DEFAULT_DOCK_WIDTH, buildReviewKey, getGraphStorageKey, loadGraphState, normalizeSourceValue, saveGraphState } from "./storage";
import type {
  GraphState,
  ItemStatus,
  ReferenceState,
  ReviewStateRecord,
  SavedSourceMeta,
  Snapshot,
  SnapshotItem,
  SnapshotSourceType,
  StatusFilter,
  SyncMode,
  ThemeMode,
  WhiteboardInfo,
} from "./types";
import type { SyncSourceSummary } from "./sync";

const APP_ROOT_ID = "whiteboard-refdock-app";
const HOST_CONTAINER_ID = "whiteboard-refdock-host";
const TOOLBAR_KEY = "whiteboard-refdock-toolbar";
const MIN_WIDTH = 320;
const DEFAULT_MAX_WIDTH = 560;
type SurfaceMode = "iframe" | "host";
type ReferenceFilter = ReferenceState;
type GraphSyncStatus = "local-only" | "pending" | "syncing" | "synced" | "error";
const SETTINGS_SCHEMA = [
  {
    key: "enableGraphSync",
    type: "boolean",
    default: false,
    title: "Enable graph sync",
    description: "Sync saved sources and review state through the graph. Snapshot cache and dock UI state stay local.",
  },
  {
    key: "maxDockWidth",
    type: "number",
    default: DEFAULT_MAX_WIDTH,
    title: "RefDock max width",
    description: "Maximum dock width in pixels.",
  },
] as const;

function getRenderableErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === "string" && error.trim()) {
    return error;
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    const directMessage = record.message;
    if (typeof directMessage === "string" && directMessage.trim()) {
      return directMessage;
    }

    try {
      return JSON.stringify(record);
    } catch (_stringifyError) {
      return String(error);
    }
  }

  return "Failed to create snapshot.";
}

class WhiteboardRefDockApp {
  private readonly iframeRoot: HTMLElement;
  private renderRoot: HTMLElement;
  private hostContainer: HTMLElement | null = null;
  private hostRoot: HTMLElement | null = null;
  private storageKey = "";
  private graphState: GraphState = loadGraphState("whiteboard-refdock:v1:bootstrap");
  private currentWhiteboard: WhiteboardInfo | null = null;
  private sourceType: SnapshotSourceType = "page";
  private sourceValue = "";
  private referenceFilter: ReferenceFilter = "linked";
  private statusFilter: StatusFilter = "all";
  private message = "";
  private error = "";
  private busy = false;
  private surfaceMode: SurfaceMode = "iframe";
  private themeMode: ThemeMode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  private diagnosticsCollapsed = true;
  private resizeCleanup: (() => void) | null = null;
  private syncWriteTimer: number | null = null;
  private syncWriteInFlight = false;
  private graphSyncStatus: GraphSyncStatus = "local-only";
  private lastGraphSyncAt: number | null = null;
  private graphSyncError = "";

  constructor(root: HTMLElement) {
    this.iframeRoot = root;
    this.renderRoot = root;
  }

  async init(): Promise<void> {
    await this.refreshGraphState();
    this.ensureSyncModeSettingInitialized();
    this.applySyncModeFromSettings();
    await this.refreshContext();
    this.render();
  }

  async refreshGraphState(): Promise<void> {
    const currentGraph = await logseq.App.getCurrentGraph();
    this.storageKey = getGraphStorageKey(currentGraph);
    this.graphState = loadGraphState(this.storageKey);
    this.graphSyncStatus = this.getSyncMode() === "graph-backed" ? "synced" : "local-only";
    this.graphSyncError = "";
  }

  private async hydrateCurrentWhiteboardFromGraphSync(): Promise<void> {
    if (this.getSyncMode() !== "graph-backed" || !this.currentWhiteboard) {
      return;
    }

    try {
      const syncedState = await readWhiteboardSyncState(this.currentWhiteboard);

      for (const [reviewKey, meta] of Object.entries(syncedState.sourceMetaByReviewKey)) {
        const localMeta = this.graphState.sourceMetaByReviewKey[reviewKey];
        if (!localMeta || meta.updatedAt >= localMeta.updatedAt) {
          this.graphState.sourceMetaByReviewKey[reviewKey] = meta;
        }
      }

      for (const [reviewKey, syncedReviewState] of Object.entries(syncedState.reviewStateByReviewKey)) {
        const localReviewState = this.graphState.reviewStateByReviewKey[reviewKey];
        if (!localReviewState || syncedReviewState.updatedAt >= localReviewState.updatedAt) {
          this.graphState.reviewStateByReviewKey[reviewKey] = syncedReviewState;
        }
      }

      const localReviewKeys = this.graphState.savedSourcesByWhiteboard[this.currentWhiteboard.id] ?? [];
      const mergedReviewKeys = [
        ...syncedState.savedReviewKeys,
        ...localReviewKeys.filter((reviewKey) => !syncedState.savedReviewKeys.includes(reviewKey)),
      ].filter((reviewKey) => Boolean(this.graphState.sourceMetaByReviewKey[reviewKey]));

      if (mergedReviewKeys.length > 0) {
        this.graphState.savedSourcesByWhiteboard[this.currentWhiteboard.id] = mergedReviewKeys;
      }
    } catch (error) {
      console.warn("whiteboard-refdock graph sync hydrate failed", error);
    }
  }

  async refreshContext(): Promise<void> {
    this.currentWhiteboard = await getCurrentWhiteboard();
    await this.hydrateCurrentWhiteboardFromGraphSync();
    this.syncActiveReviewKey();
    this.syncSourceInputFromActiveSnapshot();
    this.setCurrentDockWidth(this.getCurrentDockWidth());
    this.selectDefaultReferenceFilter(this.getActiveSnapshot());
    this.persist();
    await this.syncDockSurface();
    this.render();
    await this.ensureActiveSnapshotLoaded();
  }

  async toggleDock(): Promise<void> {
    this.graphState.dockVisible = !this.graphState.dockVisible;
    this.persist();
    await this.syncDockSurface();
    this.render();
  }

  async revealDock(): Promise<void> {
    await this.refreshGraphState();
    this.currentWhiteboard = await getCurrentWhiteboard();
    this.syncActiveReviewKey();
    this.syncSourceInputFromActiveSnapshot();

    if (!this.currentWhiteboard) {
      const routePath = this.getCurrentRoutePath();
      this.message = routePath
        ? `RefDock could not detect a whiteboard on route ${routePath}.`
        : "Open a whiteboard to use RefDock.";
      this.error = "";
      await this.syncDockSurface();
      this.render();
      await logseq.UI.showMsg(
        routePath
          ? `Whiteboard RefDock: no whiteboard detected on ${routePath}.`
          : "Whiteboard RefDock: open a whiteboard first.",
        "warning",
      );
      return;
    }

    if (!this.graphState.dockVisible) {
      this.graphState.dockVisible = true;
      this.persist();
    }

    await this.syncDockSurface();
    const snapshot = this.getActiveSnapshot();
    this.error = "";
    this.message = snapshot
      ? `Dock opened. ${snapshot.items.length} saved items loaded.`
      : "Dock opened.";
    this.render();
    await logseq.UI.showMsg("Whiteboard RefDock opened.", "success");
  }

  async refreshDock(): Promise<void> {
    await this.refreshGraphState();
    this.currentWhiteboard = await getCurrentWhiteboard();
    this.syncActiveReviewKey();
    this.syncSourceInputFromActiveSnapshot();

    if (!this.currentWhiteboard) {
      const routePath = this.getCurrentRoutePath();
      this.message = routePath
        ? `RefDock could not detect a whiteboard on route ${routePath}.`
        : "Open a whiteboard to use RefDock.";
      this.error = "";
      await this.syncDockSurface();
      this.render();
      await logseq.UI.showMsg(
        routePath
          ? `Whiteboard RefDock: no whiteboard detected on ${routePath}.`
          : "Whiteboard RefDock: open a whiteboard first.",
        "warning",
      );
      return;
    }

    if (!this.graphState.dockVisible) {
      this.graphState.dockVisible = true;
      this.persist();
    }

    await this.syncDockSurface();
    const snapshot = this.getActiveSnapshot();
    this.error = "";
    this.message = snapshot
      ? `Dock refreshed. ${snapshot.items.length} saved items loaded.`
      : "Dock refreshed.";
    this.render();
    await logseq.UI.showMsg("Whiteboard RefDock refreshed.", "success");
  }

  setThemeMode(mode: ThemeMode): void {
    this.themeMode = mode;
    this.render();
  }

  private persist(): void {
    if (this.storageKey) {
      saveGraphState(this.storageKey, this.graphState);
    }
  }

  private getSyncMode(): SyncMode {
    return this.graphState.syncMode;
  }

  private getGraphSyncStatusLabel(): string {
    if (this.getSyncMode() !== "graph-backed") {
      return "Local only";
    }

    switch (this.graphSyncStatus) {
      case "pending":
        return "Sync pending";
      case "syncing":
        return "Syncing";
      case "synced":
        return this.lastGraphSyncAt
          ? `Synced ${new Date(this.lastGraphSyncAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
          : "Synced";
      case "error":
        return "Sync failed";
      default:
        return "Graph sync enabled";
    }
  }

  private getGraphSyncHint(): string {
    if (this.getSyncMode() !== "graph-backed") {
      return "Sync is managed in plugin settings. RefDock is currently using local-only storage.";
    }

    if (this.graphSyncStatus === "error" && this.graphSyncError) {
      return `Graph sync failed: ${this.graphSyncError}`;
    }

    if (this.graphSyncStatus === "pending") {
      return "Graph sync is queued. Local cache remains active.";
    }

    if (this.graphSyncStatus === "syncing") {
      return "Graph sync is writing review state for the current whiteboard.";
    }

    return "Sync is managed in plugin settings. Local cache and graph sync are both active.";
  }

  ensureSyncModeSettingInitialized(): void {
    if (this.graphState.syncModeSettingInitialized) {
      return;
    }

    try {
      logseq.updateSettings({
        enableGraphSync: this.graphState.syncMode === "graph-backed",
      });
    } catch (error) {
      console.warn("whiteboard-refdock sync mode settings migration failed", error);
    }

    this.graphState.syncModeSettingInitialized = true;
    this.persist();
  }

  private readSyncModeFromSettings(): SyncMode {
    return logseq.settings?.enableGraphSync ? "graph-backed" : "local-only";
  }

  applySyncModeFromSettings(): boolean {
    const nextMode = this.graphState.syncModeSettingInitialized ? this.readSyncModeFromSettings() : this.graphState.syncMode;
    if (this.graphState.syncMode === nextMode) {
      return false;
    }

    this.graphState.syncMode = nextMode;
    this.graphSyncStatus = nextMode === "graph-backed" ? "synced" : "local-only";
    this.graphSyncError = "";
    this.persist();
    return true;
  }

  async handleSettingsChanged(): Promise<void> {
    const didChangeSyncMode = this.applySyncModeFromSettings();
    if (didChangeSyncMode) {
      const syncMode = this.getSyncMode();
      this.message =
        syncMode === "graph-backed"
          ? "Graph sync enabled for this graph. Local cache remains active."
          : "Local-only mode enabled. Existing graph-backed state was left intact.";
      this.error = "";
    }

    await this.refreshContext();

    if (didChangeSyncMode && this.getSyncMode() === "graph-backed") {
      this.scheduleCurrentWhiteboardSync();
    }
  }

  private upsertSourceMeta(meta: SavedSourceMeta): void {
    this.graphState.sourceMetaByReviewKey[meta.reviewKey] = meta;
  }

  private getSavedSourceMeta(reviewKey: string): SavedSourceMeta | null {
    return this.graphState.sourceMetaByReviewKey[reviewKey] ?? null;
  }

  private buildSourceMetaFromSnapshot(snapshot: Snapshot): SavedSourceMeta {
    const reviewKey = this.getReviewKey(snapshot);
    const existingMeta = this.graphState.sourceMetaByReviewKey[reviewKey];
    return {
      reviewKey,
      whiteboardId: snapshot.whiteboardId,
      whiteboardName: snapshot.whiteboardName,
      sourceType: snapshot.sourceType,
      sourceValue: snapshot.sourceValue,
      normalizedSourceValue: normalizeSourceValue(snapshot.sourceValue),
      createdAt: existingMeta?.createdAt ?? snapshot.createdAt,
      updatedAt: Date.now(),
    };
  }

  private scheduleCurrentWhiteboardSync(): void {
    if (this.getSyncMode() !== "graph-backed" || !this.currentWhiteboard) {
      return;
    }

    this.graphSyncStatus = "pending";
    this.graphSyncError = "";

    if (this.syncWriteTimer != null) {
      window.clearTimeout(this.syncWriteTimer);
    }

    this.syncWriteTimer = window.setTimeout(() => {
      void this.flushCurrentWhiteboardSync();
    }, 300);
  }

  private async flushCurrentWhiteboardSync(): Promise<void> {
    if (this.getSyncMode() !== "graph-backed" || !this.currentWhiteboard || this.syncWriteInFlight) {
      return;
    }

    if (this.syncWriteTimer != null) {
      window.clearTimeout(this.syncWriteTimer);
      this.syncWriteTimer = null;
    }

    this.syncWriteInFlight = true;
    this.graphSyncStatus = "syncing";
    this.graphSyncError = "";
    this.render();

    try {
      const reviewKeys = this.getSavedReviewKeysForWhiteboard(this.currentWhiteboard.id);
      const sourceMetas = reviewKeys
        .map((reviewKey) => this.graphState.sourceMetaByReviewKey[reviewKey])
        .filter((meta): meta is SavedSourceMeta => Boolean(meta));

      const reviewStateByReviewKey = Object.fromEntries(
        reviewKeys
          .map((reviewKey) => {
            const reviewState = this.graphState.reviewStateByReviewKey[reviewKey];
            return reviewState ? ([reviewKey, reviewState] as const) : null;
          })
          .filter((entry): entry is readonly [string, ReviewStateRecord] => entry !== null),
      );

      const summariesByReviewKey = Object.fromEntries(
        reviewKeys.map((reviewKey) => [
          reviewKey,
          this.buildSyncSourceSummary(
            this.graphState.snapshotsByReviewKey[reviewKey] ?? null,
            this.graphState.reviewStateByReviewKey[reviewKey],
          ),
        ]),
      );

      await writeWhiteboardSyncState(this.currentWhiteboard, sourceMetas, reviewStateByReviewKey, summariesByReviewKey);
      this.graphSyncStatus = "synced";
      this.lastGraphSyncAt = Date.now();
      this.graphSyncError = "";
    } catch (error) {
      console.warn("whiteboard-refdock graph sync write failed", error);
      this.graphSyncStatus = "error";
      this.graphSyncError = getRenderableErrorMessage(error);
    } finally {
      this.syncWriteInFlight = false;
      this.render();
    }
  }

  private async openCurrentSyncPage(): Promise<void> {
    if (!this.currentWhiteboard) {
      return;
    }

    if (this.getSyncMode() === "graph-backed") {
      await this.flushCurrentWhiteboardSync();
    }

    const pageName = getWhiteboardSyncPageName(this.currentWhiteboard.id);
    const page = await logseq.Editor.getPage(pageName);
    if (!page) {
      await logseq.UI.showMsg("No graph sync page exists for this whiteboard yet.", "warning");
      return;
    }

    logseq.App.pushState("page", { name: pageName });
  }

  private async openSyncIndexPage(): Promise<void> {
    if (this.getSyncMode() === "graph-backed") {
      await this.flushCurrentWhiteboardSync();
    }

    const pageName = getSyncIndexPageName();
    const page = await logseq.Editor.getPage(pageName);
    if (!page) {
      await logseq.UI.showMsg("No RefDock sync index page exists yet.", "warning");
      return;
    }

    logseq.App.pushState("page", { name: pageName });
  }

  private getConfiguredMaxWidth(): number {
    const configuredValue = Number(logseq.settings?.maxDockWidth);
    if (!Number.isFinite(configuredValue)) {
      return DEFAULT_MAX_WIDTH;
    }

    return Math.max(MIN_WIDTH, Math.round(configuredValue));
  }

  private clampWidth(width: number): number {
    return Math.min(this.getConfiguredMaxWidth(), Math.max(MIN_WIDTH, Math.round(width)));
  }

  private getCurrentDockWidth(): number {
    if (this.currentWhiteboard) {
      const storedWidth = this.graphState.dockWidthsByWhiteboard[this.currentWhiteboard.id];
      if (typeof storedWidth === "number" && Number.isFinite(storedWidth)) {
        return this.clampWidth(storedWidth);
      }
    }

    return this.clampWidth(this.graphState.dockWidth);
  }

  private setCurrentDockWidth(width: number): void {
    const normalizedWidth = this.clampWidth(width);
    this.graphState.dockWidth = normalizedWidth;

    if (this.currentWhiteboard) {
      this.graphState.dockWidthsByWhiteboard[this.currentWhiteboard.id] = normalizedWidth;
    }
  }

  private formatWidthLabel(): string {
    return `${this.getCurrentDockWidth()}px`;
  }

  private getReviewKey(snapshot: Pick<Snapshot, "whiteboardId" | "sourceType" | "sourceValue">): string {
    return buildReviewKey(snapshot.whiteboardId, snapshot.sourceType, snapshot.sourceValue);
  }

  private getSavedReviewKeysForWhiteboard(whiteboardId: string): string[] {
    const keys = this.graphState.savedSourcesByWhiteboard[whiteboardId] ?? [];
    return keys.filter((reviewKey) => Boolean(this.graphState.sourceMetaByReviewKey[reviewKey]));
  }

  private syncActiveReviewKey(): void {
    if (!this.currentWhiteboard) {
      return;
    }

    const reviewKeys = this.getSavedReviewKeysForWhiteboard(this.currentWhiteboard.id);
    if (reviewKeys.length === 0) {
      delete this.graphState.activeReviewKeyByWhiteboard[this.currentWhiteboard.id];
      return;
    }

    const activeReviewKey = this.graphState.activeReviewKeyByWhiteboard[this.currentWhiteboard.id];
    this.graphState.activeReviewKeyByWhiteboard[this.currentWhiteboard.id] =
      activeReviewKey && reviewKeys.includes(activeReviewKey) ? activeReviewKey : reviewKeys[0];
  }

  private getActiveReviewKey(): string | null {
    if (!this.currentWhiteboard) {
      return null;
    }

    const activeReviewKey = this.graphState.activeReviewKeyByWhiteboard[this.currentWhiteboard.id];
    return activeReviewKey && this.graphState.snapshotsByReviewKey[activeReviewKey] ? activeReviewKey : null;
  }

  private getActiveSnapshot(): Snapshot | null {
    const activeReviewKey = this.getActiveReviewKey();
    if (!activeReviewKey) {
      return null;
    }

    return this.graphState.snapshotsByReviewKey[activeReviewKey] ?? null;
  }

  private getSavedSourceEntries(): Array<{ reviewKey: string; meta: SavedSourceMeta; snapshot: Snapshot | null }> {
    if (!this.currentWhiteboard) {
      return [];
    }

    return this.getSavedReviewKeysForWhiteboard(this.currentWhiteboard.id)
      .map((reviewKey) => {
        const meta = this.graphState.sourceMetaByReviewKey[reviewKey];
        const snapshot = this.graphState.snapshotsByReviewKey[reviewKey];
        return meta
          ? ({
              reviewKey,
              meta,
              snapshot: snapshot ?? null,
            } as { reviewKey: string; meta: SavedSourceMeta; snapshot: Snapshot | null })
          : null;
      })
      .filter((entry): entry is { reviewKey: string; meta: SavedSourceMeta; snapshot: Snapshot | null } => entry !== null);
  }

  private async ensureActiveSnapshotLoaded(): Promise<void> {
    const activeReviewKey = this.getActiveReviewKey();
    if (!activeReviewKey || this.graphState.snapshotsByReviewKey[activeReviewKey]) {
      return;
    }

    await this.refreshSavedSource(activeReviewKey);
  }

  private syncSourceInputFromActiveSnapshot(): void {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      const activeReviewKey = this.getActiveReviewKey();
      if (!activeReviewKey) {
        return;
      }

      const meta = this.graphState.sourceMetaByReviewKey[activeReviewKey];
      if (!meta) {
        return;
      }

      this.sourceType = meta.sourceType;
      this.sourceValue = meta.sourceValue;
      return;
    }

    this.sourceType = snapshot.sourceType;
    this.sourceValue = snapshot.sourceValue;
  }

  private setActiveReviewKey(reviewKey: string): void {
    if (!this.currentWhiteboard) {
      return;
    }

    const reviewKeys = this.getSavedReviewKeysForWhiteboard(this.currentWhiteboard.id);
    if (!reviewKeys.includes(reviewKey)) {
      return;
    }

    this.graphState.activeReviewKeyByWhiteboard[this.currentWhiteboard.id] = reviewKey;
    this.syncSourceInputFromActiveSnapshot();
    this.statusFilter = "all";
    this.selectDefaultReferenceFilter(this.getActiveSnapshot());
    this.persist();
    this.render();
    this.restoreScrollPosition();
    void this.ensureActiveSnapshotLoaded();
  }

  private upsertSavedSource(snapshot: Snapshot): string {
    const reviewKey = this.getReviewKey(snapshot);
    this.upsertSourceMeta(this.buildSourceMetaFromSnapshot(snapshot));
    const reviewKeys = this.getSavedReviewKeysForWhiteboard(snapshot.whiteboardId).filter((entry) => entry !== reviewKey);
    this.graphState.savedSourcesByWhiteboard[snapshot.whiteboardId] = [reviewKey, ...reviewKeys];
    this.graphState.activeReviewKeyByWhiteboard[snapshot.whiteboardId] = reviewKey;
    return reviewKey;
  }

  private removeSavedSource(whiteboardId: string, reviewKey: string): void {
    delete this.graphState.sourceMetaByReviewKey[reviewKey];
    const remainingReviewKeys = this.getSavedReviewKeysForWhiteboard(whiteboardId).filter((entry) => entry !== reviewKey);
    if (remainingReviewKeys.length > 0) {
      this.graphState.savedSourcesByWhiteboard[whiteboardId] = remainingReviewKeys;
      const activeReviewKey = this.graphState.activeReviewKeyByWhiteboard[whiteboardId];
      this.graphState.activeReviewKeyByWhiteboard[whiteboardId] =
        activeReviewKey === reviewKey || !remainingReviewKeys.includes(activeReviewKey)
          ? remainingReviewKeys[0]
          : activeReviewKey;
      return;
    }

    delete this.graphState.savedSourcesByWhiteboard[whiteboardId];
    delete this.graphState.activeReviewKeyByWhiteboard[whiteboardId];
  }

  private getOrCreateReviewState(snapshot: Pick<Snapshot, "whiteboardId" | "sourceType" | "sourceValue">): ReviewStateRecord {
    const reviewKey = this.getReviewKey(snapshot);
    const existing = this.graphState.reviewStateByReviewKey[reviewKey];
    if (existing) {
      return existing;
    }

    const created: ReviewStateRecord = {
      reviewKey,
      whiteboardId: snapshot.whiteboardId,
      sourceType: snapshot.sourceType,
      sourceValue: snapshot.sourceValue,
      normalizedSourceValue: normalizeSourceValue(snapshot.sourceValue),
      updatedAt: Date.now(),
      items: {},
    };
    this.graphState.reviewStateByReviewKey[reviewKey] = created;
    return created;
  }

  private mergeSnapshotWithReviewState(snapshot: Snapshot): Snapshot {
    const reviewState = this.graphState.reviewStateByReviewKey[this.getReviewKey(snapshot)];
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

  private recordItemStatus(snapshot: Snapshot, itemId: string, status: ItemStatus): void {
    const reviewState = this.getOrCreateReviewState(snapshot);
    const timestamp = Date.now();

    if (status === "unseen") {
      delete reviewState.items[itemId];
    } else {
      reviewState.items[itemId] = {
        itemId,
        status,
        updatedAt: timestamp,
      };
    }

    reviewState.updatedAt = timestamp;

    const sourceMeta = this.graphState.sourceMetaByReviewKey[reviewState.reviewKey];
    if (sourceMeta) {
      sourceMeta.updatedAt = timestamp;
    }

    if (Object.keys(reviewState.items).length === 0) {
      delete this.graphState.reviewStateByReviewKey[reviewState.reviewKey];
    }

    this.scheduleCurrentWhiteboardSync();
  }

  private getVisibleItems(): SnapshotItem[] {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return [];
    }

    return snapshot.items.filter((item) => {
      if (item.referenceState !== this.referenceFilter) {
        return false;
      }

      if (this.statusFilter === "all") {
        return true;
      }

      return item.status === this.statusFilter;
    });
  }

  private getCounts(snapshot: Snapshot | null): Record<StatusFilter, number> {
    const counts: Record<StatusFilter, number> = {
      all: 0,
      unseen: 0,
      seen: 0,
      skipped: 0,
    };

    if (!snapshot) {
      return counts;
    }

    for (const item of snapshot.items) {
      if (item.referenceState !== this.referenceFilter) {
        continue;
      }

      counts.all += 1;
      counts[item.status] += 1;
    }

    return counts;
  }

  private getReferenceCounts(snapshot: Snapshot | null): Record<ReferenceFilter, number> {
    const counts: Record<ReferenceFilter, number> = {
      linked: 0,
      unlinked: 0,
    };

    if (!snapshot) {
      return counts;
    }

    for (const item of snapshot.items) {
      counts[item.referenceState] += 1;
    }

    return counts;
  }

  private buildSyncSourceSummary(
    snapshot: Snapshot | null,
    reviewState?: ReviewStateRecord,
  ): SyncSourceSummary {
    if (!snapshot) {
      const reviewItems = Object.values(reviewState?.items ?? {});
      return {
        seenCount: reviewItems.filter((item) => item.status === "seen").length,
        skippedCount: reviewItems.filter((item) => item.status === "skipped").length,
      };
    }

    const summary: SyncSourceSummary = {
      totalItems: snapshot.items.length,
      linkedCount: 0,
      unlinkedCount: 0,
      unseenCount: 0,
      seenCount: 0,
      skippedCount: 0,
    };

    for (const item of snapshot.items) {
      if (item.referenceState === "linked") {
        summary.linkedCount = (summary.linkedCount ?? 0) + 1;
      } else {
        summary.unlinkedCount = (summary.unlinkedCount ?? 0) + 1;
      }

      if (item.status === "seen") {
        summary.seenCount += 1;
      } else if (item.status === "skipped") {
        summary.skippedCount += 1;
      } else {
        summary.unseenCount = (summary.unseenCount ?? 0) + 1;
      }
    }

    return summary;
  }

  private selectDefaultReferenceFilter(snapshot: Snapshot | null): void {
    if (!snapshot) {
      this.referenceFilter = "linked";
      return;
    }

    const counts = this.getReferenceCounts(snapshot);
    this.referenceFilter = counts.linked > 0 ? "linked" : "unlinked";
  }

  private getHostDocument(): Document | null {
    try {
      const hostDocument = window.top?.document ?? null;
      if (!hostDocument || hostDocument === document) {
        return null;
      }

      return hostDocument;
    } catch (_error) {
      return null;
    }
  }

  private getPluginFrameElement(): HTMLElement | null {
    try {
      return window.frameElement instanceof HTMLElement ? window.frameElement : null;
    } catch (_error) {
      return null;
    }
  }

  private setPluginFrameVisibility(visible: boolean): void {
    const frameElement = this.getPluginFrameElement();
    if (!frameElement) {
      return;
    }

    if (visible) {
      frameElement.style.display = "block";
      frameElement.style.visibility = "visible";
      frameElement.style.pointerEvents = "auto";
      return;
    }

    frameElement.style.display = "none";
    frameElement.style.visibility = "hidden";
    frameElement.style.pointerEvents = "none";
  }

  private setMainUIOverlayVisibility(visible: boolean, width?: number): void {
    if (visible) {
      logseq.setMainUIInlineStyle({
        position: "fixed",
        top: "0",
        right: "0",
        width: `${width ?? this.getCurrentDockWidth()}px`,
        height: "100vh",
        zIndex: 11,
        display: "block",
        opacity: 1,
        pointerEvents: "auto",
        border: "none",
        background: "transparent",
        boxShadow: "none",
        overflow: "hidden",
      });
      return;
    }

    logseq.setMainUIInlineStyle({
      position: "fixed",
      top: "0",
      right: "0",
      width: "0",
      height: "0",
      zIndex: -1,
      display: "none",
      opacity: 0,
      pointerEvents: "none",
      border: "none",
      background: "transparent",
      boxShadow: "none",
      overflow: "hidden",
    });
  }

  private getCurrentRoutePath(): string | null {
    try {
      const location = window.top?.location ?? window.location;
      if (location.hash && location.hash !== "#") {
        return location.hash.startsWith("#") ? location.hash.slice(1) : location.hash;
      }

      const path = `${location.pathname}${location.search}`;
      return path || null;
    } catch (_error) {
      return null;
    }
  }

  private ensureHostRoot(): HTMLElement | null {
    const hostDocument = this.getHostDocument();
    if (!hostDocument?.body) {
      return null;
    }

    let container = hostDocument.getElementById(HOST_CONTAINER_ID) as HTMLElement | null;
    if (!container) {
      container = hostDocument.createElement("div");
      container.id = HOST_CONTAINER_ID;
      hostDocument.body.appendChild(container);
    }

    let appRoot = container.querySelector<HTMLElement>(`#${APP_ROOT_ID}`);
    if (!appRoot) {
      appRoot = hostDocument.createElement("div");
      appRoot.id = APP_ROOT_ID;
      container.appendChild(appRoot);
    }

    this.hostContainer = container;
    this.hostContainer.style.setProperty("-webkit-app-region", "no-drag");
    this.hostRoot = appRoot;
    return appRoot;
  }

  private hideHostSurface(): void {
    if (!this.hostContainer) {
      return;
    }

    this.hostContainer.remove();
    this.hostContainer = null;
    this.hostRoot = null;
  }

  private async syncDockSurface(): Promise<void> {
    const isActive = Boolean(this.currentWhiteboard && this.graphState.dockVisible);
    if (!isActive) {
      this.stopResize(false);
      this.surfaceMode = "iframe";
      this.renderRoot = this.iframeRoot;
      this.iframeRoot.style.display = "none";
      this.setPluginFrameVisibility(false);
      this.hideHostSurface();
      this.setMainUIOverlayVisibility(false);
      logseq.hideMainUI({ restoreEditingCursor: false });
      return;
    }

    const hostRoot = this.ensureHostRoot();
    const dockWidth = this.getCurrentDockWidth();
    if (hostRoot) {
      this.surfaceMode = "host";
      this.renderRoot = hostRoot;
      this.iframeRoot.style.display = "none";
      this.setPluginFrameVisibility(false);
      if (this.hostContainer) {
        Object.assign(this.hostContainer.style, {
          position: "fixed",
          top: "0",
          right: "0",
          width: `${dockWidth}px`,
          height: "100vh",
          zIndex: "60",
          display: "block",
          visibility: "visible",
          pointerEvents: "auto",
          background: "transparent",
        });
      }

      this.setMainUIOverlayVisibility(false);
      logseq.hideMainUI({ restoreEditingCursor: false });
      return;
    }

    this.surfaceMode = "iframe";
    this.renderRoot = this.iframeRoot;
    this.iframeRoot.style.display = "block";
    this.setPluginFrameVisibility(true);
    this.hideHostSurface();
    this.setMainUIOverlayVisibility(true, dockWidth);
    logseq.showMainUI({ autoFocus: false });
  }

  private async createSnapshot(): Promise<void> {
    const whiteboard = this.currentWhiteboard;
    const sourceValue = this.sourceValue.trim();

    if (!whiteboard) {
      this.setError("Open a whiteboard first.");
      return;
    }

    if (!sourceValue) {
      this.setError("Enter a page name or keyword.");
      return;
    }

    this.busy = true;
    this.error = "";
    this.message = "";
    this.render();

    try {
      const snapshot = await this.buildSnapshotForSource(whiteboard, this.sourceType, sourceValue);
      const mergedSnapshot = this.storeSnapshot(snapshot, { resetScroll: true });
      this.message = `Saved ${mergedSnapshot.items.length} snapshot items.`;
    } catch (error) {
      const message = getRenderableErrorMessage(error);
      this.setError(
        message.includes("[deferred timeout]")
          ? `${this.sourceType === "page" ? "Page" : "Keyword"} search timed out inside the Logseq runtime.`
          : message,
      );
    } finally {
      this.busy = false;
      await this.syncDockSurface();
      this.render();
    }
  }

  private async buildSnapshotForSource(
    whiteboard: WhiteboardInfo,
    sourceType: SnapshotSourceType,
    sourceValue: string,
  ): Promise<Snapshot> {
    return sourceType === "page"
      ? createSnapshotFromPage(whiteboard, sourceValue)
      : createSnapshotFromKeyword(whiteboard, sourceValue);
  }

  private storeSnapshot(snapshot: Snapshot, options: { resetScroll: boolean }): Snapshot {
    const mergedSnapshot = this.mergeSnapshotWithReviewState(snapshot);
    const reviewKey = this.upsertSavedSource(mergedSnapshot);

    this.graphState.snapshotsByReviewKey[reviewKey] = mergedSnapshot;
    if (options.resetScroll) {
      this.graphState.scrollByReviewKey[reviewKey] = 0;
    }

    this.syncSourceInputFromActiveSnapshot();
    this.statusFilter = "all";
    this.selectDefaultReferenceFilter(mergedSnapshot);
    this.persist();
    this.scheduleCurrentWhiteboardSync();

    return mergedSnapshot;
  }

  private clearSnapshot(): void {
    if (!this.currentWhiteboard) {
      return;
    }

    const activeReviewKey = this.getActiveReviewKey();
    if (!activeReviewKey) {
      return;
    }

    delete this.graphState.snapshotsByReviewKey[activeReviewKey];
    delete this.graphState.scrollByReviewKey[activeReviewKey];
    this.removeSavedSource(this.currentWhiteboard.id, activeReviewKey);

    this.syncSourceInputFromActiveSnapshot();
    this.selectDefaultReferenceFilter(this.getActiveSnapshot());
    this.persist();
    this.scheduleCurrentWhiteboardSync();
    this.message = "Active source removed.";
    this.error = "";
    this.render();
  }

  private async refreshSavedSource(reviewKey: string): Promise<void> {
    const snapshot = this.graphState.snapshotsByReviewKey[reviewKey];
    const sourceMeta = this.graphState.sourceMetaByReviewKey[reviewKey];
    const sourceType = snapshot?.sourceType ?? sourceMeta?.sourceType;
    const sourceValue = snapshot?.sourceValue ?? sourceMeta?.sourceValue;
    const whiteboardId = snapshot?.whiteboardId ?? sourceMeta?.whiteboardId;
    const whiteboardName = snapshot?.whiteboardName ?? sourceMeta?.whiteboardName;
    if (!sourceType || !sourceValue || !whiteboardId || !whiteboardName) {
      return;
    }

    this.busy = true;
    this.error = "";
    this.message = "";
    this.render();

    try {
      const whiteboard =
        this.currentWhiteboard && this.currentWhiteboard.id === whiteboardId
          ? this.currentWhiteboard
          : { id: whiteboardId, name: whiteboardName };
      const refreshedSnapshot = await this.buildSnapshotForSource(whiteboard, sourceType, sourceValue);
      const mergedSnapshot = this.storeSnapshot(refreshedSnapshot, { resetScroll: false });
      this.message = `Refreshed ${mergedSnapshot.sourceValue}.`;
    } catch (error) {
      const message = getRenderableErrorMessage(error);
      this.setError(
        message.includes("[deferred timeout]")
          ? `${sourceType === "page" ? "Page" : "Keyword"} search timed out inside the Logseq runtime.`
          : message,
      );
    } finally {
      this.busy = false;
      await this.syncDockSurface();
      this.render();
    }
  }

  private deleteSavedSource(reviewKey: string): void {
    const snapshot = this.graphState.snapshotsByReviewKey[reviewKey];
    const sourceMeta = this.graphState.sourceMetaByReviewKey[reviewKey];
    const whiteboardId = snapshot?.whiteboardId ?? sourceMeta?.whiteboardId;
    const sourceValue = snapshot?.sourceValue ?? sourceMeta?.sourceValue;
    if (!whiteboardId || !sourceValue) {
      return;
    }

    delete this.graphState.snapshotsByReviewKey[reviewKey];
    delete this.graphState.scrollByReviewKey[reviewKey];
    delete this.graphState.reviewStateByReviewKey[reviewKey];
    this.removeSavedSource(whiteboardId, reviewKey);

    this.syncSourceInputFromActiveSnapshot();
    this.statusFilter = "all";
    this.selectDefaultReferenceFilter(this.getActiveSnapshot());
    this.persist();
    this.scheduleCurrentWhiteboardSync();
    this.message = `Deleted source ${sourceValue}.`;
    this.error = "";
    this.render();
  }

  private setError(message: string): void {
    this.error = message;
    this.message = "";
    this.render();
  }

  private updateItemStatus(itemId: string, status: ItemStatus): void {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return;
    }

    const item = snapshot.items.find((entry) => entry.id === itemId);
    if (!item) {
      return;
    }

    item.status = status;
    this.recordItemStatus(snapshot, item.id, status);
    this.persist();
    this.render();
  }

  private async openItem(itemId: string): Promise<void> {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return;
    }

    const item = snapshot?.items.find((entry) => entry.id === itemId);
    if (!item?.pageName) {
      return;
    }

    if (item.status === "unseen") {
      item.status = "seen";
      this.recordItemStatus(snapshot, item.id, "seen");
      this.persist();
    }

    if (item.type === "block" && item.blockUuid) {
      await logseq.Editor.scrollToBlockInPage(item.pageName, item.blockUuid);
      return;
    }

    logseq.App.pushState("page", { name: item.pageName });
  }

  private applyDockWidth(): void {
    const width = `${this.getCurrentDockWidth()}px`;
    if (this.surfaceMode === "host" && this.hostContainer) {
      this.hostContainer.style.width = width;
      return;
    }

    if (this.surfaceMode === "iframe") {
      this.setMainUIOverlayVisibility(true, this.getCurrentDockWidth());
    }
  }

  private updateWidthReadout(): void {
    const ownerDocument = this.renderRoot.ownerDocument ?? document;
    this.renderRoot
      .querySelector<HTMLElement>("[data-role='width-readout']")
      ?.replaceChildren(ownerDocument.createTextNode(this.formatWidthLabel()));
  }

  private stopResize(shouldPersist = true): void {
    if (!this.resizeCleanup) {
      return;
    }

    this.renderRoot.querySelector<HTMLElement>(".panel")?.removeAttribute("data-resizing");
    this.resizeCleanup();
    this.resizeCleanup = null;

    if (shouldPersist) {
      this.persist();
      this.render();
    }
  }

  private startResize(event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.stopResize(false);

    const ownerWindow = this.renderRoot.ownerDocument?.defaultView ?? window;
    const ownerDocument = this.renderRoot.ownerDocument ?? document;
    const startClientX = event.clientX;
    const startWidth = this.getCurrentDockWidth();
    this.renderRoot.querySelector<HTMLElement>(".panel")?.setAttribute("data-resizing", "true");

    const onMove = (moveEvent: PointerEvent): void => {
      const delta = moveEvent.clientX - startClientX;
      const nextWidth = this.clampWidth(startWidth - delta);
      if (nextWidth === this.getCurrentDockWidth()) {
        return;
      }

      this.setCurrentDockWidth(nextWidth);
      this.applyDockWidth();
      this.updateWidthReadout();
    };

    const onEnd = (): void => {
      this.stopResize();
    };

    ownerDocument.body.style.userSelect = "none";
    ownerDocument.body.style.cursor = "ew-resize";
    ownerWindow.addEventListener("pointermove", onMove);
    ownerWindow.addEventListener("pointerup", onEnd);
    ownerWindow.addEventListener("pointercancel", onEnd);

    this.resizeCleanup = () => {
      ownerWindow.removeEventListener("pointermove", onMove);
      ownerWindow.removeEventListener("pointerup", onEnd);
      ownerWindow.removeEventListener("pointercancel", onEnd);
      ownerDocument.body.style.userSelect = "";
      ownerDocument.body.style.cursor = "";
    };
  }

  private resetDockWidth(): void {
    this.setCurrentDockWidth(DEFAULT_DOCK_WIDTH);
    this.persist();
    this.applyDockWidth();
    this.render();
  }

  private saveScrollPosition(scrollTop: number): void {
    const activeReviewKey = this.getActiveReviewKey();
    if (!activeReviewKey) {
      return;
    }

    this.graphState.scrollByReviewKey[activeReviewKey] = scrollTop;
    this.persist();
  }

  private restoreScrollPosition(): void {
    const activeReviewKey = this.getActiveReviewKey();
    if (!activeReviewKey) {
      return;
    }

    const scrollContainer = this.renderRoot.querySelector<HTMLElement>("[data-role='list-scroll']");
    if (!scrollContainer) {
      return;
    }

    const scrollTop = this.graphState.scrollByReviewKey[activeReviewKey] ?? 0;
    scrollContainer.scrollTop = scrollTop;
  }

  private bindEvents(): void {
    const root = this.renderRoot;

    root.querySelector<HTMLElement>("[data-action='create-snapshot']")?.addEventListener("click", () => {
      void this.createSnapshot();
    });

    root.querySelector<HTMLElement>("[data-action='clear-snapshot']")?.addEventListener("click", () => {
      this.clearSnapshot();
    });

    root.querySelectorAll<HTMLElement>("[data-review-key]").forEach((button) => {
      button.addEventListener("click", () => {
        const reviewKey = button.dataset.reviewKey;
        if (reviewKey) {
          this.setActiveReviewKey(reviewKey);
        }
      });
    });

    root.querySelectorAll<HTMLElement>("[data-source-refresh]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const reviewKey = button.dataset.sourceRefresh;
        if (reviewKey) {
          void this.refreshSavedSource(reviewKey);
        }
      });
    });

    root.querySelectorAll<HTMLElement>("[data-source-delete]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        const reviewKey = button.dataset.sourceDelete;
        if (reviewKey) {
          this.deleteSavedSource(reviewKey);
        }
      });
    });

    root.querySelector<HTMLElement>("[data-action='toggle-diagnostics']")?.addEventListener("click", () => {
      this.diagnosticsCollapsed = !this.diagnosticsCollapsed;
      this.render();
    });

    root.querySelector<HTMLElement>("[data-action='toggle-dock']")?.addEventListener("click", () => {
      void this.toggleDock();
    });

    root.querySelector<HTMLElement>("[data-action='refresh-dock']")?.addEventListener("click", () => {
      void this.refreshDock();
    });

    root.querySelector<HTMLElement>("[data-action='open-current-sync-page']")?.addEventListener("click", () => {
      void this.openCurrentSyncPage();
    });

    root.querySelector<HTMLElement>("[data-action='open-sync-index-page']")?.addEventListener("click", () => {
      void this.openSyncIndexPage();
    });

    root.querySelector<HTMLElement>("[data-action='start-resize']")?.addEventListener("pointerdown", (event) => {
      this.startResize(event);
    });

    root.querySelector<HTMLElement>("[data-action='start-resize']")?.addEventListener("dblclick", (event) => {
      event.preventDefault();
      this.stopResize(false);
      this.resetDockWidth();
    });

    root.querySelectorAll<HTMLElement>("[data-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextFilter = button.dataset.filter as StatusFilter | undefined;
        if (!nextFilter || nextFilter === this.statusFilter) {
          return;
        }

        this.statusFilter = nextFilter;
        this.render();
      });
    });

    root.querySelectorAll<HTMLElement>("[data-reference-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextFilter = button.dataset.referenceFilter as ReferenceFilter | undefined;
        if (!nextFilter || nextFilter === this.referenceFilter) {
          return;
        }

        this.referenceFilter = nextFilter;
        this.render();
      });
    });

    root.querySelector<HTMLInputElement>("[data-role='source-input']")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      this.sourceValue = target.value;
    });

    root.querySelectorAll<HTMLElement>("[data-source-type]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextType = button.dataset.sourceType as SnapshotSourceType | undefined;
        if (!nextType || nextType === this.sourceType) {
          return;
        }

        this.sourceType = nextType;
        this.error = "";
        this.message = "";
        this.render();
      });
    });

    root.querySelector<HTMLElement>("[data-role='list-scroll']")?.addEventListener("scroll", (event) => {
      const target = event.currentTarget as HTMLElement;
      this.saveScrollPosition(target.scrollTop);
    });

    root.querySelectorAll<HTMLElement>("[data-item-open]").forEach((button) => {
      button.addEventListener("click", () => {
        const itemId = button.dataset.itemOpen;
        if (itemId) {
          void this.openItem(itemId);
        }
      });
    });

    root.querySelectorAll<HTMLElement>("[data-item-status]").forEach((button) => {
      button.addEventListener("click", () => {
        const itemId = button.dataset.itemId;
        const status = button.dataset.itemStatus as ItemStatus | undefined;
        if (itemId && status) {
          this.updateItemStatus(itemId, status);
        }
      });
    });

    root.querySelectorAll<HTMLElement>("[data-item-drag]").forEach((element) => {
      element.addEventListener("dragstart", (event) => {
        const itemId = element.dataset.itemDrag;
        const snapshot = this.getActiveSnapshot();
        if (!snapshot) {
          return;
        }

        const item = snapshot?.items.find((entry) => entry.id === itemId);
        if (!item || !event.dataTransfer) {
          return;
        }

        event.dataTransfer.clearData();

        if (item.type === "page" && item.pageName) {
          event.dataTransfer.setData("page-name", item.pageName);
          // Fall back to a native page ref if the custom transfer type is ignored.
          event.dataTransfer.setData("text/plain", `[[${item.pageName}]]`);
        }

        if (item.type === "block" && item.blockUuid) {
          event.dataTransfer.setData("block-uuid", item.blockUuid);
          // Fall back to a native block ref instead of exposing the raw UUID as text.
          event.dataTransfer.setData("text/plain", `((${item.blockUuid}))`);
        }

        event.dataTransfer.effectAllowed = "copy";

        if (item.status === "unseen") {
          item.status = "seen";
          this.recordItemStatus(snapshot, item.id, "seen");
          this.persist();
        }
      });
    });

    root.querySelector<HTMLElement>("[data-role='source-input']")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void this.createSnapshot();
      }
    });
  }

  private renderEmptyState(snapshot: Snapshot | null): string {
    if (!snapshot) {
      return `
        <div class="empty-state">
          <h3>No snapshot yet</h3>
          <p>Create a saved review list from a page or keyword. The list will stay attached to this whiteboard.</p>
        </div>
      `;
    }

    return `
      <div class="empty-state">
        <h3>No items in this filter</h3>
        <p>Try the other reference tab, adjust the status filter, or create a new snapshot.</p>
      </div>
    `;
  }

  private renderDiagnostics(snapshot: Snapshot | null): string {
    if (!snapshot?.diagnostics?.lines?.length) {
      return "";
    }

    return `
      <section class="diagnostics ${this.diagnosticsCollapsed ? "collapsed" : ""}">
        <button class="diagnostics-toggle" data-action="toggle-diagnostics" aria-expanded="${this.diagnosticsCollapsed ? "false" : "true"}">
          <span class="diagnostics-title">Diagnostics</span>
          <span class="diagnostics-toggle-copy">${this.diagnosticsCollapsed ? "Show" : "Hide"}</span>
        </button>
        ${this.diagnosticsCollapsed ? "" : `<pre class="diagnostics-body">${escapeHtml(snapshot.diagnostics.lines.join("\n"))}</pre>`}
      </section>
    `;
  }

  render(): void {
    const snapshot = this.getActiveSnapshot();
    const activeReviewKey = this.getActiveReviewKey();
    const savedSourceEntries = this.getSavedSourceEntries();
    const visibleItems = this.getVisibleItems();
    const counts = this.getCounts(snapshot);
    const referenceCounts = this.getReferenceCounts(snapshot);
    const sourcePlaceholder = this.sourceType === "page" ? "Page name" : "Keyword";
    const trimmedSourceValue = this.sourceValue.trim();
    const draftReviewKey =
      this.currentWhiteboard && trimmedSourceValue
        ? buildReviewKey(this.currentWhiteboard.id, this.sourceType, trimmedSourceValue)
        : null;
    const createSnapshotLabel =
      this.busy ? "Saving..." : draftReviewKey && this.graphState.sourceMetaByReviewKey[draftReviewKey] ? "Refresh Snapshot" : "Create Snapshot";
    const routeLabel = this.currentWhiteboard?.name ?? "No whiteboard";
    const isDockActive = Boolean(this.currentWhiteboard && this.graphState.dockVisible);
    const surfaceHint =
      this.surfaceMode === "host"
        ? "Host dock active. Drag cards directly into the whiteboard."
        : "Iframe dock fallback. Drag support depends on the current Logseq runtime.";
    const root = this.renderRoot;
    if (this.iframeRoot !== root) {
      this.iframeRoot.innerHTML = "";
    }
    if (this.hostRoot && this.hostRoot !== root) {
      this.hostRoot.innerHTML = "";
    }

    root.dataset.theme = this.themeMode;
    root.innerHTML = `
      <style>
        :root {
          color-scheme: light dark;
        }

        * {
          box-sizing: border-box;
        }

        html, body, #${APP_ROOT_ID} {
          margin: 0;
          width: 100%;
          height: 100%;
          overflow: hidden;
          font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }

        body {
          background: transparent;
        }

        #${APP_ROOT_ID} {
          --panel-bg-light: rgba(255, 255, 255, 0.96);
          --panel-bg-dark: rgba(17, 24, 39, 0.96);
          --panel-border-light: rgba(15, 23, 42, 0.09);
          --panel-border-dark: rgba(255, 255, 255, 0.08);
          --muted-light: #475569;
          --muted-dark: #94a3b8;
          --text-light: #0f172a;
          --text-dark: #f8fafc;
          --chip-light: #e2e8f0;
          --chip-dark: #1e293b;
          --accent: #2563eb;
          --success: #16a34a;
          --warning: #d97706;
          display: flex;
          align-items: stretch;
          justify-content: flex-end;
          color: var(--text-light);
          -webkit-app-region: no-drag;
        }

        #${APP_ROOT_ID}[data-theme="dark"] {
          color: var(--text-dark);
        }

        .panel {
          position: relative;
          width: 100%;
          height: 100%;
          display: flex;
          flex-direction: column;
          border-left: 1px solid var(--panel-border-light);
          background:
            radial-gradient(circle at top right, rgba(37, 99, 235, 0.10), transparent 26%),
            linear-gradient(180deg, rgba(255, 255, 255, 0.98), rgba(248, 250, 252, 0.96));
          backdrop-filter: blur(18px);
          box-shadow: -12px 0 32px rgba(15, 23, 42, 0.12);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .panel {
          border-left-color: var(--panel-border-dark);
          background:
            radial-gradient(circle at top right, rgba(96, 165, 250, 0.14), transparent 24%),
            linear-gradient(180deg, rgba(15, 23, 42, 0.98), rgba(17, 24, 39, 0.96));
          box-shadow: -16px 0 40px rgba(0, 0, 0, 0.35);
        }

        .header,
        .sources,
        .controls,
        .filters,
        .status-bar {
          padding: 12px 14px;
          border-bottom: 1px solid var(--panel-border-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .header,
        #${APP_ROOT_ID}[data-theme="dark"] .sources,
        #${APP_ROOT_ID}[data-theme="dark"] .controls,
        #${APP_ROOT_ID}[data-theme="dark"] .filters,
        #${APP_ROOT_ID}[data-theme="dark"] .status-bar {
          border-bottom-color: var(--panel-border-dark);
        }

        .header {
          display: grid;
          gap: 8px;
        }

        .header-row,
        .control-row,
        .filter-row,
        .status-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .header-row {
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }

        .header-actions {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
        }

        .title-group {
          min-width: 0;
          display: grid;
          gap: 3px;
        }

        .eyebrow {
          margin: 0;
          font-size: 9px;
          font-weight: 700;
          letter-spacing: 0.10em;
          text-transform: uppercase;
          color: var(--accent);
        }

        .subtitle {
          margin: 0;
          font-size: 12px;
          font-weight: 600;
          line-height: 1.25;
          color: var(--muted-light);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .subtitle,
        #${APP_ROOT_ID}[data-theme="dark"] .hint,
        #${APP_ROOT_ID}[data-theme="dark"] .message,
        #${APP_ROOT_ID}[data-theme="dark"] .count {
          color: var(--muted-dark);
        }

        button,
        input {
          font: inherit;
        }

        .ghost-button,
        .chip-button,
        .primary-button,
        .status-button {
          border: 1px solid transparent;
          border-radius: 10px;
          cursor: pointer;
          white-space: nowrap;
          flex-shrink: 0;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        }

        .ghost-button,
        .status-button {
          padding: 6px 10px;
          background: transparent;
          color: inherit;
          border-color: var(--panel-border-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .ghost-button,
        #${APP_ROOT_ID}[data-theme="dark"] .status-button {
          border-color: var(--panel-border-dark);
        }

        .primary-button {
          padding: 8px 12px;
          background: var(--accent);
          color: white;
        }

        .primary-button[disabled] {
          opacity: 0.6;
          cursor: wait;
        }

        .chip-button {
          padding: 6px 10px;
          background: var(--chip-light);
          color: inherit;
          border: 1px solid transparent;
        }

        .tab-button {
          flex: 1;
          justify-content: center;
          min-width: 0;
          padding: 5px 8px;
          font-size: 12px;
          font-weight: 600;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .chip-button {
          background: var(--chip-dark);
        }

        .chip-button.active,
        .status-button.active {
          border-color: var(--accent);
          color: var(--accent);
          background: rgba(37, 99, 235, 0.10);
        }

        .source-input {
          width: 100%;
          border-radius: 10px;
          border: 1px solid var(--panel-border-light);
          background: rgba(255, 255, 255, 0.64);
          color: inherit;
          padding: 10px 12px;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-input {
          border-color: var(--panel-border-dark);
          background: rgba(15, 23, 42, 0.54);
        }

        .source-input:focus {
          outline: none;
          border-color: rgba(37, 99, 235, 0.6);
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.14);
        }

        .controls {
          display: grid;
          gap: 10px;
          background: linear-gradient(180deg, rgba(148, 163, 184, 0.06), rgba(148, 163, 184, 0.02));
        }

        .sources {
          display: grid;
          gap: 10px;
          background: linear-gradient(180deg, rgba(37, 99, 235, 0.03), rgba(37, 99, 235, 0.01));
        }

        .section-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
        }

        .section-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--muted-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .section-title {
          color: var(--muted-dark);
        }

        .source-list {
          display: grid;
          gap: 8px;
          max-height: 168px;
          overflow: auto;
          padding-right: 2px;
        }

        .source-row {
          width: 100%;
          display: grid;
          gap: 7px;
          border: 1px solid var(--panel-border-light);
          border-radius: 12px;
          padding: 10px 11px;
          background: rgba(255, 255, 255, 0.62);
          color: inherit;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.15s ease, background 0.15s ease, transform 0.15s ease;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-row {
          border-color: var(--panel-border-dark);
          background: rgba(15, 23, 42, 0.54);
        }

        .source-row:hover {
          transform: translateX(-1px);
          border-color: rgba(37, 99, 235, 0.28);
        }

        .source-row.active {
          border-color: rgba(37, 99, 235, 0.55);
          background: rgba(37, 99, 235, 0.10);
          box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.08);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-row.active {
          background: rgba(37, 99, 235, 0.16);
        }

        .source-row-head,
        .source-row-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          justify-content: space-between;
        }

        .source-row-meta {
          flex-wrap: wrap;
          justify-content: flex-start;
        }

        .source-actions {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          flex-shrink: 0;
        }

        .source-action {
          padding: 4px 8px;
          border-radius: 8px;
          border: 1px solid var(--panel-border-light);
          background: transparent;
          color: inherit;
          font-size: 11px;
          cursor: pointer;
          white-space: nowrap;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-action {
          border-color: var(--panel-border-dark);
        }

        .source-action:hover {
          border-color: rgba(37, 99, 235, 0.34);
          color: var(--accent);
        }

        .source-label {
          min-width: 0;
          font-size: 13px;
          font-weight: 700;
          line-height: 1.35;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .source-chip {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 7px;
          border-radius: 999px;
          background: rgba(148, 163, 184, 0.12);
          font-size: 11px;
          font-weight: 600;
          color: var(--muted-light);
          white-space: nowrap;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-chip {
          color: var(--muted-dark);
          background: rgba(148, 163, 184, 0.14);
        }

        .source-chip.type-page {
          color: #1d4ed8;
          background: rgba(37, 99, 235, 0.12);
        }

        .source-chip.type-keyword {
          color: #7c3aed;
          background: rgba(124, 58, 237, 0.12);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-chip.type-page {
          color: #bfdbfe;
          background: rgba(37, 99, 235, 0.20);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-chip.type-keyword {
          color: #ddd6fe;
          background: rgba(124, 58, 237, 0.22);
        }

        .source-empty {
          border: 1px dashed var(--panel-border-light);
          border-radius: 12px;
          padding: 12px;
          font-size: 12px;
          color: var(--muted-light);
          text-align: center;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .source-empty {
          border-color: var(--panel-border-dark);
          color: var(--muted-dark);
        }

        .controls-grid {
          display: grid;
          gap: 8px;
        }

        .reference-tabs {
          display: inline-flex;
          width: 100%;
          padding: 4px;
          border-radius: 12px;
          background: rgba(148, 163, 184, 0.12);
          gap: 4px;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .reference-tabs {
          background: rgba(148, 163, 184, 0.10);
        }

        .mode-switch {
          display: inline-flex;
          width: fit-content;
          padding: 4px;
          border-radius: 12px;
          background: rgba(148, 163, 184, 0.12);
          gap: 4px;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .mode-switch {
          background: rgba(148, 163, 184, 0.10);
        }

        .snapshot-pill {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 5px 9px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.10);
          color: var(--accent);
          font-size: 11px;
          font-weight: 600;
        }

        .width-chip {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 54px;
          padding: 5px 9px;
          border-radius: 999px;
          border: 1px solid var(--panel-border-light);
          background: rgba(255, 255, 255, 0.6);
          font-size: 11px;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
          word-break: keep-all;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .width-chip {
          border-color: var(--panel-border-dark);
          background: rgba(15, 23, 42, 0.5);
        }

        .status-bar {
          display: grid;
          gap: 4px;
        }

        .message {
          font-size: 12px;
          color: var(--muted-light);
        }

        .message.error {
          color: #dc2626;
        }

        .list-shell {
          min-height: 0;
          flex: 1;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }

        .list-scroll {
          min-height: 0;
          flex: 1;
          overflow: auto;
          padding: 12px;
          display: grid;
          gap: 10px;
          align-content: start;
        }

        .item-card {
          border: 1px solid var(--panel-border-light);
          border-radius: 14px;
          background: rgba(255, 255, 255, 0.72);
          padding: 12px;
          display: grid;
          gap: 10px;
          cursor: grab;
          transition: transform 0.14s ease, box-shadow 0.14s ease, border-color 0.14s ease;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .item-card {
          border-color: var(--panel-border-dark);
          background: rgba(15, 23, 42, 0.72);
        }

        .item-card:hover {
          transform: translateX(-2px);
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.10);
        }

        .item-card[data-status="seen"] {
          border-color: rgba(22, 163, 74, 0.4);
          background: linear-gradient(180deg, rgba(22, 163, 74, 0.06), rgba(255, 255, 255, 0.72));
        }

        .item-card[data-status="skipped"] {
          border-color: rgba(217, 119, 6, 0.45);
          background: linear-gradient(180deg, rgba(217, 119, 6, 0.06), rgba(255, 255, 255, 0.72));
        }

        #${APP_ROOT_ID}[data-theme="dark"] .item-card[data-status="seen"] {
          background: linear-gradient(180deg, rgba(22, 163, 74, 0.10), rgba(15, 23, 42, 0.74));
        }

        #${APP_ROOT_ID}[data-theme="dark"] .item-card[data-status="skipped"] {
          background: linear-gradient(180deg, rgba(217, 119, 6, 0.10), rgba(15, 23, 42, 0.74));
        }

        .item-head {
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }

        .drag-pill {
          width: 10px;
          min-width: 10px;
          align-self: stretch;
          border-radius: 999px;
          background: linear-gradient(180deg, #60a5fa 0%, #2563eb 100%);
        }

        .item-main {
          min-width: 0;
          flex: 1;
        }

        .item-title {
          margin: 0;
          font-size: 14px;
          font-weight: 700;
          line-height: 1.35;
          word-break: break-word;
        }

        .item-meta {
          margin-top: 5px;
          font-size: 11px;
          color: var(--muted-light);
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .item-meta {
          color: var(--muted-dark);
        }

        .item-meta span {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          padding: 3px 7px;
          border-radius: 999px;
          background: rgba(148, 163, 184, 0.12);
        }

        .reference-chip.linked {
          color: #1d4ed8;
          background: rgba(37, 99, 235, 0.12);
        }

        .reference-chip.unlinked {
          color: #047857;
          background: rgba(16, 185, 129, 0.14);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .reference-chip.linked {
          color: #93c5fd;
          background: rgba(37, 99, 235, 0.18);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .reference-chip.unlinked {
          color: #86efac;
          background: rgba(16, 185, 129, 0.18);
        }

        .item-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 999px;
          display: inline-block;
          background: #94a3b8;
        }

        .status-dot.seen {
          background: var(--success);
        }

        .status-dot.skipped {
          background: var(--warning);
        }

        .empty-state {
          border: 1px dashed var(--panel-border-light);
          border-radius: 16px;
          padding: 22px 16px;
          text-align: center;
          color: var(--muted-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .empty-state {
          border-color: var(--panel-border-dark);
          color: var(--muted-dark);
        }

        .empty-state h3 {
          margin: 0 0 8px;
          font-size: 15px;
          color: inherit;
        }

        .empty-state p {
          margin: 0;
          font-size: 12px;
          line-height: 1.5;
        }

        .hint {
          font-size: 11px;
          color: var(--muted-light);
        }

        .sync-status-row {
          display: flex;
          gap: 8px;
          align-items: center;
          flex-wrap: wrap;
          justify-content: flex-end;
        }

        .sync-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }

        .sync-chip {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 4px 9px;
          border-radius: 999px;
          font-size: 11px;
          font-weight: 600;
          background: rgba(59, 130, 246, 0.10);
          color: #1d4ed8;
        }

        .sync-chip.local-only {
          background: rgba(148, 163, 184, 0.14);
          color: #475569;
        }

        .sync-chip.pending {
          background: rgba(245, 158, 11, 0.14);
          color: #b45309;
        }

        .sync-chip.syncing {
          background: rgba(59, 130, 246, 0.14);
          color: #1d4ed8;
        }

        .sync-chip.synced {
          background: rgba(16, 185, 129, 0.14);
          color: #047857;
        }

        .sync-chip.error {
          background: rgba(239, 68, 68, 0.14);
          color: #b91c1c;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .sync-chip.local-only {
          background: rgba(148, 163, 184, 0.14);
          color: #cbd5e1;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .sync-chip.pending {
          background: rgba(245, 158, 11, 0.18);
          color: #fde68a;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .sync-chip.syncing {
          background: rgba(59, 130, 246, 0.18);
          color: #bfdbfe;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .sync-chip.synced {
          background: rgba(16, 185, 129, 0.18);
          color: #86efac;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .sync-chip.error {
          background: rgba(239, 68, 68, 0.18);
          color: #fca5a5;
        }

        .spacer {
          flex: 1;
        }

        .resize-handle {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 14px;
          transform: translateX(-50%);
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: ew-resize;
          touch-action: none;
          z-index: 2;
        }

        .resize-handle::before {
          content: "";
          width: 4px;
          height: 56px;
          border-radius: 999px;
          background: rgba(37, 99, 235, 0.16);
          box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.1);
          transition: background 0.15s ease, opacity 0.15s ease, transform 0.15s ease;
        }

        .resize-handle:hover::before,
        .resize-handle:active::before {
          background: rgba(37, 99, 235, 0.4);
          transform: scaleY(1.06);
        }

        .panel[data-resizing="true"] .resize-handle::before {
          background: rgba(37, 99, 235, 0.58);
          transform: scaleY(1.12);
          box-shadow: 0 0 0 1px rgba(37, 99, 235, 0.2), 0 0 0 8px rgba(37, 99, 235, 0.08);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .resize-handle::before {
          background: rgba(96, 165, 250, 0.24);
          box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.14);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .panel[data-resizing="true"] .resize-handle::before {
          background: rgba(96, 165, 250, 0.62);
          box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.2), 0 0 0 8px rgba(96, 165, 250, 0.08);
        }

        .diagnostics {
          padding: 12px 14px;
          border-top: 1px solid var(--panel-border-light);
          background: rgba(148, 163, 184, 0.06);
          box-shadow: 0 -8px 20px rgba(15, 23, 42, 0.05);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .diagnostics {
          border-top-color: var(--panel-border-dark);
          background: rgba(148, 163, 184, 0.08);
        }

        .diagnostics.collapsed {
          padding-top: 10px;
          padding-bottom: 10px;
        }

        .diagnostics-toggle {
          width: 100%;
          border: 0;
          background: transparent;
          color: inherit;
          padding: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          cursor: pointer;
          text-align: left;
        }

        .diagnostics-title {
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--muted-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .diagnostics-title {
          color: var(--muted-dark);
        }

        .diagnostics-toggle-copy {
          font-size: 11px;
          color: var(--muted-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .diagnostics-toggle-copy {
          color: var(--muted-dark);
        }

        .diagnostics-body {
          margin: 8px 0 0;
          white-space: pre-wrap;
          word-break: break-word;
          font-size: 11px;
          line-height: 1.5;
          color: inherit;
          user-select: text;
        }

        .diagnostics-toggle:hover .diagnostics-title,
        .diagnostics-toggle:hover .diagnostics-toggle-copy {
          color: var(--accent);
        }
      </style>
      <div class="panel">
        <div
          class="resize-handle"
          data-action="start-resize"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize RefDock"
          title="Drag to resize. Double-click to reset."
        ></div>
        <section class="header">
          <div class="header-row">
            <div class="title-group">
              <p class="eyebrow">Review dock</p>
              <p class="subtitle">${escapeHtml(routeLabel)}</p>
            </div>
            <div class="header-actions">
              <button class="ghost-button" data-action="refresh-dock">Refresh</button>
              <button class="ghost-button" data-action="toggle-dock">${isDockActive ? "Hide" : "Show"}</button>
            </div>
          </div>
          <div class="status-row">
            <span class="hint">${
              snapshot
                ? `Snapshot source: ${escapeHtml(snapshot.sourceType)} · ${escapeHtml(snapshot.sourceValue)}`
                : "No active snapshot"
            }</span>
            <span class="spacer"></span>
            ${
              snapshot
                ? `<span class="snapshot-pill">${snapshot.items.length} items</span>`
                : ""
            }
            <span class="width-chip" data-role="width-readout">${this.formatWidthLabel()}</span>
            <span class="hint">Drag edge to resize</span>
          </div>
        </section>

        <section class="sources">
          <div class="section-row">
            <span class="section-title">Saved sources</span>
            <span class="hint">${savedSourceEntries.length} saved</span>
          </div>
          <div class="source-list">
            ${
              savedSourceEntries.length === 0
                ? `<div class="source-empty">No saved sources on this whiteboard yet.</div>`
                : savedSourceEntries
                    .map(({ reviewKey, meta, snapshot: sourceSnapshot }) => {
                      const sourceReferenceCounts = this.getReferenceCounts(sourceSnapshot);
                      return `
                        <article class="source-row ${reviewKey === activeReviewKey ? "active" : ""}" data-review-key="${escapeAttribute(reviewKey)}" role="button" tabindex="0">
                          <div class="source-row-head">
                            <span class="source-label">${escapeHtml(meta.sourceValue)}</span>
                            <div class="source-actions">
                              <span class="source-chip">${sourceSnapshot ? `${sourceSnapshot.items.length} items` : "Needs refresh"}</span>
                              <button class="source-action" data-source-refresh="${escapeAttribute(reviewKey)}" ${this.busy ? "disabled" : ""}>Refresh</button>
                              <button class="source-action" data-source-delete="${escapeAttribute(reviewKey)}">Delete</button>
                            </div>
                          </div>
                          <div class="source-row-meta">
                            <span class="source-chip type-${escapeAttribute(meta.sourceType)}">${escapeHtml(meta.sourceType)}</span>
                            ${
                              sourceSnapshot
                                ? `<span class="source-chip">${sourceReferenceCounts.linked} linked</span>
                                   <span class="source-chip">${sourceReferenceCounts.unlinked} unlinked</span>`
                                : `<span class="source-chip">local cache missing</span>`
                            }
                          </div>
                        </article>
                      `;
                    })
                    .join("")
            }
          </div>
        </section>

        <section class="controls">
          <div class="control-row">
            <div class="mode-switch">
              <button class="chip-button ${this.sourceType === "page" ? "active" : ""}" data-source-type="page">Page</button>
              <button class="chip-button ${this.sourceType === "keyword" ? "active" : ""}" data-source-type="keyword">Keyword</button>
            </div>
            <div class="sync-status-row">
              <span class="sync-chip ${escapeAttribute(this.getSyncMode() === "graph-backed" ? this.graphSyncStatus : "local-only")}">
                ${escapeHtml(this.getGraphSyncStatusLabel())}
              </span>
              <div class="sync-actions">
                <button class="ghost-button" data-action="open-current-sync-page">Current sync file</button>
                <button class="ghost-button" data-action="open-sync-index-page">All sync files</button>
              </div>
            </div>
          </div>
          <div class="controls-grid">
            <input
              class="source-input"
              data-role="source-input"
              value="${escapeAttribute(this.sourceValue)}"
              placeholder="${escapeAttribute(sourcePlaceholder)}"
            />
            <div class="control-row">
              <button class="primary-button" data-action="create-snapshot" ${this.busy ? "disabled" : ""}>${createSnapshotLabel}</button>
              <button class="ghost-button" data-action="clear-snapshot">Remove Active</button>
            </div>
            <div class="message ${this.error ? "error" : ""}">
              ${escapeHtml(
                this.error ||
                  this.message ||
                  (this.sourceType === "page"
                    ? "Page mode saves or refreshes a page source on this whiteboard."
                    : "Keyword mode saves or refreshes a keyword source on this whiteboard."),
              )}
            </div>
            <div class="hint">
              ${escapeHtml(this.getGraphSyncHint())}
            </div>
          </div>
        </section>

        <section class="filters">
          <div class="reference-tabs" role="tablist" aria-label="Reference type">
            ${renderReferenceFilterButton("linked", "Linked", referenceCounts.linked, this.referenceFilter)}
            ${renderReferenceFilterButton("unlinked", "Unlinked", referenceCounts.unlinked, this.referenceFilter)}
          </div>
          <div class="filter-row">
            ${renderFilterButton("all", "All", counts.all, this.statusFilter)}
            ${renderFilterButton("unseen", "Unseen", counts.unseen, this.statusFilter)}
            ${renderFilterButton("seen", "Seen", counts.seen, this.statusFilter)}
            ${renderFilterButton("skipped", "Skipped", counts.skipped, this.statusFilter)}
          </div>
        </section>

        <section class="status-bar">
          <div class="status-row">
            <span class="message">${escapeHtml(surfaceHint)}</span>
          </div>
        </section>

        <section class="list-shell">
          <div class="list-scroll" data-role="list-scroll">
            ${
              visibleItems.length === 0
                ? this.renderEmptyState(snapshot)
                : visibleItems
                    .map(
                      (item) => `
                        <article class="item-card" data-item-drag="${escapeAttribute(item.id)}" data-status="${escapeAttribute(item.status)}" draggable="true">
                          <div class="item-head">
                            <div class="drag-pill"></div>
                            <div class="item-main">
                              <h2 class="item-title">${escapeHtml(item.label)}</h2>
                              <div class="item-meta">
                                <span><span class="status-dot ${escapeAttribute(item.status)}"></span> ${escapeHtml(item.status)}</span>
                                <span class="reference-chip ${escapeAttribute(item.referenceState)}">${escapeHtml(item.referenceState)}</span>
                                <span>${escapeHtml(item.type)}</span>
                                ${item.type === "block" && item.pageTitle ? `<span>${escapeHtml(item.pageTitle)}</span>` : ""}
                                <span>${escapeHtml(item.pageName ?? item.blockUuid ?? "")}</span>
                              </div>
                            </div>
                          </div>
                          <div class="item-actions">
                            <button class="ghost-button" data-item-open="${escapeAttribute(item.id)}">${item.type === "block" ? "Locate" : "Open"}</button>
                            <button class="status-button ${item.status === "seen" ? "active" : ""}" data-item-id="${escapeAttribute(item.id)}" data-item-status="seen">Seen</button>
                            <button class="status-button ${item.status === "unseen" ? "active" : ""}" data-item-id="${escapeAttribute(item.id)}" data-item-status="unseen">Unseen</button>
                            <button class="status-button ${item.status === "skipped" ? "active" : ""}" data-item-id="${escapeAttribute(item.id)}" data-item-status="skipped">Skip</button>
                          </div>
                        </article>
                      `,
                    )
                    .join("")
            }
          </div>
        </section>
        ${this.renderDiagnostics(snapshot)}
      </div>
    `;

    this.bindEvents();
    this.restoreScrollPosition();
  }
}

function escapeHtml(value: unknown): string {
  const safeValue = typeof value === "string" ? value : value == null ? "" : String(value);
  return safeValue
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: unknown): string {
  return escapeHtml(value);
}

function renderFilterButton(filter: StatusFilter, label: string, count: number, activeFilter: StatusFilter): string {
  return `
    <button class="chip-button ${filter === activeFilter ? "active" : ""}" data-filter="${filter}">
      ${escapeHtml(label)} <span class="count">${count}</span>
    </button>
  `;
}

function renderReferenceFilterButton(
  filter: ReferenceFilter,
  label: string,
  count: number,
  activeFilter: ReferenceFilter,
): string {
  return `
    <button
      class="chip-button tab-button ${filter === activeFilter ? "active" : ""}"
      data-reference-filter="${filter}"
      role="tab"
      aria-selected="${filter === activeFilter ? "true" : "false"}"
    >
      ${escapeHtml(label)} <span class="count">${count}</span>
    </button>
  `;
}

function renderToolbarDockIconTemplate(): string {
  return `
    <a class="button" data-on-click="toggleDock" title="Toggle Whiteboard RefDock" aria-label="Toggle Whiteboard RefDock">
      <span
        style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1.78rem;
          height: 1.78rem;
          opacity: 0.98;
        "
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <rect
            x="2.25"
            y="2.25"
            width="11.5"
            height="11.5"
            rx="2"
            stroke="currentColor"
            stroke-width="1.35"
            stroke-linejoin="round"
          />
          <rect
            x="10.05"
            y="3.35"
            width="2.55"
            height="9.3"
            rx="1.1"
            fill="currentColor"
            opacity="0.34"
          />
          <path
            d="M10 3.2V12.8"
            stroke="currentColor"
            stroke-width="1.55"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M4.85 5.2L8.25 8L4.85 10.8"
            stroke="currentColor"
            stroke-width="1.8"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M4.2 8H7.9"
            stroke="currentColor"
            stroke-width="1.2"
            stroke-linecap="round"
            opacity="0.92"
          />
        </svg>
      </span>
    </a>
  `;
}

async function main(): Promise<void> {
  const root = document.getElementById(APP_ROOT_ID);
  if (!root) {
    throw new Error("App root was not found.");
  }

  const settingsCapableLogseq = logseq as typeof logseq & {
    useSettingsSchema?: (schema: typeof SETTINGS_SCHEMA) => void;
    updateSettings?: (attrs: Record<string, unknown>) => void;
    onSettingsChanged?: (handler: (newSettings: Record<string, unknown>, oldSettings: Record<string, unknown>) => void) => void;
  };

  try {
    settingsCapableLogseq.useSettingsSchema?.(SETTINGS_SCHEMA);
  } catch (error) {
    console.warn("whiteboard-refdock settings schema registration failed", error);
  }

  const app = new WhiteboardRefDockApp(root);

  logseq.provideModel({
    toggleDock() {
      void app.toggleDock();
    },
    revealDock() {
      void app.revealDock();
    },
    refreshDock() {
      void app.refreshDock();
    },
  });

  logseq.App.registerUIItem("toolbar", {
    key: TOOLBAR_KEY,
    template: renderToolbarDockIconTemplate(),
  });

  logseq.App.registerCommandPalette(
    {
      key: "whiteboard-refdock-toggle",
      label: "Whiteboard RefDock: Toggle dock",
    },
    () => {
      void app.toggleDock();
    },
  );

  logseq.App.registerCommandPalette(
    {
      key: "whiteboard-refdock-refresh",
      label: "Whiteboard RefDock: Refresh dock",
    },
    () => {
      void app.refreshDock();
    },
  );

  logseq.App.onRouteChanged(() => {
    void app.refreshContext();
  });

  logseq.App.onCurrentGraphChanged(() => {
    void (async () => {
      await app.refreshGraphState();
      app.ensureSyncModeSettingInitialized();
      app.applySyncModeFromSettings();
      await app.refreshContext();
    })();
  });

  logseq.App.onThemeModeChanged(({ mode }) => {
    app.setThemeMode(mode);
  });

  settingsCapableLogseq.onSettingsChanged?.(() => {
    void app.handleSettingsChanged();
  });

  await app.init();
}

void logseq.ready(main).catch((error) => {
  console.error("logseq-whiteboard-refdock failed to load", error);
});
