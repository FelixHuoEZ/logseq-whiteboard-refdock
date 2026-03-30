import "@logseq/libs";

import { createSnapshotFromKeyword, createSnapshotFromPage, getCurrentWhiteboard } from "./query";
import { getGraphStorageKey, loadGraphState, saveGraphState } from "./storage";
import type {
  GraphState,
  ItemStatus,
  Snapshot,
  SnapshotItem,
  SnapshotSourceType,
  StatusFilter,
  ThemeMode,
  WhiteboardInfo,
} from "./types";

const APP_ROOT_ID = "whiteboard-refdock-app";
const HOST_CONTAINER_ID = "whiteboard-refdock-host";
const TOOLBAR_KEY = "whiteboard-refdock-toolbar";
const MIN_WIDTH = 320;
const MAX_WIDTH = 560;
const WIDTH_STEP = 60;
type SurfaceMode = "iframe" | "host";

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
  private statusFilter: StatusFilter = "all";
  private message = "";
  private error = "";
  private busy = false;
  private surfaceMode: SurfaceMode = "iframe";
  private themeMode: ThemeMode = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  private diagnosticsCollapsed = true;

  constructor(root: HTMLElement) {
    this.iframeRoot = root;
    this.renderRoot = root;
  }

  async init(): Promise<void> {
    await this.refreshGraphState();
    await this.refreshContext();
    this.render();
  }

  async refreshGraphState(): Promise<void> {
    const currentGraph = await logseq.App.getCurrentGraph();
    this.storageKey = getGraphStorageKey(currentGraph);
    this.graphState = loadGraphState(this.storageKey);
  }

  async refreshContext(): Promise<void> {
    this.currentWhiteboard = await getCurrentWhiteboard();
    await this.syncDockSurface();
    this.render();
  }

  async toggleDock(): Promise<void> {
    this.graphState.dockVisible = !this.graphState.dockVisible;
    this.persist();
    await this.syncDockSurface();
    this.render();
  }

  async refreshDock(): Promise<void> {
    await this.refreshGraphState();
    this.currentWhiteboard = await getCurrentWhiteboard();

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
      : "Dock refreshed and opened.";
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

  private getActiveSnapshot(): Snapshot | null {
    if (!this.currentWhiteboard) {
      return null;
    }

    return this.graphState.snapshotsByWhiteboard[this.currentWhiteboard.id] ?? null;
  }

  private getVisibleItems(): SnapshotItem[] {
    const snapshot = this.getActiveSnapshot();
    if (!snapshot) {
      return [];
    }

    if (this.statusFilter === "all") {
      return snapshot.items;
    }

    return snapshot.items.filter((item) => item.status === this.statusFilter);
  }

  private getCounts(snapshot: Snapshot | null): Record<StatusFilter, number> {
    const counts: Record<StatusFilter, number> = {
      all: snapshot?.items.length ?? 0,
      unseen: 0,
      seen: 0,
      skipped: 0,
    };

    if (!snapshot) {
      return counts;
    }

    for (const item of snapshot.items) {
      counts[item.status] += 1;
    }

    return counts;
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
    this.hostRoot = appRoot;
    return appRoot;
  }

  private hideHostSurface(): void {
    if (!this.hostContainer) {
      return;
    }

    this.hostContainer.style.display = "none";
  }

  private async syncDockSurface(): Promise<void> {
    const isActive = Boolean(this.currentWhiteboard && this.graphState.dockVisible);
    if (!isActive) {
      this.surfaceMode = "iframe";
      this.renderRoot = this.iframeRoot;
      this.hideHostSurface();
      logseq.hideMainUI({ restoreEditingCursor: false });
      return;
    }

    const hostRoot = this.ensureHostRoot();
    if (hostRoot) {
      this.surfaceMode = "host";
      this.renderRoot = hostRoot;
      if (this.hostContainer) {
        Object.assign(this.hostContainer.style, {
          position: "fixed",
          top: "0",
          right: "0",
          width: `${this.graphState.dockWidth}px`,
          height: "100vh",
          zIndex: "60",
          display: "block",
          pointerEvents: "auto",
          background: "transparent",
        });
      }

      logseq.hideMainUI({ restoreEditingCursor: false });
      return;
    }

    this.surfaceMode = "iframe";
    this.renderRoot = this.iframeRoot;
    this.hideHostSurface();
    logseq.setMainUIInlineStyle({
      position: "fixed",
      top: "0",
      right: "0",
      width: `${this.graphState.dockWidth}px`,
      height: "100vh",
      zIndex: 11,
      border: "none",
      background: "transparent",
      boxShadow: "none",
      overflow: "hidden",
    });
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
      const snapshot =
        this.sourceType === "page"
          ? await createSnapshotFromPage(whiteboard, sourceValue)
          : await createSnapshotFromKeyword(whiteboard, sourceValue);

      this.graphState.snapshotsByWhiteboard[whiteboard.id] = snapshot;
      this.graphState.scrollByWhiteboard[whiteboard.id] = 0;
      this.persist();
      this.message = `Saved ${snapshot.items.length} snapshot items.`;
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

  private clearSnapshot(): void {
    if (!this.currentWhiteboard) {
      return;
    }

    delete this.graphState.snapshotsByWhiteboard[this.currentWhiteboard.id];
    delete this.graphState.scrollByWhiteboard[this.currentWhiteboard.id];
    this.persist();
    this.message = "Snapshot cleared.";
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
    this.persist();
    this.render();
  }

  private async openItem(itemId: string): Promise<void> {
    const snapshot = this.getActiveSnapshot();
    const item = snapshot?.items.find((entry) => entry.id === itemId);
    if (!item?.pageName) {
      return;
    }

    if (item.status === "unseen") {
      item.status = "seen";
      this.persist();
    }

    if (item.type === "block" && item.blockUuid) {
      await logseq.Editor.scrollToBlockInPage(item.pageName, item.blockUuid);
      return;
    }

    logseq.App.pushState("page", { name: item.pageName });
  }

  private changeWidth(delta: number): void {
    const nextWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, this.graphState.dockWidth + delta));
    if (nextWidth === this.graphState.dockWidth) {
      return;
    }

    this.graphState.dockWidth = nextWidth;
    this.persist();
    void this.syncDockSurface();
    this.render();
  }

  private saveScrollPosition(scrollTop: number): void {
    if (!this.currentWhiteboard) {
      return;
    }

    this.graphState.scrollByWhiteboard[this.currentWhiteboard.id] = scrollTop;
    this.persist();
  }

  private restoreScrollPosition(): void {
    if (!this.currentWhiteboard) {
      return;
    }

    const scrollContainer = this.renderRoot.querySelector<HTMLElement>("[data-role='list-scroll']");
    if (!scrollContainer) {
      return;
    }

    const scrollTop = this.graphState.scrollByWhiteboard[this.currentWhiteboard.id] ?? 0;
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

    root.querySelector<HTMLElement>("[data-action='toggle-diagnostics']")?.addEventListener("click", () => {
      this.diagnosticsCollapsed = !this.diagnosticsCollapsed;
      this.render();
    });

    root.querySelector<HTMLElement>("[data-action='toggle-dock']")?.addEventListener("click", () => {
      void this.toggleDock();
    });

    root.querySelector<HTMLElement>("[data-action='width-down']")?.addEventListener("click", () => {
      this.changeWidth(-WIDTH_STEP);
    });

    root.querySelector<HTMLElement>("[data-action='width-up']")?.addEventListener("click", () => {
      this.changeWidth(WIDTH_STEP);
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
        const item = snapshot?.items.find((entry) => entry.id === itemId);
        if (!item || !event.dataTransfer) {
          return;
        }

        if (item.pageName) {
          event.dataTransfer.setData("page-name", item.pageName);
          event.dataTransfer.setData("text/plain", item.pageName);
        }

        if (item.blockUuid) {
          event.dataTransfer.setData("block-uuid", item.blockUuid);
          event.dataTransfer.setData("text/plain", item.blockUuid);
        }

        event.dataTransfer.effectAllowed = "copy";

        if (item.status === "unseen") {
          item.status = "seen";
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
        <p>Try a different filter or create a new snapshot.</p>
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
    const visibleItems = this.getVisibleItems();
    const counts = this.getCounts(snapshot);
    const sourcePlaceholder = this.sourceType === "page" ? "Page name" : "Keyword";
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
        }

        #${APP_ROOT_ID}[data-theme="dark"] {
          color: var(--text-dark);
        }

        .panel {
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
        .controls,
        .filters,
        .status-bar {
          padding: 12px 14px;
          border-bottom: 1px solid var(--panel-border-light);
        }

        #${APP_ROOT_ID}[data-theme="dark"] .header,
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
        }

        .title-group {
          min-width: 0;
        }

        .eyebrow {
          margin: 0 0 6px;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--accent);
        }

        .title {
          font-size: 16px;
          font-weight: 700;
          line-height: 1.2;
          margin: 0;
        }

        .subtitle {
          margin: 4px 0 0;
          font-size: 12px;
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

        .controls-grid {
          display: grid;
          gap: 8px;
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

        .spacer {
          flex: 1;
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
        <section class="header">
          <div class="header-row">
            <div class="title-group">
              <p class="eyebrow">Whiteboard Review Dock</p>
              <h1 class="title">Whiteboard RefDock</h1>
              <p class="subtitle">${escapeHtml(routeLabel)}</p>
            </div>
            <button class="ghost-button" data-action="toggle-dock">${isDockActive ? "Hide" : "Show"}</button>
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
            <button class="ghost-button" data-action="width-down">-</button>
            <span class="hint">${this.graphState.dockWidth}px</span>
            <button class="ghost-button" data-action="width-up">+</button>
          </div>
        </section>

        <section class="controls">
          <div class="control-row">
            <div class="mode-switch">
              <button class="chip-button ${this.sourceType === "page" ? "active" : ""}" data-source-type="page">Page</button>
              <button class="chip-button ${this.sourceType === "keyword" ? "active" : ""}" data-source-type="keyword">Keyword</button>
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
              <button class="primary-button" data-action="create-snapshot" ${this.busy ? "disabled" : ""}>
                ${this.busy ? "Saving..." : "Create Snapshot"}
              </button>
              <button class="ghost-button" data-action="clear-snapshot">Clear</button>
            </div>
            <div class="message ${this.error ? "error" : ""}">
              ${escapeHtml(
                this.error ||
                  this.message ||
                  (this.sourceType === "page"
                    ? "Page mode uses Logseq's page unlinked references path."
                    : "Keyword mode uses Logseq's keyword search path and saves a snapshot."),
              )}
            </div>
          </div>
        </section>

        <section class="filters">
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

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function renderFilterButton(filter: StatusFilter, label: string, count: number, activeFilter: StatusFilter): string {
  return `
    <button class="chip-button ${filter === activeFilter ? "active" : ""}" data-filter="${filter}">
      ${escapeHtml(label)} <span class="count">${count}</span>
    </button>
  `;
}

function renderRefreshToolbarIconTemplate(): string {
  return `
    <a class="button" data-on-click="refreshDock" title="Refresh Whiteboard RefDock" aria-label="Refresh Whiteboard RefDock">
      <span
        style="
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 1.35rem;
          height: 1.35rem;
          opacity: 0.82;
        "
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M12.9 8A4.9 4.9 0 1 1 11.47 4.53"
            stroke="currentColor"
            stroke-width="1.35"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            d="M10.9 3.35H13V5.45"
            stroke="currentColor"
            stroke-width="1.35"
            stroke-linecap="round"
            stroke-linejoin="round"
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

  const app = new WhiteboardRefDockApp(root);

  logseq.provideModel({
    toggleDock() {
      void app.toggleDock();
    },
    refreshDock() {
      void app.refreshDock();
    },
  });

  logseq.App.registerUIItem("toolbar", {
    key: TOOLBAR_KEY,
    template: renderRefreshToolbarIconTemplate(),
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
      await app.refreshContext();
    })();
  });

  logseq.App.onThemeModeChanged(({ mode }) => {
    app.setThemeMode(mode);
  });

  await app.init();
  console.info("logseq-whiteboard-refdock loaded");
}

void logseq.ready(main).catch((error) => {
  console.error("logseq-whiteboard-refdock failed to load", error);
});
