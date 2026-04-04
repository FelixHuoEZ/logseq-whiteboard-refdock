# Whiteboard RefDock

Review saved linked and unlinked reference snapshots in a dedicated dock while working on a Logseq whiteboard.

![Whiteboard RefDock preview](./assets/refdock-preview.png)

## What It Does

Whiteboard RefDock turns reference review into a whiteboard-first workflow.

Instead of relying on Logseq's live references view, it creates saved sources for the current whiteboard and keeps that review queue visible in a dedicated right-side dock.

## Features

- Create a saved source from a page or a keyword.
- Keep multiple saved sources per whiteboard instead of overwriting a single queue.
- Review `Linked` and `Unlinked` references in separate tabs.
- Mark items as `unseen`, `seen`, or `skipped`.
- Drag page and block items directly into the native Logseq whiteboard.
- Restore saved sources, review state, scroll position, and dock width when you return.
- Optionally enable graph-backed sync for saved sources and review state.
- Open the current sync file or the graph-wide sync index from the dock.
- Toggle the dock from the Logseq toolbar.
- Toggle the dock with a keyboard shortcut.

## Best For

- Large reference review sessions with hundreds of candidates.
- Whiteboard synthesis workflows where references need triage before being dragged into the canvas.
- Users who want a persistent review queue instead of Logseq's live reference panel.
- Users who want to keep review progress on the whiteboard and optionally sync it through the graph.

## How To Use

1. Open a native Logseq whiteboard.
2. Toggle `Whiteboard RefDock` from the toolbar if the dock is hidden.
3. Choose `Page` or `Keyword`.
4. Click `Create Snapshot`.
5. Revisit any saved source from the `Saved sources` list.
6. Review items in the `Linked` and `Unlinked` tabs.
7. Drag useful items into the whiteboard.
8. Mark items as `seen`, `unseen`, or `skipped`.

Default shortcut:

- macOS: `Cmd+Option+R`
- Windows/Linux: `Ctrl+Alt+R`

## Storage and Sync

By default, Whiteboard RefDock uses local-only storage for the current graph.

If you enable `Enable graph sync` in plugin settings, the plugin will also write graph-backed state pages for:

- saved sources
- review state
- sync index links

Local cache is still used for:

- snapshot results
- scroll position
- dock width and UI state

Graph-backed sync does not turn the plugin into a remote service. It only persists review metadata inside the Logseq graph.

## Platform Support

- Desktop Logseq on macOS: supported
- Desktop Logseq on Windows/Linux: expected to work, but should still be validated in a real desktop runtime
- Web Logseq: not supported
- Database graph: not declared as supported

This plugin currently targets the desktop whiteboard workflow and relies on host-side dock behavior that is not available in the web sandbox.

## Why `effect: true`

This plugin uses `effect: true` because it needs same-origin host access for:

- a custom host-side whiteboard dock
- reliable dock visibility control across host and iframe surfaces
- drag-and-drop behavior that matches native whiteboard interactions

Without that access, the plugin cannot provide the current dock experience.

## Privacy

Whiteboard RefDock does not send graph data to external services.

By default, snapshots and review state are stored locally in the Logseq plugin state for the current graph.

If graph sync is enabled, saved sources and review state are also written into graph-backed state pages so they can travel with the graph.

## Authors

- FelixHuoEZ
- Codex

## Development

```bash
npm install
npm run build
```

## Release

Tag a version and create a GitHub release.

The included `.github/workflows/publish.yml` workflow will build the plugin and attach a release zip that is suitable for Logseq Marketplace submission.

## Marketplace Submission Notes

Marketplace-specific files are included under [`./marketplace`](./marketplace):

- `manifest.json`
- `SUBMISSION.md`

These files are intended to be copied into the `logseq/marketplace` submission PR.
