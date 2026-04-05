import "@logseq/libs";

import { createSnapshotFromKeyword, createSnapshotFromPage, getCurrentWhiteboard } from "./query";
import { getSyncIndexPageName, getWhiteboardSyncPageName, readWhiteboardSyncState, writeWhiteboardSyncState } from "./sync";
import {
  DEFAULT_DOCK_WIDTH,
  buildReviewKey,
  getGraphStorageKey,
  isSourceTombstoneEffective,
  loadGraphState,
  mergeReviewStateRecords,
  normalizeSourceValue,
  reconcileSourceTombstonesInGraphState,
  saveGraphState,
} from "./storage";
import type {
  GraphState,
  ItemStatus,
  ReferenceState,
  ReviewStateRecord,
  SavedSourceMeta,
  Snapshot,
  SnapshotItem,
  SnapshotItemType,
  SnapshotSourceType,
  StatusFilter,
  SourceTombstone,
  SyncMode,
  ThemeMode,
  ThemePreference,
  WhiteboardInfo,
} from "./types";
import type { SyncSourceSummary } from "./sync";

const APP_ROOT_ID = "whiteboard-refdock-app";
const HOST_CONTAINER_ID = "whiteboard-refdock-host";
const TOOLBAR_KEY = "whiteboard-refdock-toolbar";
const MIN_WIDTH = 320;
const DEFAULT_MAX_WIDTH = 560;
const IS_MAC_PLATFORM =
  typeof navigator !== "undefined" && /(Mac|iPhone|iPad|iPod)/i.test(navigator.platform || navigator.userAgent);
const DEFAULT_TOGGLE_SHORTCUT_BINDING = "mod+alt+r";
const DEFAULT_TOGGLE_SHORTCUT_LABEL = IS_MAC_PLATFORM ? "Cmd+Option+R" : "Ctrl+Alt+R";
type SurfaceMode = "iframe" | "host";
type ReferenceFilter = "all" | ReferenceState;
type SnapshotTypeFilter = "all" | SnapshotItemType;
type GraphSyncStatus = "local-only" | "pending" | "syncing" | "synced" | "error";

interface LocatePreviewState {
  whiteboard: WhiteboardInfo;
  targetPageName: string;
  targetBlockUuid: string | null;
  allowedBlockUuids: string[];
  targetLabel: string;
  startedAt: number;
}

interface PreservedInputState {
  role: string;
  value: string;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionDirection: "forward" | "backward" | "none" | null;
}

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
  {
    key: "toggleDockShortcut",
    type: "string",
    default: DEFAULT_TOGGLE_SHORTCUT_LABEL,
    title: "Toggle RefDock shortcut",
    description: `Default: ${DEFAULT_TOGGLE_SHORTCUT_LABEL}. Reload the plugin after changing this shortcut.`,
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

function openInRightSidebar(id: string | number): void {
  logseq.Editor.openInRightSidebar(id);
}

function getEntityId(entity: unknown): number | null {
  if (!entity || typeof entity !== "object") {
    return null;
  }

  const record = entity as Record<string, unknown>;
  const directId = record.id;
  if (typeof directId === "number" && Number.isFinite(directId)) {
    return directId;
  }

  const dbId = record["db/id"];
  if (typeof dbId === "number" && Number.isFinite(dbId)) {
    return dbId;
  }

  return null;
}

function getEntityPageName(entity: unknown): string | null {
  if (!entity || typeof entity !== "object") {
    return null;
  }

  const record = entity as Record<string, unknown>;
  const candidates = [record.originalName, record.name, record.title, record["block/title"], record["block/name"]];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate;
    }
  }

  return null;
}

function logLocatePreview(event: string, details?: Record<string, unknown>): void {
  if (details) {
    console.info("[whiteboard-refdock][locate-preview]", event, details);
    return;
  }

  console.info("[whiteboard-refdock][locate-preview]", event);
}

function normalizeShortcutForLogseq(value: string): string {
  const parts = value
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return DEFAULT_TOGGLE_SHORTCUT_BINDING;
  }

  const normalized = parts.map((part) => {
    const token = part.toLocaleLowerCase();

    switch (token) {
      case "cmd":
      case "command":
      case "meta":
      case "super":
      case "⌘":
        return "mod";
      case "option":
      case "opt":
      case "⌥":
        return "alt";
      case "control":
        return "ctrl";
      default:
        return token;
    }
  });

  return normalized.join("+");
}

function getToggleDockShortcut(): string {
  const configured = logseq.settings?.toggleDockShortcut;
  if (typeof configured !== "string") {
    return DEFAULT_TOGGLE_SHORTCUT_BINDING;
  }

  const normalized = configured.trim();
  return normalized ? normalizeShortcutForLogseq(normalized) : DEFAULT_TOGGLE_SHORTCUT_BINDING;
}

async function getInitialThemeMode(): Promise<ThemeMode> {
  try {
    const userConfigs = await logseq.App.getUserConfigs();
    if (userConfigs.preferredThemeMode === "dark" || userConfigs.preferredThemeMode === "light") {
      return userConfigs.preferredThemeMode;
    }
  } catch (_error) {
    // Fall through to DOM/system detection.
  }

  const htmlTheme = document.documentElement.getAttribute("data-theme");
  if (htmlTheme === "dark" || htmlTheme === "light") {
    return htmlTheme;
  }

  if (document.documentElement.classList.contains("dark") || document.body.classList.contains("dark-theme")) {
    return "dark";
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
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
  private sourceInputComposing = false;
  private snapshotSearchValue = "";
  private snapshotTypeFilter: SnapshotTypeFilter = "all";
  private snapshotFilterScopeReviewKey: string | null = null;
  private snapshotFilterInputComposing = false;
  private referenceFilter: ReferenceFilter = "linked";
  private statusFilter: StatusFilter = "all";
  private message = "";
  private error = "";
  private busy = false;
  private surfaceMode: SurfaceMode = "iframe";
  private logseqThemeMode: ThemeMode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  private themeMode: ThemeMode = this.logseqThemeMode;
  private diagnosticsCollapsed = true;
  private savedSourcesCollapsed = false;
  private resizeCleanup: (() => void) | null = null;
  private syncWriteTimer: number | null = null;
  private syncWriteInFlight = false;
  private graphSyncStatus: GraphSyncStatus = "local-only";
  private lastGraphSyncAt: number | null = null;
  private graphSyncError = "";
  private contextRefreshToken = 0;
  private locatePreviewState: LocatePreviewState | null = null;
  private locatePreviewMonitor: number | null = null;
  private locatePreviewClickCleanup: (() => void) | null = null;

  constructor(root: HTMLElement) {
    this.iframeRoot = root;
    this.renderRoot = root;
  }

  async init(): Promise<void> {
    this.logseqThemeMode = await getInitialThemeMode();
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
    this.applyThemePreference();
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

      for (const [reviewKey, tombstone] of Object.entries(syncedState.sourceTombstonesByReviewKey)) {
        const localTombstone = this.graphState.sourceTombstonesByReviewKey[reviewKey];
        if (!localTombstone || tombstone.deletedAt >= localTombstone.deletedAt) {
          this.graphState.sourceTombstonesByReviewKey[reviewKey] = tombstone;
        }
      }

      for (const [reviewKey, syncedReviewState] of Object.entries(syncedState.reviewStateByReviewKey)) {
        const localReviewState = this.graphState.reviewStateByReviewKey[reviewKey];
        this.graphState.reviewStateByReviewKey[reviewKey] = mergeReviewStateRecords(localReviewState, syncedReviewState);
      }

      const localReviewKeys = this.graphState.savedSourcesByWhiteboard[this.currentWhiteboard.id] ?? [];
      const mergedReviewKeys = [
        ...syncedState.savedReviewKeys,
        ...localReviewKeys.filter((reviewKey) => !syncedState.savedReviewKeys.includes(reviewKey)),
      ].filter((reviewKey) => Boolean(this.graphState.sourceMetaByReviewKey[reviewKey]));

      if (mergedReviewKeys.length > 0) {
        this.graphState.savedSourcesByWhiteboard[this.currentWhiteboard.id] = mergedReviewKeys;
      }

      this.reconcileSourceTombstones();
    } catch (error) {
      console.warn("whiteboard-refdock graph sync hydrate failed", error);
    }
  }

  async refreshContext(): Promise<void> {
    const refreshToken = ++this.contextRefreshToken;
    const routeWhiteboardName = this.getRouteWhiteboardName();

    if (routeWhiteboardName && this.locatePreviewState) {
      this.clearLocatePreviewState("refreshContext:entered-whiteboard-route");
    }

    if (routeWhiteboardName && (!this.currentWhiteboard || !this.isSameWhiteboardName(this.currentWhiteboard.name, routeWhiteboardName))) {
      this.currentWhiteboard = null;
      await this.syncDockSurface();
      this.render();
    }

    if (!routeWhiteboardName && this.locatePreviewState) {
      const previewStillValid = await this.isLocatePreviewStillValid(this.locatePreviewState);
      if (refreshToken !== this.contextRefreshToken) {
        return;
      }

      if (previewStillValid) {
        this.currentWhiteboard = this.locatePreviewState.whiteboard;
        await this.applyResolvedWhiteboardContext(refreshToken);
        return;
      }

      this.clearLocatePreviewState("refreshContext:preview-invalid-after-route-change");
    }

    const nextWhiteboard = await this.resolveCurrentWhiteboard(routeWhiteboardName);
    if (refreshToken !== this.contextRefreshToken) {
      return;
    }

    this.currentWhiteboard = nextWhiteboard;
    await this.applyResolvedWhiteboardContext(refreshToken);
  }

  async toggleDock(): Promise<void> {
    this.graphState.dockVisible = !this.graphState.dockVisible;
    this.persist();
    await this.syncDockSurface();
    this.render();
  }

  private async applyResolvedWhiteboardContext(refreshToken: number): Promise<void> {
    await this.hydrateCurrentWhiteboardFromGraphSync();
    if (refreshToken !== this.contextRefreshToken) {
      return;
    }

    this.syncActiveReviewKey();
    this.syncSourceInputFromActiveSnapshot();
    this.setCurrentDockWidth(this.getCurrentDockWidth());
    this.selectDefaultReferenceFilter(this.getActiveSnapshot());
    this.persist();
    await this.syncDockSurface();
    if (refreshToken !== this.contextRefreshToken) {
      return;
    }

    this.render();
    await this.ensureActiveSnapshotLoaded();
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
    this.logseqThemeMode = mode;
    this.applyThemePreference();
    this.render();
  }

  private applyThemePreference(): void {
    const preference = this.graphState.themePreference ?? "auto";
    this.themeMode = preference === "auto" ? this.logseqThemeMode : preference;
  }

  private setThemePreference(preference: ThemePreference): void {
    if (this.graphState.themePreference === preference) {
      return;
    }

    this.graphState.themePreference = preference;
    this.applyThemePreference();
    this.persist();
    this.render();
  }

  private getThemePreference(): ThemePreference {
    return this.graphState.themePreference ?? "auto";
  }

  private persist(): void {
    if (this.storageKey) {
      saveGraphState(this.storageKey, this.graphState);
    }
  }

  private reconcileSourceTombstones(): void {
    reconcileSourceTombstonesInGraphState(this.graphState);
  }

  private clearSourceTombstone(reviewKey: string): void {
    delete this.graphState.sourceTombstonesByReviewKey[reviewKey];
  }

  private upsertSourceTombstone(
    reviewKey: string,
    source: Pick<SavedSourceMeta, "whiteboardId" | "sourceType" | "sourceValue" | "normalizedSourceValue">,
    deletedAt: number,
  ): SourceTombstone {
    const existingTombstone = this.graphState.sourceTombstonesByReviewKey[reviewKey];
    const nextTombstone: SourceTombstone = {
      reviewKey,
      whiteboardId: source.whiteboardId,
      sourceType: source.sourceType,
      sourceValue: source.sourceValue,
      normalizedSourceValue: source.normalizedSourceValue,
      deletedAt: existingTombstone ? Math.max(existingTombstone.deletedAt, deletedAt) : deletedAt,
    };

    this.graphState.sourceTombstonesByReviewKey[reviewKey] = nextTombstone;
    return nextTombstone;
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

  private buildSourceDescriptor(
    reviewKey: string,
    snapshot: Snapshot | null | undefined,
    sourceMeta: SavedSourceMeta | null | undefined,
  ): Pick<SavedSourceMeta, "whiteboardId" | "sourceType" | "sourceValue" | "normalizedSourceValue"> | null {
    if (sourceMeta) {
      return {
        whiteboardId: sourceMeta.whiteboardId,
        sourceType: sourceMeta.sourceType,
        sourceValue: sourceMeta.sourceValue,
        normalizedSourceValue: sourceMeta.normalizedSourceValue,
      };
    }

    if (!snapshot) {
      return null;
    }

    return {
      whiteboardId: snapshot.whiteboardId,
      sourceType: snapshot.sourceType,
      sourceValue: snapshot.sourceValue,
      normalizedSourceValue: normalizeSourceValue(snapshot.sourceValue),
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
      const sourceTombstonesByReviewKey = Object.fromEntries(
        Object.entries(this.graphState.sourceTombstonesByReviewKey).filter(
          ([reviewKey, tombstone]) =>
            tombstone.whiteboardId === this.currentWhiteboard?.id &&
            isSourceTombstoneEffective(tombstone, this.graphState.sourceMetaByReviewKey[reviewKey]),
        ),
      );

      await writeWhiteboardSyncState(
        this.currentWhiteboard,
        sourceMetas,
        reviewStateByReviewKey,
        summariesByReviewKey,
        sourceTombstonesByReviewKey,
      );
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
    return keys.filter((reviewKey) => {
      const sourceMeta = this.graphState.sourceMetaByReviewKey[reviewKey];
      return Boolean(sourceMeta) && !isSourceTombstoneEffective(this.graphState.sourceTombstonesByReviewKey[reviewKey], sourceMeta);
    });
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
        this.sourceType = "page";
        this.sourceValue = "";
        return;
      }

      const meta = this.graphState.sourceMetaByReviewKey[activeReviewKey];
      if (!meta) {
        this.sourceType = "page";
        this.sourceValue = "";
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
    this.clearSourceTombstone(reviewKey);
    this.upsertSourceMeta(this.buildSourceMetaFromSnapshot(snapshot));
    const reviewKeys = this.getSavedReviewKeysForWhiteboard(snapshot.whiteboardId).filter((entry) => entry !== reviewKey);
    this.graphState.savedSourcesByWhiteboard[snapshot.whiteboardId] = [reviewKey, ...reviewKeys];
    this.graphState.activeReviewKeyByWhiteboard[snapshot.whiteboardId] = reviewKey;
    this.reconcileSourceTombstones();
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

    reviewState.items[itemId] = {
      itemId,
      status,
      updatedAt: timestamp,
    };

    reviewState.updatedAt = timestamp;

    const sourceMeta = this.graphState.sourceMetaByReviewKey[reviewState.reviewKey];
    if (sourceMeta) {
      sourceMeta.updatedAt = timestamp;
    }

    this.scheduleCurrentWhiteboardSync();
  }

  private getVisibleItems(): SnapshotItem[] {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return [];
    }

    return snapshot.items.filter((item) => {
      return this.matchesVisibleItemFilters(item);
    });
  }

  private getCounts(snapshot: Snapshot | null): Record<StatusFilter, number> {
    const counts: Record<StatusFilter, number> = {
      all: 0,
      unseen: 0,
      seen: 0,
      pending: 0,
      skipped: 0,
    };

    if (!snapshot) {
      return counts;
    }

    for (const item of snapshot.items) {
      if (!this.matchesReferenceAndTemporaryFilters(item)) {
        continue;
      }

      counts.all += 1;
      counts[item.status] += 1;
    }

    return counts;
  }

  private getReferenceCounts(snapshot: Snapshot | null): Record<ReferenceFilter, number> {
    const counts: Record<ReferenceFilter, number> = {
      all: 0,
      linked: 0,
      unlinked: 0,
    };

    if (!snapshot) {
      return counts;
    }

    for (const item of snapshot.items) {
      if (!this.matchesTemporarySnapshotFilter(item)) {
        continue;
      }

      counts.all += 1;
      counts[item.referenceState] += 1;
    }

    return counts;
  }

  private getSnapshotTypeCounts(snapshot: Snapshot | null): Record<SnapshotTypeFilter, number> {
    const counts: Record<SnapshotTypeFilter, number> = {
      all: 0,
      block: 0,
      page: 0,
    };

    if (!snapshot) {
      return counts;
    }

    for (const item of snapshot.items) {
      if (!this.matchesReferenceAndStatusAndSearchFilters(item)) {
        continue;
      }

      counts.all += 1;
      counts[item.type] += 1;
    }

    return counts;
  }

  private syncSnapshotViewFilterScope(activeReviewKey: string | null): void {
    if (this.snapshotFilterScopeReviewKey === activeReviewKey) {
      return;
    }

    this.snapshotFilterScopeReviewKey = activeReviewKey;
    this.snapshotSearchValue = "";
    this.snapshotTypeFilter = "all";
    this.snapshotFilterInputComposing = false;
  }

  private clearSnapshotViewFilters(): void {
    this.snapshotSearchValue = "";
    this.snapshotTypeFilter = "all";
    this.snapshotFilterInputComposing = false;
  }

  private matchesVisibleItemFilters(item: SnapshotItem): boolean {
    if (!this.matchesReferenceAndTemporaryFilters(item)) {
      return false;
    }

    if (this.statusFilter === "all") {
      return true;
    }

    return item.status === this.statusFilter;
  }

  private matchesReferenceAndTemporaryFilters(item: SnapshotItem): boolean {
    if (this.referenceFilter !== "all" && item.referenceState !== this.referenceFilter) {
      return false;
    }

    return this.matchesTemporarySnapshotFilter(item);
  }

  private matchesReferenceAndStatusAndSearchFilters(item: SnapshotItem): boolean {
    if (this.referenceFilter !== "all" && item.referenceState !== this.referenceFilter) {
      return false;
    }

    if (this.statusFilter !== "all" && item.status !== this.statusFilter) {
      return false;
    }

    return this.matchesTemporarySnapshotFilter(item, { ignoreType: true });
  }

  private matchesTemporarySnapshotFilter(
    item: SnapshotItem,
    options?: { ignoreType?: boolean },
  ): boolean {
    if (!options?.ignoreType && this.snapshotTypeFilter !== "all" && item.type !== this.snapshotTypeFilter) {
      return false;
    }

    const keyword = this.snapshotSearchValue.trim().toLocaleLowerCase();
    if (!keyword) {
      return true;
    }

    const haystacks = [item.label, item.matchedTitle, item.pageTitle, item.pageName]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .map((value) => value.toLocaleLowerCase());

    return haystacks.some((value) => value.includes(keyword));
  }

  private buildSyncSourceSummary(
    snapshot: Snapshot | null,
    reviewState?: ReviewStateRecord,
  ): SyncSourceSummary {
    if (!snapshot) {
      const reviewItems = Object.values(reviewState?.items ?? {});
      return {
        unseenCount: reviewItems.filter((item) => item.status === "unseen").length,
        seenCount: reviewItems.filter((item) => item.status === "seen").length,
        pendingCount: reviewItems.filter((item) => item.status === "pending").length,
        skippedCount: reviewItems.filter((item) => item.status === "skipped").length,
      };
    }

    const summary: SyncSourceSummary = {
      totalItems: snapshot.items.length,
      linkedCount: 0,
      unlinkedCount: 0,
      unseenCount: 0,
      seenCount: 0,
      pendingCount: 0,
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
      } else if (item.status === "pending") {
        summary.pendingCount += 1;
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

  private getDecodedRouteName(prefix: string): string | null {
    const path = this.getCurrentRoutePath();
    if (!path || !path.startsWith(prefix)) {
      return null;
    }

    const encodedName = path.slice(prefix.length).split("?")[0];
    if (!encodedName) {
      return null;
    }

    try {
      return decodeURIComponent(encodedName);
    } catch (_error) {
      return encodedName;
    }
  }

  private getRouteWhiteboardName(): string | null {
    return this.getDecodedRouteName("/whiteboard/");
  }

  private getRoutePageName(): string | null {
    return this.getDecodedRouteName("/page/");
  }

  private isSameWhiteboardName(left: string | null | undefined, right: string | null | undefined): boolean {
    if (!left || !right) {
      return false;
    }

    return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
  }

  private async resolveCurrentWhiteboard(expectedRouteWhiteboardName: string | null): Promise<WhiteboardInfo | null> {
    const maxAttempts = expectedRouteWhiteboardName ? 4 : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const whiteboard = await getCurrentWhiteboard();
      if (!expectedRouteWhiteboardName) {
        return whiteboard;
      }

      if (whiteboard && this.isSameWhiteboardName(whiteboard.name, expectedRouteWhiteboardName)) {
        return whiteboard;
      }

      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 80 * (attempt + 1)));
      }
    }

    return null;
  }

  private clearLocatePreviewState(reason?: string): void {
    if (this.locatePreviewState) {
      logLocatePreview("clear", {
        reason: reason ?? "unspecified",
        whiteboard: this.locatePreviewState.whiteboard.name,
        targetPageName: this.locatePreviewState.targetPageName,
        targetBlockUuid: this.locatePreviewState.targetBlockUuid,
      });
    }

    this.locatePreviewState = null;
    if (this.locatePreviewMonitor !== null) {
      window.clearInterval(this.locatePreviewMonitor);
      this.locatePreviewMonitor = null;
    }

    if (this.locatePreviewClickCleanup) {
      this.locatePreviewClickCleanup();
      this.locatePreviewClickCleanup = null;
    }
  }

  private ensureLocatePreviewMonitor(): void {
    if (this.locatePreviewMonitor !== null) {
      return;
    }

    this.locatePreviewMonitor = window.setInterval(() => {
      void this.monitorLocatePreview();
    }, 700);
  }

  private ensureLocatePreviewClickListener(): void {
    if (this.locatePreviewClickCleanup) {
      return;
    }

    const hostDocument = this.getHostDocument();
    if (!hostDocument) {
      return;
    }

    const handler = (event: Event) => {
      void this.handleLocatePreviewDocumentClick(event);
    };

    hostDocument.addEventListener("click", handler, true);
    this.locatePreviewClickCleanup = () => {
      hostDocument.removeEventListener("click", handler, true);
    };
  }

  private async monitorLocatePreview(): Promise<void> {
    const previewState = this.locatePreviewState;
    if (!previewState) {
      this.clearLocatePreviewState("monitor:missing-preview-state");
      return;
    }

    if (this.getRouteWhiteboardName()) {
      logLocatePreview("monitor:whiteboard-route");
      this.clearLocatePreviewState("monitor:entered-whiteboard-route");
      return;
    }

    const stillValid = await this.isLocatePreviewStillValid(previewState);
    if (previewState !== this.locatePreviewState) {
      return;
    }

    if (!stillValid) {
      logLocatePreview("monitor:invalid-page-context");
      this.clearLocatePreviewState("monitor:invalid-page-context");
      await this.refreshContext();
    }
  }

  private async getCurrentPreviewPageName(): Promise<string | null> {
    const routePageName = this.getRoutePageName();
    if (routePageName) {
      return routePageName;
    }

    try {
      const currentPage = await logseq.Editor.getCurrentPage();
      return getEntityPageName(currentPage);
    } catch (_error) {
      return null;
    }
  }

  private async handleLocatePreviewDocumentClick(event: Event): Promise<void> {
    const previewState = this.locatePreviewState;
    if (!previewState || this.getRouteWhiteboardName()) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }

    if (target.closest(`#${HOST_CONTAINER_ID}`) || target.closest(`#${APP_ROOT_ID}`)) {
      return;
    }

    if (!previewState.targetBlockUuid) {
      return;
    }

    const blockElement = target.closest(".ls-block[blockid]") as HTMLElement | null;
    if (!blockElement) {
      return;
    }

    const clickedBlockUuid = blockElement.getAttribute("blockid");
    if (!clickedBlockUuid) {
      return;
    }

    logLocatePreview("click", {
      clickedBlockUuid,
      targetBlockUuid: previewState.targetBlockUuid,
      allowedBlockUuids: previewState.allowedBlockUuids,
    });

    if (Date.now() - previewState.startedAt < 1200) {
      logLocatePreview("click:ignored-during-warmup", { clickedBlockUuid });
      return;
    }

    window.setTimeout(() => {
      void this.reconcileLocatePreviewAfterBlockClick(previewState, clickedBlockUuid);
    }, 120);
  }

  private getBlockDomElementByUuid(blockUuid: string): HTMLElement | null {
    const hostDocument = this.getHostDocument();
    if (!hostDocument) {
      return null;
    }

    const root = hostDocument.querySelector("#main-content-container") ?? hostDocument.body;
    const selector = `.ls-block[blockid="${blockUuid.replaceAll('"', '\\"')}"]`;

    try {
      const escapedSelector = `.ls-block[blockid="${CSS.escape(blockUuid)}"]`;
      const matches = Array.from(root.querySelectorAll<HTMLElement>(escapedSelector));
      return matches.find((element) => element.getClientRects().length > 0) ?? matches[0] ?? null;
    } catch (_error) {
      const matches = Array.from(root.querySelectorAll<HTMLElement>(selector));
      return matches.find((element) => element.getClientRects().length > 0) ?? matches[0] ?? null;
    }
  }

  private async reconcileLocatePreviewAfterBlockClick(previewState: LocatePreviewState, clickedBlockUuid: string): Promise<void> {
    if (this.locatePreviewState !== previewState) {
      return;
    }

    if (previewState.allowedBlockUuids.includes(clickedBlockUuid)) {
      logLocatePreview("reconcile:clicked-allowed", { clickedBlockUuid });
      return;
    }

    const targetBlockElement = previewState.targetBlockUuid ? this.getBlockDomElementByUuid(previewState.targetBlockUuid) : null;
    const clickedBlockElement = this.getBlockDomElementByUuid(clickedBlockUuid);
    logLocatePreview("reconcile:dom-lookup", {
      clickedBlockUuid,
      targetBlockUuid: previewState.targetBlockUuid,
      targetFound: Boolean(targetBlockElement),
      clickedFound: Boolean(clickedBlockElement),
      domEqual: Boolean(targetBlockElement && clickedBlockElement && clickedBlockElement === targetBlockElement),
      clickedContainsTarget: Boolean(targetBlockElement && clickedBlockElement && clickedBlockElement.contains(targetBlockElement)),
      targetContainsClicked: Boolean(targetBlockElement && clickedBlockElement && targetBlockElement.contains(clickedBlockElement)),
    });
    if (targetBlockElement && clickedBlockElement) {
      if (clickedBlockElement === targetBlockElement || clickedBlockElement.contains(targetBlockElement)) {
        logLocatePreview("reconcile:keep-dom-ancestor-or-self", { clickedBlockUuid });
        return;
      }

      if (targetBlockElement.contains(clickedBlockElement)) {
        logLocatePreview("reconcile:collapse-dom-child", { clickedBlockUuid });
        this.clearLocatePreviewState("reconcile:clicked-child-block");
        await this.refreshContext();
        return;
      }
    }

    try {
      const currentBlock = await logseq.Editor.getCurrentBlock();
      if (this.locatePreviewState !== previewState) {
        return;
      }

      if (currentBlock?.uuid && previewState.allowedBlockUuids.includes(currentBlock.uuid)) {
        logLocatePreview("reconcile:keep-current-block-allowed", {
          clickedBlockUuid,
          currentBlockUuid: currentBlock.uuid,
        });
        return;
      }
      logLocatePreview("reconcile:current-block-not-allowed", {
        clickedBlockUuid,
        currentBlockUuid: currentBlock?.uuid ?? null,
      });
    } catch (_error) {
      // Fall through to clicked DOM block UUID and DOM relation heuristics.
      logLocatePreview("reconcile:current-block-read-failed", { clickedBlockUuid });
    }

    logLocatePreview("reconcile:collapse-fallback", { clickedBlockUuid });
    this.clearLocatePreviewState("reconcile:collapse-fallback");
    await this.refreshContext();
  }

  private async collectAllowedLocateBlockUuids(blockUuid: string): Promise<string[]> {
    const allowed = [blockUuid];
    const visited = new Set<string>(allowed);
    let currentBlock = await logseq.Editor.getBlock(blockUuid);

    for (let depth = 0; depth < 64 && currentBlock?.parent?.id; depth += 1) {
      const parentBlock = await logseq.Editor.getBlock(currentBlock.parent.id);
      if (!parentBlock?.uuid || visited.has(parentBlock.uuid)) {
        break;
      }

      visited.add(parentBlock.uuid);
      allowed.push(parentBlock.uuid);
      currentBlock = parentBlock;
    }

    return allowed;
  }

  private createLocatePreviewState(item: SnapshotItem): LocatePreviewState | null {
    if (!this.currentWhiteboard || !item.pageName) {
      return null;
    }

    return {
      whiteboard: this.currentWhiteboard,
      targetPageName: item.pageName,
      targetBlockUuid: item.type === "block" && item.blockUuid ? item.blockUuid : null,
      allowedBlockUuids: item.type === "block" && item.blockUuid ? [item.blockUuid] : [],
      targetLabel: item.type === "block" ? item.label : item.pageName,
      startedAt: Date.now(),
    };
  }

  private startLocatePreview(item: SnapshotItem): void {
    const previewState = this.createLocatePreviewState(item);
    if (!previewState) {
      this.clearLocatePreviewState("start:missing-whiteboard-or-page");
      return;
    }

    this.locatePreviewState = previewState;
    this.ensureLocatePreviewMonitor();
    this.ensureLocatePreviewClickListener();
    logLocatePreview("start", {
      whiteboard: previewState.whiteboard.name,
      targetPageName: previewState.targetPageName,
      targetBlockUuid: previewState.targetBlockUuid,
      targetLabel: previewState.targetLabel,
    });
    this.render();

    if (previewState.targetBlockUuid) {
      const targetBlockUuid = previewState.targetBlockUuid;
      void (async () => {
        try {
          const allowedBlockUuids = await this.collectAllowedLocateBlockUuids(targetBlockUuid);
          if (this.locatePreviewState === previewState) {
            this.locatePreviewState = {
              ...previewState,
              allowedBlockUuids,
            };
            logLocatePreview("start:resolved-ancestors", {
              targetBlockUuid,
              allowedBlockUuids,
            });
          }
        } catch (_error) {
          // Keep the initial block-only preview state if ancestor inspection fails.
          logLocatePreview("start:resolve-ancestors-failed", { targetBlockUuid });
        }
      })();
    }
  }

  private isLocatePreviewWarmupActive(previewState: LocatePreviewState, durationMs = 1800): boolean {
    return Date.now() - previewState.startedAt < durationMs;
  }

  private isLocatePreviewContextMatch(previewState: LocatePreviewState, currentName: string | null | undefined): boolean {
    if (!currentName) {
      return false;
    }

    if (this.isSameWhiteboardName(currentName, previewState.targetPageName)) {
      return true;
    }

    return previewState.allowedBlockUuids.includes(currentName);
  }

  private async isLocatePreviewStillValid(previewState: LocatePreviewState): Promise<boolean> {
    const attempts = this.isLocatePreviewWarmupActive(previewState) ? 6 : 1;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const routePath = this.getCurrentRoutePath();
      const routeWhiteboardName = this.getRouteWhiteboardName();
      if (routeWhiteboardName) {
        logLocatePreview("validate:whiteboard-route", {
          attempt,
          routePath,
          routeWhiteboardName,
          targetPageName: previewState.targetPageName,
        });
        return false;
      }

      const routePageName = this.getRoutePageName();
      if (routePageName) {
        const valid = this.isLocatePreviewContextMatch(previewState, routePageName);
        logLocatePreview("validate:route-page", {
          attempt,
          routePath,
          routePageName,
          targetPageName: previewState.targetPageName,
          valid,
        });
        return valid;
      }

      const currentPageName = await this.getCurrentPreviewPageName();
      if (currentPageName) {
        const valid = this.isLocatePreviewContextMatch(previewState, currentPageName);
        logLocatePreview("validate:current-page", {
          attempt,
          routePath,
          currentPageName,
          targetPageName: previewState.targetPageName,
          valid,
        });
        return valid;
      }

      if (!this.isLocatePreviewWarmupActive(previewState) || attempt >= attempts - 1) {
        logLocatePreview("validate:no-page-context", {
          attempt,
          routePath,
          targetPageName: previewState.targetPageName,
          warmupActive: this.isLocatePreviewWarmupActive(previewState),
        });
        return false;
      }

      logLocatePreview("validate:retry", {
        attempt,
        routePath,
        targetPageName: previewState.targetPageName,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 120));
    }

    return false;
  }

  private navigateToWhiteboard(name: string): void {
    const targetHash = `#/whiteboard/${encodeURIComponent(name)}`;

    try {
      const location = window.top?.location ?? window.location;
      if (location.hash === targetHash) {
        return;
      }

      location.hash = targetHash;
    } catch (_error) {
      window.location.hash = targetHash;
    }
  }

  private returnToLocateWhiteboard(): void {
    const previewState = this.locatePreviewState;
    if (!previewState) {
      return;
    }

    this.clearLocatePreviewState("return-to-whiteboard");
    this.navigateToWhiteboard(previewState.whiteboard.name);
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

  private preserveSnapshotItemOrder(previousSnapshot: Snapshot | null, nextSnapshot: Snapshot): Snapshot {
    if (!previousSnapshot?.items.length || !nextSnapshot.items.length) {
      return nextSnapshot;
    }

    const previousOrderById = new Map(previousSnapshot.items.map((item, index) => [item.id, index] as const));
    const existingItems: Array<{ previousOrder: number; item: SnapshotItem }> = [];
    const newItems: SnapshotItem[] = [];

    for (const item of nextSnapshot.items) {
      const previousOrder = previousOrderById.get(item.id);
      if (typeof previousOrder === "number") {
        existingItems.push({ previousOrder, item });
      } else {
        newItems.push(item);
      }
    }

    existingItems.sort((left, right) => left.previousOrder - right.previousOrder);

    return {
      ...nextSnapshot,
      items: [...existingItems.map((entry) => entry.item), ...newItems].map((item, index) => ({
        ...item,
        order: index,
      })),
    };
  }

  private clearSnapshot(): void {
    if (!this.currentWhiteboard) {
      return;
    }

    const activeReviewKey = this.getActiveReviewKey();
    if (!activeReviewKey) {
      return;
    }

    const snapshot = this.graphState.snapshotsByReviewKey[activeReviewKey];
    const sourceMeta = this.graphState.sourceMetaByReviewKey[activeReviewKey];
    const sourceDescriptor = this.buildSourceDescriptor(activeReviewKey, snapshot, sourceMeta);
    const deletedAt = Date.now();
    if (sourceDescriptor) {
      this.upsertSourceTombstone(activeReviewKey, sourceDescriptor, deletedAt);
    }

    delete this.graphState.snapshotsByReviewKey[activeReviewKey];
    delete this.graphState.scrollByReviewKey[activeReviewKey];
    delete this.graphState.reviewStateByReviewKey[activeReviewKey];
    this.removeSavedSource(this.currentWhiteboard.id, activeReviewKey);
    this.reconcileSourceTombstones();

    this.syncSourceInputFromActiveSnapshot();
    this.selectDefaultReferenceFilter(this.getActiveSnapshot());
    this.persist();
    this.scheduleCurrentWhiteboardSync();
    this.message = "Active source removed.";
    this.error = "";
    this.render();
  }

  private async refreshSavedSource(reviewKey: string): Promise<void> {
    const existingSnapshot = this.graphState.snapshotsByReviewKey[reviewKey];
    const sourceMeta = this.graphState.sourceMetaByReviewKey[reviewKey];
    const sourceType = existingSnapshot?.sourceType ?? sourceMeta?.sourceType;
    const sourceValue = existingSnapshot?.sourceValue ?? sourceMeta?.sourceValue;
    const whiteboardId = existingSnapshot?.whiteboardId ?? sourceMeta?.whiteboardId;
    const whiteboardName = existingSnapshot?.whiteboardName ?? sourceMeta?.whiteboardName;
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
      const orderedSnapshot = this.preserveSnapshotItemOrder(existingSnapshot ?? null, refreshedSnapshot);
      const mergedSnapshot = this.storeSnapshot(orderedSnapshot, { resetScroll: false });
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

    const sourceDescriptor = this.buildSourceDescriptor(reviewKey, snapshot, sourceMeta);
    const deletedAt = Date.now();
    if (sourceDescriptor) {
      this.upsertSourceTombstone(reviewKey, sourceDescriptor, deletedAt);
    }

    delete this.graphState.snapshotsByReviewKey[reviewKey];
    delete this.graphState.scrollByReviewKey[reviewKey];
    delete this.graphState.reviewStateByReviewKey[reviewKey];
    this.removeSavedSource(whiteboardId, reviewKey);
    this.reconcileSourceTombstones();

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

  private async openItem(itemId: string, options?: { inSidebar?: boolean }): Promise<void> {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return;
    }

    const item = snapshot?.items.find((entry) => entry.id === itemId);
    if (!item?.pageName) {
      return;
    }

    if (options?.inSidebar) {
      this.clearLocatePreviewState("open-item:sidebar");
      if (this.graphState.dockVisible) {
        this.graphState.dockVisible = false;
        this.persist();
        await this.syncDockSurface();
      }

      let sidebarTarget: string | number | null = null;
      if (item.type === "block" && item.blockUuid) {
        sidebarTarget = item.blockUuid;
      } else if (item.pageName) {
        const page = await logseq.Editor.getPage(item.pageName);
        sidebarTarget = getEntityId(page);
      }

      if (!sidebarTarget) {
        this.setError("Failed to open the item in the right sidebar.");
        return;
      }

      openInRightSidebar(sidebarTarget);
      return;
    }

    this.startLocatePreview(item);

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

    root.querySelector<HTMLElement>("[data-action='toggle-saved-sources']")?.addEventListener("click", () => {
      this.savedSourcesCollapsed = !this.savedSourcesCollapsed;
      this.render();
    });

    root.querySelector<HTMLElement>("[data-action='toggle-dock']")?.addEventListener("click", () => {
      void this.toggleDock();
    });

    root.querySelector<HTMLElement>("[data-action='refresh-dock']")?.addEventListener("click", () => {
      void this.refreshDock();
    });

    root.querySelector<HTMLElement>("[data-action='back-to-whiteboard']")?.addEventListener("click", () => {
      this.returnToLocateWhiteboard();
    });

    root.querySelectorAll<HTMLElement>("[data-theme-preference]").forEach((button) => {
      button.addEventListener("click", () => {
        const preference = button.dataset.themePreference as ThemePreference | undefined;
        if (preference === "auto" || preference === "dark" || preference === "light") {
          this.setThemePreference(preference);
        }
      });
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

    root.querySelectorAll<HTMLElement>("[data-snapshot-type-filter]").forEach((button) => {
      button.addEventListener("click", () => {
        const nextFilter = button.dataset.snapshotTypeFilter as SnapshotTypeFilter | undefined;
        if (!nextFilter || nextFilter === this.snapshotTypeFilter) {
          return;
        }

        this.snapshotTypeFilter = nextFilter;
        this.render();
      });
    });

    root.querySelector<HTMLElement>("[data-action='clear-snapshot-view-filters']")?.addEventListener("click", () => {
      if (!this.snapshotSearchValue && this.snapshotTypeFilter === "all") {
        return;
      }

      this.clearSnapshotViewFilters();
      this.render();
    });

    root.querySelector<HTMLInputElement>("[data-role='source-input']")?.addEventListener("compositionstart", () => {
      this.sourceInputComposing = true;
    });

    root.querySelector<HTMLInputElement>("[data-role='source-input']")?.addEventListener("compositionend", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      this.sourceInputComposing = false;
      this.sourceValue = target.value;
      this.error = "";
      this.message = "";
      this.render();
    });

    root.querySelector<HTMLInputElement>("[data-role='snapshot-filter-input']")?.addEventListener("compositionstart", () => {
      this.snapshotFilterInputComposing = true;
    });

    root.querySelector<HTMLInputElement>("[data-role='snapshot-filter-input']")?.addEventListener("compositionend", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      this.snapshotFilterInputComposing = false;
      this.snapshotSearchValue = target.value;
      this.render();
    });

    root.querySelector<HTMLInputElement>("[data-role='snapshot-filter-input']")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      this.snapshotSearchValue = target.value;
      if (this.snapshotFilterInputComposing || (event as InputEvent).isComposing) {
        return;
      }

      this.render();
    });

    root.querySelector<HTMLInputElement>("[data-role='source-input']")?.addEventListener("input", (event) => {
      const target = event.currentTarget as HTMLInputElement;
      this.sourceValue = target.value;
      this.error = "";
      this.message = "";
      if (this.sourceInputComposing || (event as InputEvent).isComposing) {
        return;
      }

      this.render();
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
      button.addEventListener("click", (event) => {
        const itemId = button.dataset.itemOpen;
        if (itemId) {
          const mouseEvent = event as MouseEvent;
          void this.openItem(itemId, { inSidebar: mouseEvent.shiftKey });
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
      });

      element.addEventListener("dragend", (event) => {
        const itemId = element.dataset.itemDrag;
        const snapshot = this.getActiveSnapshot();
        if (!itemId || !snapshot || !event.dataTransfer) {
          return;
        }

        const item = snapshot.items.find((entry) => entry.id === itemId);
        if (!item || item.status !== "unseen") {
          return;
        }

        if (event.dataTransfer.dropEffect && event.dataTransfer.dropEffect !== "none") {
          item.status = "seen";
          this.recordItemStatus(snapshot, item.id, "seen");
          this.persist();
          this.render();
        }
      });
    });

    root.querySelector<HTMLElement>("[data-role='source-input']")?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).isComposing || this.sourceInputComposing) {
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        void this.createSnapshot();
      }
    });

    root.querySelector<HTMLElement>("[data-role='snapshot-filter-input']")?.addEventListener("keydown", (event) => {
      if ((event as KeyboardEvent).isComposing || this.snapshotFilterInputComposing) {
        return;
      }

      if (event.key === "Escape" && (this.snapshotSearchValue || this.snapshotTypeFilter !== "all")) {
        event.preventDefault();
        this.clearSnapshotViewFilters();
        this.render();
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

  private captureFocusedInputState(root: HTMLElement): PreservedInputState | null {
    const activeElement = root.ownerDocument?.activeElement;
    if (!(activeElement instanceof HTMLInputElement)) {
      return null;
    }

    const role = activeElement.dataset.role;
    if (role !== "source-input" && role !== "snapshot-filter-input") {
      return null;
    }

    return {
      role,
      value: activeElement.value,
      selectionStart: activeElement.selectionStart,
      selectionEnd: activeElement.selectionEnd,
      selectionDirection: activeElement.selectionDirection,
    };
  }

  private restoreFocusedInputState(root: HTMLElement, state: PreservedInputState | null): void {
    if (!state) {
      return;
    }

    const input = root.querySelector<HTMLInputElement>(`[data-role='${state.role}']`);
    if (!input) {
      return;
    }

    input.focus({ preventScroll: true });
    if (input.value !== state.value) {
      input.value = state.value;
    }

    if (state.selectionStart !== null && state.selectionEnd !== null) {
      try {
        input.setSelectionRange(state.selectionStart, state.selectionEnd, state.selectionDirection ?? undefined);
      } catch (_error) {
        // Ignore unsupported selection restoration.
      }
    }
  }

  render(): void {
    const activeReviewKey = this.getActiveReviewKey();
    this.syncSnapshotViewFilterScope(activeReviewKey);
    const snapshot = this.getActiveSnapshot();
    const savedSourceEntries = this.getSavedSourceEntries();
    const visibleItems = this.getVisibleItems();
    const counts = this.getCounts(snapshot);
    const referenceCounts = this.getReferenceCounts(snapshot);
    const snapshotTypeCounts = this.getSnapshotTypeCounts(snapshot);
    const sourcePlaceholder = this.sourceType === "page" ? "Page name" : "Keyword";
    const snapshotFilterPlaceholder = "Filter current snapshot";
    const snapshotViewFilterActive = Boolean(this.snapshotSearchValue.trim() || this.snapshotTypeFilter !== "all");
    const trimmedSourceValue = this.sourceValue.trim();
    const draftReviewKey =
      this.currentWhiteboard && trimmedSourceValue
        ? buildReviewKey(this.currentWhiteboard.id, this.sourceType, trimmedSourceValue)
        : null;
    const createSnapshotLabel =
      this.busy ? "Saving..." : draftReviewKey && this.graphState.sourceMetaByReviewKey[draftReviewKey] ? "Refresh Snapshot" : "Create Snapshot";
    const routeLabel = this.currentWhiteboard?.name ?? "No whiteboard";
    const locatePreviewState = this.locatePreviewState;
    const locatePreviewActive = Boolean(locatePreviewState && !this.getRouteWhiteboardName());
    const isDockActive = Boolean(this.currentWhiteboard && this.graphState.dockVisible);
    const hasFeedbackMessage = Boolean(this.error || this.message);
    const removeActiveDisabled = !activeReviewKey;
    const savedSourcesToggleLabel = this.savedSourcesCollapsed ? "Expand saved sources" : "Collapse saved sources";
    const root = this.renderRoot;
    const preservedInputState = this.captureFocusedInputState(root);
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
        .filters {
          padding: 12px 14px;
          border-bottom: 1px solid var(--panel-border-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .header,
        #${APP_ROOT_ID}[data-theme="dark"] .sources,
        #${APP_ROOT_ID}[data-theme="dark"] .controls,
        #${APP_ROOT_ID}[data-theme="dark"] .filters {
          border-bottom-color: var(--panel-border-dark);
        }

        .header {
          display: grid;
          gap: 8px;
        }

        .filters {
          display: grid;
          gap: 10px;
        }

        .header-row,
        .control-row,
        .filter-row,
        .status-row {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .control-row,
        .filter-row,
        .status-row {
          flex-wrap: wrap;
        }

        .header-row {
          justify-content: space-between;
          align-items: flex-start;
          gap: 12px;
        }

        .header-actions {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          flex-shrink: 0;
        }

        .header-controls {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-wrap: nowrap;
          justify-content: flex-end;
          min-width: 0;
        }

        .title-group {
          min-width: 0;
          display: grid;
          gap: 3px;
        }

        .subtitle-row {
          display: flex;
          align-items: center;
          gap: 6px;
          min-width: 0;
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

        .preview-chip {
          display: inline-flex;
          align-items: center;
          border-radius: 999px;
          padding: 2px 8px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.02em;
          background: rgba(59, 130, 246, 0.16);
          color: var(--accent);
          white-space: nowrap;
          flex-shrink: 0;
        }

        .has-tooltip {
          position: relative;
        }

        .has-tooltip::after {
          content: attr(data-tooltip);
          position: absolute;
          right: 0;
          left: auto;
          top: calc(100% + 8px);
          width: max-content;
          max-width: min(320px, calc(100vw - 40px));
          padding: 6px 8px;
          border-radius: 8px;
          background: rgba(15, 23, 42, 0.96);
          color: #f8fafc;
          font-size: 11px;
          font-weight: 600;
          line-height: 1.35;
          white-space: normal;
          word-break: normal;
          overflow-wrap: break-word;
          text-align: left;
          pointer-events: none;
          opacity: 0;
          transform: translateY(-3px);
          transform-origin: top right;
          transition: opacity 0.14s ease, transform 0.14s ease;
          transition-delay: 0ms;
          z-index: 30;
          box-shadow: 0 10px 24px rgba(15, 23, 42, 0.22);
        }

        .has-tooltip:hover::after,
        .has-tooltip:focus-visible::after {
          opacity: 1;
          transform: translateY(0);
          transition-delay: 100ms;
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

        .icon-button {
          width: 38px;
          height: 38px;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 10px;
        }

        .primary-icon-button {
          width: 42px;
          height: 42px;
          padding: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: 12px;
          background: var(--accent);
          color: white;
          border-color: transparent;
          box-shadow: 0 6px 16px rgba(37, 99, 235, 0.22);
        }

        .icon-button svg {
          width: 17px;
          height: 17px;
          stroke: currentColor;
          fill: none;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .primary-icon-button svg {
          width: 18px;
          height: 18px;
          stroke: currentColor;
          fill: none;
          stroke-width: 2.2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .compact-filter-button {
          min-width: 46px;
          height: 38px;
          padding: 0 10px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          background: transparent;
          color: inherit;
          border-color: transparent;
        }

        .compact-filter-button svg {
          width: 16px;
          height: 16px;
          stroke: currentColor;
          fill: none;
          stroke-width: 2;
          stroke-linecap: round;
          stroke-linejoin: round;
        }

        .compact-filter-count {
          font-size: 11px;
          font-weight: 700;
          line-height: 1;
          color: inherit;
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

        .ghost-button[disabled],
        .chip-button[disabled],
        .status-button[disabled] {
          opacity: 0.45;
          cursor: default;
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
        .status-button.active,
        .compact-filter-button.active {
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

        .section-controls {
          display: inline-flex;
          align-items: center;
          gap: 8px;
          flex-shrink: 0;
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

        .source-list.collapsed {
          display: none;
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

        .source-command-row,
        .snapshot-view-toolbar {
          display: flex;
          align-items: center;
          gap: 8px;
          min-width: 0;
          flex-wrap: nowrap;
        }

        .source-command-row .source-input,
        .snapshot-view-toolbar .input-with-icon {
          min-width: 0;
          flex: 1;
        }

        .snapshot-view-filters {
          padding: 10px 12px;
          border: 1px solid var(--panel-border-light);
          border-radius: 12px;
          background: rgba(148, 163, 184, 0.06);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .snapshot-view-filters {
          border-color: var(--panel-border-dark);
          background: rgba(15, 23, 42, 0.42);
        }

        .snapshot-filter-input {
          min-width: 0;
          flex: 1;
          padding: 8px 10px 8px 30px;
        }

        .snapshot-type-switch {
          display: inline-flex;
          padding: 4px;
          border-radius: 12px;
          background: rgba(148, 163, 184, 0.12);
          gap: 4px;
          flex-shrink: 0;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .snapshot-type-switch {
          background: rgba(148, 163, 184, 0.10);
        }

        .input-with-icon {
          position: relative;
          display: inline-flex;
          align-items: center;
        }

        .input-with-icon svg {
          position: absolute;
          left: 10px;
          width: 14px;
          height: 14px;
          stroke: var(--muted-light);
          fill: none;
          stroke-width: 1.9;
          stroke-linecap: round;
          stroke-linejoin: round;
          pointer-events: none;
        }

        #${APP_ROOT_ID}[data-theme="dark"] .input-with-icon svg {
          stroke: var(--muted-dark);
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

        .theme-switch {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 4px;
          border-radius: 12px;
          background: rgba(148, 163, 184, 0.12);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .theme-switch {
          background: rgba(148, 163, 184, 0.10);
        }

        .theme-button {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 6px 9px;
          border-radius: 10px;
          border: 1px solid transparent;
          background: transparent;
          color: inherit;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          white-space: nowrap;
          transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
        }

        .theme-button:hover {
          background: rgba(37, 99, 235, 0.08);
        }

        .theme-button.active {
          border-color: var(--accent);
          color: var(--accent);
          background: rgba(37, 99, 235, 0.10);
        }

        .theme-button svg {
          width: 14px;
          height: 14px;
          stroke: currentColor;
          fill: none;
          stroke-width: 1.75;
          stroke-linecap: round;
          stroke-linejoin: round;
          flex-shrink: 0;
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

        .item-card[data-status="pending"] {
          border-color: rgba(124, 58, 237, 0.42);
          background: linear-gradient(180deg, rgba(124, 58, 237, 0.06), rgba(255, 255, 255, 0.72));
        }

        #${APP_ROOT_ID}[data-theme="dark"] .item-card[data-status="seen"] {
          background: linear-gradient(180deg, rgba(22, 163, 74, 0.10), rgba(15, 23, 42, 0.74));
        }

        #${APP_ROOT_ID}[data-theme="dark"] .item-card[data-status="skipped"] {
          background: linear-gradient(180deg, rgba(217, 119, 6, 0.10), rgba(15, 23, 42, 0.74));
        }

        #${APP_ROOT_ID}[data-theme="dark"] .item-card[data-status="pending"] {
          background: linear-gradient(180deg, rgba(124, 58, 237, 0.12), rgba(15, 23, 42, 0.74));
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

        .status-dot.pending {
          background: #7c3aed;
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
          flex-wrap: nowrap;
          justify-content: flex-end;
          min-width: 0;
          margin-left: auto;
        }

        .sync-actions {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
          min-width: 0;
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
          margin-left: auto;
          flex-shrink: 0;
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
              <div class="subtitle-row">
                <p class="subtitle">${escapeHtml(routeLabel)}</p>
                ${
                  locatePreviewActive && locatePreviewState
                    ? `<span class="preview-chip has-tooltip" data-tooltip="${escapeAttribute(
                        `Locate preview: viewing ${locatePreviewState.targetLabel} outside the whiteboard`,
                      )}">Locate preview</span>`
                    : ""
                }
              </div>
            </div>
            <div class="header-controls">
              <div class="theme-switch" role="tablist" aria-label="RefDock theme">
                ${renderThemePreferenceButton("auto", "Auto", this.getThemePreference())}
                ${renderThemePreferenceButton("dark", "Dark", this.getThemePreference())}
                ${renderThemePreferenceButton("light", "Light", this.getThemePreference())}
              </div>
              <div class="header-actions">
                <span class="width-chip" data-role="width-readout">${this.formatWidthLabel()}</span>
                ${
                  locatePreviewActive
                    ? renderHeaderActionIconButton(
                        "back-to-whiteboard",
                        "Back to Whiteboard",
                        `<svg viewBox="0 0 20 20" aria-hidden="true">
                           <path d="M8.25 5 3.75 9.5l4.5 4.5" />
                           <path d="M4.25 9.5H13a3.75 3.75 0 0 1 0 7.5h-1.5" />
                         </svg>`,
                      )
                    : ""
                }
                ${renderHeaderActionIconButton(
                  "refresh-dock",
                  "Refresh",
                  `<svg viewBox="0 0 20 20" aria-hidden="true">
                     <path d="M16 10a6 6 0 1 1-1.76-4.24" />
                     <path d="M16 4.5v4h-4" />
                   </svg>`,
                )}
                ${renderHeaderActionIconButton(
                  "toggle-dock",
                  isDockActive ? "Hide" : "Show",
                  isDockActive
                    ? `<svg viewBox="0 0 20 20" aria-hidden="true">
                         <rect x="3" y="4" width="14" height="12" rx="2" />
                         <path d="M12.5 4v12" />
                         <path d="M14.75 10h-4.5" />
                       </svg>`
                    : `<svg viewBox="0 0 20 20" aria-hidden="true">
                         <rect x="3" y="4" width="14" height="12" rx="2" />
                         <path d="M12.5 4v12" />
                         <path d="M10.25 10h4.5" />
                       </svg>`,
                )}
              </div>
            </div>
          </div>
        </section>

        <section class="sources">
          <div class="section-row">
            <span class="section-title">Saved sources</span>
            <div class="section-controls">
              <span class="hint">${savedSourceEntries.length} saved</span>
              ${renderHeaderActionIconButton(
                "toggle-saved-sources",
                savedSourcesToggleLabel,
                this.savedSourcesCollapsed
                  ? `<svg viewBox="0 0 20 20" aria-hidden="true">
                       <path d="m6.5 8 3.5 3.5L13.5 8" />
                     </svg>`
                  : `<svg viewBox="0 0 20 20" aria-hidden="true">
                       <path d="m8 6.5 3.5 3.5L8 13.5" />
                     </svg>`,
                { ariaExpanded: !this.savedSourcesCollapsed },
              )}
            </div>
          </div>
          <div class="source-list ${this.savedSourcesCollapsed ? "collapsed" : ""}">
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
              <div class="sync-actions">
                <button class="ghost-button" data-action="open-current-sync-page">Current sync file</button>
                <button class="ghost-button" data-action="open-sync-index-page">All sync files</button>
              </div>
              <span class="sync-chip ${escapeAttribute(this.getSyncMode() === "graph-backed" ? this.graphSyncStatus : "local-only")}">
                ${escapeHtml(this.getGraphSyncStatusLabel())}
              </span>
            </div>
          </div>
          <div class="controls-grid">
            <div class="source-command-row">
              <input
                class="source-input"
                data-role="source-input"
                value="${escapeAttribute(this.sourceValue)}"
                placeholder="${escapeAttribute(sourcePlaceholder)}"
              />
              ${renderPrimaryActionIconButton(
                "create-snapshot",
                createSnapshotLabel,
                draftReviewKey && this.graphState.sourceMetaByReviewKey[draftReviewKey]
                  ? `<svg viewBox="0 0 20 20" aria-hidden="true">
                       <path d="M16 10a6 6 0 1 1-1.76-4.24" />
                       <path d="M16 4.5v4h-4" />
                     </svg>`
                  : `<svg viewBox="0 0 20 20" aria-hidden="true">
                       <path d="M10 4.5v11" />
                       <path d="M4.5 10h11" />
                     </svg>`,
                this.busy,
              )}
              ${renderHeaderActionIconButton(
                "clear-snapshot",
                "Remove active source",
                `<svg viewBox="0 0 20 20" aria-hidden="true">
                   <path d="M5.5 6.5h9" />
                   <path d="M8 6.5V5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1.5" />
                   <path d="M7 8.5v6" />
                   <path d="M10 8.5v6" />
                   <path d="M13 8.5v6" />
                   <path d="M6.5 6.5 7 15a1.5 1.5 0 0 0 1.5 1.5h3A1.5 1.5 0 0 0 13 15l.5-8.5" />
                 </svg>`,
                { disabled: removeActiveDisabled },
              )}
            </div>
            ${
              hasFeedbackMessage
                ? `<div class="message ${this.error ? "error" : ""}">${escapeHtml(this.error || this.message)}</div>`
                : ""
            }
          </div>
        </section>

        <section class="filters">
          <div class="reference-tabs" role="tablist" aria-label="Reference type">
            ${renderReferenceFilterButton("all", "All", referenceCounts.all, this.referenceFilter)}
            ${renderReferenceFilterButton("linked", "Linked", referenceCounts.linked, this.referenceFilter)}
            ${renderReferenceFilterButton("unlinked", "Unlinked", referenceCounts.unlinked, this.referenceFilter)}
          </div>
          <div class="filter-row">
            ${renderFilterButton("all", "All", counts.all, this.statusFilter)}
            ${renderFilterButton("unseen", "Unseen", counts.unseen, this.statusFilter)}
            ${renderFilterButton("seen", "Seen", counts.seen, this.statusFilter)}
            ${renderFilterButton("pending", "Pending", counts.pending, this.statusFilter)}
            ${renderFilterButton("skipped", "Skipped", counts.skipped, this.statusFilter)}
          </div>
          <div class="snapshot-view-filters">
            <div class="snapshot-view-toolbar">
              <label class="input-with-icon">
                <svg viewBox="0 0 20 20" aria-hidden="true">
                  <circle cx="9" cy="9" r="5.5"></circle>
                  <path d="m13.5 13.5 3 3"></path>
                </svg>
                <input
                  class="source-input snapshot-filter-input"
                  data-role="snapshot-filter-input"
                  value="${escapeAttribute(this.snapshotSearchValue)}"
                  placeholder="${escapeAttribute(snapshotFilterPlaceholder)}"
                />
              </label>
              <div class="snapshot-type-switch">
                ${renderSnapshotTypeFilterButton("all", "All", snapshotTypeCounts.all, this.snapshotTypeFilter)}
                ${renderSnapshotTypeFilterButton("block", "Blocks", snapshotTypeCounts.block, this.snapshotTypeFilter)}
                ${renderSnapshotTypeFilterButton("page", "Pages", snapshotTypeCounts.page, this.snapshotTypeFilter)}
              </div>
              ${renderHeaderActionIconButton(
                "clear-snapshot-view-filters",
                "Clear temporary snapshot filters",
                `<svg viewBox="0 0 20 20" aria-hidden="true">
                   <path d="m6 6 8 8" />
                   <path d="m14 6-8 8" />
                 </svg>`,
                { disabled: !snapshotViewFilterActive },
              )}
            </div>
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
                                ${renderItemContextMeta(item)}
                              </div>
                            </div>
                          </div>
                          <div class="item-actions">
                            <button class="ghost-button" data-item-open="${escapeAttribute(item.id)}">Locate</button>
                            <button class="status-button ${item.status === "seen" ? "active" : ""}" data-item-id="${escapeAttribute(item.id)}" data-item-status="seen">Seen</button>
                            <button class="status-button ${item.status === "unseen" ? "active" : ""}" data-item-id="${escapeAttribute(item.id)}" data-item-status="unseen">Unseen</button>
                            <button class="status-button ${item.status === "pending" ? "active" : ""}" data-item-id="${escapeAttribute(item.id)}" data-item-status="pending">Pending</button>
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
    this.restoreFocusedInputState(root, preservedInputState);
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

function normalizeDisplayValue(value: string | undefined): string {
  return value ? value.replace(/\s+/g, " ").trim().toLocaleLowerCase() : "";
}

function renderItemContextMeta(item: SnapshotItem): string {
  const values: string[] = [];

  if (item.type === "block" && item.pageTitle) {
    values.push(item.pageTitle);
  }

  const fallbackValue = item.pageName ?? item.blockUuid ?? "";
  if (fallbackValue) {
    const normalizedFallbackValue = normalizeDisplayValue(fallbackValue);
    if (!values.some((value) => normalizeDisplayValue(value) === normalizedFallbackValue)) {
      values.push(fallbackValue);
    }
  }

  return values.map((value) => `<span>${escapeHtml(value)}</span>`).join("");
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

function renderSnapshotTypeFilterButton(
  filter: SnapshotTypeFilter,
  label: string,
  count: number,
  activeFilter: SnapshotTypeFilter,
): string {
  const icon =
    filter === "all"
      ? `<svg viewBox="0 0 20 20" aria-hidden="true">
           <path d="M5 6.5h10" />
           <path d="M5 10h10" />
           <path d="M5 13.5h10" />
         </svg>`
      : filter === "block"
        ? `<svg viewBox="0 0 20 20" aria-hidden="true">
             <rect x="4.5" y="4.5" width="11" height="11" rx="2"></rect>
             <path d="M8 8h4" />
             <path d="M8 10h4" />
             <path d="M8 12h3" />
           </svg>`
        : `<svg viewBox="0 0 20 20" aria-hidden="true">
             <path d="M6.5 3.5h5l3 3V15a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 15V5A1.5 1.5 0 0 1 6.5 3.5Z"></path>
             <path d="M11.5 3.5V7h3"></path>
           </svg>`;

  return `
    <button
      class="ghost-button compact-filter-button has-tooltip ${filter === activeFilter ? "active" : ""}"
      data-snapshot-type-filter="${filter}"
      aria-label="${escapeAttribute(`${label} (${count})`)}"
      data-tooltip="${escapeAttribute(`${label} (${count})`)}"
    >
      ${icon}
      <span class="compact-filter-count">${count}</span>
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

function renderThemePreferenceButton(preference: ThemePreference, label: string, activePreference: ThemePreference): string {
  const icon =
    preference === "auto"
      ? `<svg viewBox="0 0 16 16" aria-hidden="true">
           <circle cx="8" cy="8" r="4.5"></circle>
           <path d="M8 1.75v1.5M8 12.75v1.5M1.75 8h1.5M12.75 8h1.5"></path>
         </svg>`
      : preference === "dark"
        ? `<svg viewBox="0 0 16 16" aria-hidden="true">
             <path d="M10.9 1.9a5.9 5.9 0 1 0 3.2 10.9A6.3 6.3 0 0 1 10.9 1.9Z"></path>
           </svg>`
        : `<svg viewBox="0 0 16 16" aria-hidden="true">
             <circle cx="8" cy="8" r="3.2"></circle>
             <path d="M8 1.25v1.6M8 13.15v1.6M1.25 8h1.6M13.15 8h1.6M3.2 3.2l1.1 1.1M11.7 11.7l1.1 1.1M12.8 3.2l-1.1 1.1M4.3 11.7l-1.1 1.1"></path>
           </svg>`;

  return `
    <button
      class="theme-button has-tooltip ${preference === activePreference ? "active" : ""}"
      data-theme-preference="${escapeAttribute(preference)}"
      role="tab"
      aria-selected="${preference === activePreference ? "true" : "false"}"
      data-tooltip="${escapeAttribute(label)}"
    >
      ${icon}
      <span>${escapeHtml(label)}</span>
    </button>
  `;
}

function renderHeaderActionIconButton(
  action: string,
  label: string,
  icon: string,
  options?: { disabled?: boolean; className?: string; ariaExpanded?: boolean },
): string {
  const className = options?.className ? ` ${options.className}` : "";
  const disabled = options?.disabled ? " disabled" : "";
  const ariaExpanded =
    typeof options?.ariaExpanded === "boolean" ? ` aria-expanded="${options.ariaExpanded ? "true" : "false"}"` : "";

  return `
    <button
      class="ghost-button icon-button has-tooltip${className}"
      data-action="${escapeAttribute(action)}"
      aria-label="${escapeAttribute(label)}"
      data-tooltip="${escapeAttribute(label)}"
      ${disabled}
      ${ariaExpanded}
    >
      ${icon}
    </button>
  `;
}

function renderPrimaryActionIconButton(action: string, label: string, icon: string, disabled?: boolean): string {
  return `
    <button
      class="primary-button primary-icon-button has-tooltip"
      data-action="${escapeAttribute(action)}"
      aria-label="${escapeAttribute(label)}"
      data-tooltip="${escapeAttribute(label)}"
      ${disabled ? "disabled" : ""}
    >
      ${icon}
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

  logseq.App.registerCommandShortcut(
    {
      mode: "global",
      binding: getToggleDockShortcut(),
      mac: getToggleDockShortcut(),
    },
    () => {
      void app.toggleDock();
    },
    {
      key: "whiteboard-refdock-toggle-shortcut",
      label: "Whiteboard RefDock: Toggle dock shortcut",
      desc: "Toggle RefDock with the configured keyboard shortcut.",
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
