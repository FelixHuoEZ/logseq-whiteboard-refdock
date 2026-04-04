import type { ReviewStateItem, ReviewStateRecord, SavedSourceMeta, WhiteboardInfo } from "./types";

const SYNC_NAMESPACE = "whiteboard-refdock/state";
const PAGE_KIND = "whiteboard-state";
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
const SCHEMA_VERSION = 1;

type BlockLike = {
  uuid?: string;
  children?: unknown[];
  properties?: Record<string, unknown>;
};

export interface WhiteboardSyncState {
  savedReviewKeys: string[];
  sourceMetaByReviewKey: Record<string, SavedSourceMeta>;
  reviewStateByReviewKey: Record<string, ReviewStateRecord>;
}

function getWhiteboardSyncPageName(whiteboardId: string): string {
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
  return raw.properties && typeof raw.properties === "object" ? (raw.properties as Record<string, unknown>) : {};
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

  return undefined;
}

function getStringProperty(properties: Record<string, unknown>, key: string): string | null {
  const value = getPropertyValue(properties, key);
  return typeof value === "string" && value.trim() ? value : null;
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

export async function writeWhiteboardSyncState(
  whiteboard: WhiteboardInfo,
  sourceMetas: SavedSourceMeta[],
  reviewStateByReviewKey: Record<string, ReviewStateRecord>,
): Promise<void> {
  const pageName = await ensureWhiteboardSyncPage(whiteboard);
  const existingBlocks = await logseq.Editor.getPageBlocksTree(pageName);

  for (const block of [...existingBlocks].reverse()) {
    if (isBlockLike(block) && block.uuid) {
      await logseq.Editor.removeBlock(block.uuid);
    }
  }

  for (const sourceMeta of sourceMetas) {
    const sourceBlock = await logseq.Editor.appendBlockInPage(pageName, SOURCE_MARKER, {
      properties: {
        [PROP_KIND]: SOURCE_MARKER,
        [PROP_REVIEW_KEY]: sourceMeta.reviewKey,
        [PROP_SOURCE_TYPE]: sourceMeta.sourceType,
        [PROP_SOURCE_VALUE]: sourceMeta.sourceValue,
        [PROP_NORMALIZED_SOURCE_VALUE]: sourceMeta.normalizedSourceValue,
        [PROP_CREATED_AT]: sourceMeta.createdAt,
        [PROP_UPDATED_AT]: sourceMeta.updatedAt,
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
}
