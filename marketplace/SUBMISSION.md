# Marketplace Submission Notes

This directory contains the files and notes needed for a `logseq/marketplace` submission.

## Files

- `manifest.json`: copy this into `packages/logseq-whiteboard-refdock/manifest.json` in the Marketplace repo.

## Recommended Submission Notes

Use the following points in the Marketplace PR description:

- The plugin adds a dedicated right-side dock for reviewing whiteboard-related reference snapshots.
- It supports separate `Linked` and `Unlinked` review tabs.
- It supports dragging page and block items into the native Logseq whiteboard.
- It uses `effect: true` because it needs host-side same-origin access for the dock surface and native-feeling whiteboard drag workflow.
- It is intended for desktop Logseq and is not submitted as a web plugin.

## Pre-Submission Checklist

- Create a tagged GitHub release such as `v0.1.0`.
- Wait for the `publish.yml` workflow to attach `logseq-whiteboard-refdock.zip`.
- Confirm the release includes:
  - the generated plugin zip
  - `package.json`
- Confirm the README is visible and includes a preview image.
- Confirm the repository includes `LICENSE`.
