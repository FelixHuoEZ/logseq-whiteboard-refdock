import type { ReviewStateItem, ReviewStateRecord, SavedSourceMeta, WhiteboardInfo } from "./types";

const SYNC_NAMESPACE = "whiteboard-refdock/state";
const PAGE_KIND = "whiteboard-state";
const INDEX_KIND = "sync-index";
const SOURCE_MARKER = "refdock-source";
const ITEM_MARKER = "refdock-item";

const PROP_KIND = "refdock-kind";
const PROP_SCHEMA_VERSION = "refdock-schema-version";
const PROP_WHITEBOARD_ID = "refdock-whiteboard-id";
const PROP_WHITEBOARD_NAME = "refdock-whiteboard-name";
const PROP_UPDATED_AT = "refdock-updated-at";
const PROP_REVIEW_KEY = "refdock-review-key";
const PROP_SOURCE_TYPE = "refdock-source-type";
const PROP_SOURCE_VALUE = "refdock-source-value";
const PROP_NORMALIZED_SOURCE_VALUE = "refdock-normalized-source-value";
const PROP_CREATED_AT = "refdock-created-at";
const PROP_ITEM_ID = "refdock-item-id";
const PROP_STATUS = "refdock-status";
const PROP_TOTAL_ITEMS = "refdock-total-items";
const PROP_LINKED_COUNT = "refdock-linked-count";
const PROP_UNLINKED_COUNT = "refdock-unlinked-count";
const PROP_UNSEEN_COUNT = "refdock-unseen-count";
const PROP_SEEN_COUNT = "refdock-seen-count";
const PROP_SKIPPED_COUNT = "refdock-skipped-count";
const SCHEMA_VERSION = 1;

type BlockLike = {
  uuid?: string;
  children?: unknown[];
  properties?: Record<string, unknown>;
  content?: unknown;
};

export interface WhiteboardSyncState {
  savedReviewKeys: string[];
  sourceMetaByReviewKey: Record<string, SavedSourceMeta>;
  reviewStateByReviewKey: Record<string, ReviewStateRecord>;
}

export interface SyncSourceSummary {
  totalItems?: number;
  linkedCount?: number;
  unlinkedCount?: number;
  unseenCount?: number;
  seenCount: number;
  skippedCount: number;
}

function toPageRef(name: string): string {
  return `[[${name.replaceAll("]", "\\]")}]]`;
}

function getPageName(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  const name =
    typeof record.originalName === "string" && record.originalName.trim()
      ? record.originalName
      : typeof record.title === "string" && record.title.trim()
        ? record.title
        : typeof record.name === "string" && record.name.trim()
          ? record.name
          : typeof record["block/title"] === "string" && record["block/title"].trim()
            ? (record["block/title"] as string)
            : typeof record["block/name"] === "string" && record["block/name"].trim()
              ? (record["block/name"] as string)
              : null;

  return name;
}

export function getSyncIndexPageName(): string {
  return SYNC_NAMESPACE;
}

export function getWhiteboardSyncPageName(whiteboardId: string): string {
  return `${SYNC_NAMESPACE}/${whiteboardId}`;
}

function isBlockLike(value: unknown): value is BlockLike {
  return Boolean(value) && typeof value === "object" && typeof (value as BlockLike).uuid === "string";
}

function getProperties(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const raw = value as Record<string, unknown>;
  const sources = [
    raw.properties,
    raw["properties-text-values"],
    raw["block/properties"],
    raw["block/properties-text-values"],
  ];

  return Object.assign(
    {},
    ...sources.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object"),
  );
}

function getPropertyValue(properties: Record<string, unknown>, key: string): unknown {
  if (key in properties) {
    return properties[key];
  }

  const lowerKey = key.toLowerCase();
  if (lowerKey in properties) {
    return properties[lowerKey];
  }

  const underscoreKey = key.replaceAll("-", "_");
  if (underscoreKey in properties) {
    return properties[underscoreKey];
  }

  const camelKey = key.replace(/[-_]+([a-z])/g, (_match, char: string) => char.toUpperCase());
  if (camelKey in properties) {
    return properties[camelKey];
  }

  return undefined;
}

function coercePropertyString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) {
    return value;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      const normalized = coercePropertyString(entry);
      if (normalized) {
        return normalized;
      }
    }
    return null;
  }

  if (value && typeof value === "object") {
    const pageName = getPageName(value);
    if (pageName) {
      return pageName;
    }

    const record = value as Record<string, unknown>;
    const nestedValue =
      record.value ??
      record["block/name"] ??
      record["block/title"] ??
      record.name ??
      record.title;

    return nestedValue !== value ? coercePropertyString(nestedValue) : null;
  }

  return null;
}

function getStringProperty(properties: Record<string, unknown>, key: string): string | null {
  return coercePropertyString(getPropertyValue(properties, key));
}

function extractPageNameFromRef(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  const match = trimmed.match(/^\[\[(.+)\]\]$/);
  if (match?.[1]) {
    return match[1];
  }

  return trimmed || null;
}

function getNumberProperty(properties: Record<string, unknown>, key: string): number | null {
  const value = getPropertyValue(properties, key);
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) ? numericValue : null;
  }

  return null;
}

function extractChildBlocks(value: unknown): BlockLike[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is BlockLike => isBlockLike(entry));
}

function getBlockContent(block: BlockLike | null | undefined): string | null {
  if (!block) {
    return null;
  }

  if (typeof block.content === "string" && block.content.trim()) {
    return block.content;
  }

  const raw = block as Record<string, unknown>;
  return typeof raw["block/content"] === "string" && raw["block/content"].trim()
    ? (raw["block/content"] as string)
    : null;
}

function extractWhiteboardNameFromContent(content: string | null): string | null {
  if (!content) {
    return null;
  }

  const match = content.match(/^whiteboard::\s*(.+)$/i);
  return extractPageNameFromRef(match?.[1] ?? null);
}

function normalizeSourceMetaFromBlock(
  whiteboard: WhiteboardInfo,
  block: BlockLike,
): SavedSourceMeta | null {
  const properties = getProperties(block);
  const reviewKey = getStringProperty(properties, PROP_REVIEW_KEY);
  const sourceType = getStringProperty(properties, PROP_SOURCE_TYPE);
  const sourceValue = getStringProperty(properties, PROP_SOURCE_VALUE);
  const normalizedSourceValue = getStringProperty(properties, PROP_NORMALIZED_SOURCE_VALUE);
  const createdAt = getNumberProperty(properties, PROP_CREATED_AT);
  const updatedAt = getNumberProperty(properties, PROP_UPDATED_AT);

  if (!reviewKey || !sourceType || !sourceValue || !normalizedSourceValue || !createdAt || !updatedAt) {
    return null;
  }

  if (sourceType !== "page" && sourceType !== "keyword") {
    return null;
  }

  return {
    reviewKey,
    whiteboardId: whiteboard.id,
    whiteboardName: whiteboard.name,
    sourceType,
    sourceValue,
    normalizedSourceValue,
    createdAt,
    updatedAt,
  };
}

function normalizeReviewStateFromBlock(
  meta: SavedSourceMeta,
  block: BlockLike,
): ReviewStateRecord | null {
  const childBlocks = extractChildBlocks(block.children);
  const items: Record<string, ReviewStateItem> = {};
  let recordUpdatedAt = meta.updatedAt;

  for (const childBlock of childBlocks) {
    const properties = getProperties(childBlock);
    const marker = getStringProperty(properties, PROP_KIND);
    if (marker !== ITEM_MARKER) {
      continue;
    }

    const itemId = getStringProperty(properties, PROP_ITEM_ID);
    const status = getStringProperty(properties, PROP_STATUS);
    const updatedAt = getNumberProperty(properties, PROP_UPDATED_AT);
    if (!itemId || !updatedAt || (status !== "seen" && status !== "skipped")) {
      continue;
    }

    items[itemId] = {
      itemId,
      status,
      updatedAt,
    };
    if (updatedAt > recordUpdatedAt) {
      recordUpdatedAt = updatedAt;
    }
  }

  if (Object.keys(items).length === 0) {
    return null;
  }

  return {
    reviewKey: meta.reviewKey,
    whiteboardId: meta.whiteboardId,
    sourceType: meta.sourceType,
    sourceValue: meta.sourceValue,
    normalizedSourceValue: meta.normalizedSourceValue,
    updatedAt: recordUpdatedAt,
    items,
  };
}

export async function readWhiteboardSyncState(whiteboard: WhiteboardInfo): Promise<WhiteboardSyncState> {
  const pageName = getWhiteboardSyncPageName(whiteboard.id);
  const page = await logseq.Editor.getPage(pageName);
  if (!page) {
    return {
      savedReviewKeys: [],
      sourceMetaByReviewKey: {},
      reviewStateByReviewKey: {},
    };
  }

  const pageBlocks = await logseq.Editor.getPageBlocksTree(pageName);
  const sourceMetaByReviewKey: Record<string, SavedSourceMeta> = {};
  const reviewStateByReviewKey: Record<string, ReviewStateRecord> = {};
  const savedReviewKeys: string[] = [];

  for (const block of pageBlocks) {
    if (!isBlockLike(block)) {
      continue;
    }

    const properties = getProperties(block);
    const marker = getStringProperty(properties, PROP_KIND);
    if (marker !== SOURCE_MARKER) {
      continue;
    }

    const meta = normalizeSourceMetaFromBlock(whiteboard, block);
    if (!meta) {
      continue;
    }

    sourceMetaByReviewKey[meta.reviewKey] = meta;
    savedReviewKeys.push(meta.reviewKey);

    const reviewState = normalizeReviewStateFromBlock(meta, block);
    if (reviewState) {
      reviewStateByReviewKey[meta.reviewKey] = reviewState;
    }
  }

  return {
    savedReviewKeys,
    sourceMetaByReviewKey,
    reviewStateByReviewKey,
  };
}

async function ensureWhiteboardSyncPage(whiteboard: WhiteboardInfo): Promise<string> {
  const pageName = getWhiteboardSyncPageName(whiteboard.id);
  let page = await logseq.Editor.getPage(pageName);
  if (!page) {
    page = await logseq.Editor.createPage(
      pageName,
      {
        [PROP_KIND]: PAGE_KIND,
        [PROP_SCHEMA_VERSION]: SCHEMA_VERSION,
        [PROP_WHITEBOARD_ID]: whiteboard.id,
        [PROP_WHITEBOARD_NAME]: whiteboard.name,
        [PROP_UPDATED_AT]: Date.now(),
      },
      {
        createFirstBlock: false,
        redirect: false,
      },
    );
  }

  if (!page) {
    throw new Error(`Failed to create sync page for whiteboard ${whiteboard.name}.`);
  }

  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_KIND, PAGE_KIND);
  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_SCHEMA_VERSION, SCHEMA_VERSION);
  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_WHITEBOARD_ID, whiteboard.id);
  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_WHITEBOARD_NAME, whiteboard.name);
  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_UPDATED_AT, Date.now());

  return pageName;
}

async function ensureSyncIndexPage(): Promise<string> {
  const pageName = getSyncIndexPageName();
  let page = await logseq.Editor.getPage(pageName);
  if (!page) {
    page = await logseq.Editor.createPage(
      pageName,
      {
        [PROP_KIND]: INDEX_KIND,
        [PROP_SCHEMA_VERSION]: SCHEMA_VERSION,
        [PROP_UPDATED_AT]: Date.now(),
      },
      {
        createFirstBlock: false,
        redirect: false,
      },
    );
  }

  if (!page?.uuid) {
    throw new Error("Failed to create RefDock sync index page.");
  }

  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_KIND, INDEX_KIND);
  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_SCHEMA_VERSION, SCHEMA_VERSION);
  await logseq.Editor.upsertBlockProperty(page.uuid, PROP_UPDATED_AT, Date.now());

  return pageName;
}

async function resolveSyncPageInfo(
  pageName: string,
): Promise<{
  name: string;
  whiteboardName: string;
  whiteboardId: string;
}> {
  const directPage = await logseq.Editor.getPage(pageName);
  const directProperties = getProperties(directPage);
  let whiteboardName = getStringProperty(directProperties, PROP_WHITEBOARD_NAME);
  let whiteboardId = getStringProperty(directProperties, PROP_WHITEBOARD_ID);

  if (!whiteboardName || !whiteboardId) {
    const pageBlocks = await logseq.Editor.getPageBlocksTree(pageName);
    const headerBlock = pageBlocks.find((block) => isBlockLike(block));
    if (headerBlock) {
      const headerProperties = getProperties(headerBlock);
      const headerWhiteboardProperty = extractPageNameFromRef(getStringProperty(headerProperties, "whiteboard"));
      const headerContentWhiteboard = extractWhiteboardNameFromContent(getBlockContent(headerBlock));

      if (!whiteboardName && headerWhiteboardProperty) {
        whiteboardName = headerWhiteboardProperty;
      }
      if (!whiteboardName && headerContentWhiteboard) {
        whiteboardName = headerContentWhiteboard;
      }
      whiteboardId = whiteboardId ?? getStringProperty(headerProperties, PROP_WHITEBOARD_ID);
    }
  }

  if (whiteboardId && !whiteboardName) {
    const whiteboardPage = await logseq.Editor.getPage({ uuid: whiteboardId });
    const lookedUpWhiteboardName = getPageName(whiteboardPage);
    if (lookedUpWhiteboardName) {
      whiteboardName = lookedUpWhiteboardName;
    }
  }

  return {
    name: pageName,
    whiteboardName: whiteboardName ?? "Unknown whiteboard",
    whiteboardId: whiteboardId ?? pageName.slice(`${SYNC_NAMESPACE}/`.length),
  };
}

async function rebuildSyncIndexPage(): Promise<void> {
  const indexPageName = await ensureSyncIndexPage();
  const existingBlocks = await logseq.Editor.getPageBlocksTree(indexPageName);
  for (const block of [...existingBlocks].reverse()) {
    if (isBlockLike(block) && block.uuid) {
      await logseq.Editor.removeBlock(block.uuid);
    }
  }

  await logseq.Editor.appendBlockInPage(indexPageName, "RefDock graph-backed sync files", {
    properties: {
      [PROP_KIND]: INDEX_KIND,
      [PROP_UPDATED_AT]: Date.now(),
    },
  });

  const namespacePages = (await logseq.Editor.getPagesFromNamespace(SYNC_NAMESPACE)) ?? [];
  const pageNames = namespacePages
    .map((page) => {
      const name = getPageName(page);
      return !name || name === indexPageName || !name.startsWith(`${SYNC_NAMESPACE}/`) ? null : name;
    })
    .filter((name): name is string => name !== null);

  const statePages = (await Promise.all(pageNames.map((name) => resolveSyncPageInfo(name))))
    .sort((left, right) => left.whiteboardName.localeCompare(right.whiteboardName));

  for (const page of statePages) {
    await logseq.Editor.appendBlockInPage(indexPageName, toPageRef(page.name), {
      properties: {
        whiteboard: toPageRef(page.whiteboardName),
        [PROP_WHITEBOARD_ID]: page.whiteboardId,
      },
    });
  }
}

export async function writeWhiteboardSyncState(
  whiteboard: WhiteboardInfo,
  sourceMetas: SavedSourceMeta[],
  reviewStateByReviewKey: Record<string, ReviewStateRecord>,
  summariesByReviewKey: Record<string, SyncSourceSummary>,
): Promise<void> {
  const pageName = await ensureWhiteboardSyncPage(whiteboard);
  const existingBlocks = await logseq.Editor.getPageBlocksTree(pageName);

  for (const block of [...existingBlocks].reverse()) {
    if (isBlockLike(block) && block.uuid) {
      await logseq.Editor.removeBlock(block.uuid);
    }
  }

  await logseq.Editor.appendBlockInPage(pageName, `whiteboard:: ${toPageRef(whiteboard.name)}`, {
    properties: {
      whiteboard: toPageRef(whiteboard.name),
      [PROP_KIND]: PAGE_KIND,
      [PROP_WHITEBOARD_ID]: whiteboard.id,
      [PROP_WHITEBOARD_NAME]: whiteboard.name,
      [PROP_UPDATED_AT]: Date.now(),
    },
  });

  for (const sourceMeta of sourceMetas) {
    const summary = summariesByReviewKey[sourceMeta.reviewKey];
    const sourceBlock = await logseq.Editor.appendBlockInPage(pageName, SOURCE_MARKER, {
      properties: {
        [PROP_KIND]: SOURCE_MARKER,
        [PROP_REVIEW_KEY]: sourceMeta.reviewKey,
        [PROP_SOURCE_TYPE]: sourceMeta.sourceType,
        [PROP_SOURCE_VALUE]: sourceMeta.sourceValue,
        [PROP_NORMALIZED_SOURCE_VALUE]: sourceMeta.normalizedSourceValue,
        [PROP_CREATED_AT]: sourceMeta.createdAt,
        [PROP_UPDATED_AT]: sourceMeta.updatedAt,
        ...(summary
          ? {
              [PROP_TOTAL_ITEMS]: summary.totalItems,
              [PROP_LINKED_COUNT]: summary.linkedCount,
              [PROP_UNLINKED_COUNT]: summary.unlinkedCount,
              [PROP_UNSEEN_COUNT]: summary.unseenCount,
              [PROP_SEEN_COUNT]: summary.seenCount,
              [PROP_SKIPPED_COUNT]: summary.skippedCount,
            }
          : {}),
      },
    });

    if (!sourceBlock?.uuid) {
      continue;
    }

    const reviewState = reviewStateByReviewKey[sourceMeta.reviewKey];
    const items = reviewState
      ? Object.values(reviewState.items).sort((left, right) => left.updatedAt - right.updatedAt)
      : [];

    for (const item of items) {
      await logseq.Editor.insertBlock(sourceBlock.uuid, ITEM_MARKER, {
        sibling: false,
        focus: false,
        properties: {
          [PROP_KIND]: ITEM_MARKER,
          [PROP_ITEM_ID]: item.itemId,
          [PROP_STATUS]: item.status,
          [PROP_UPDATED_AT]: item.updatedAt,
        },
      });
    }
  }

  await rebuildSyncIndexPage();
}
