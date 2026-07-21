# Illustrations (CDN / release assets)

Binary art is **not** stored in this git tree (clone weight + history bloat).
Sources live on disk under this directory for authors; readers get them from a
**GitHub Release** (or any CDN that mirrors the same filenames).

## Public base URL

After you publish the release tag `docs-assets-v1` with the WebP files below:

```text
https://github.com/rfxlamia/agent-pair-protocol/releases/download/docs-assets-v1/
```

Root [README.md](../../README.md) embeds each file under a **collapsible
section** (`<details>` / `<summary>` — disclosure widget). Images stay hidden
until the reader clicks the row.

```text
{BASE}/{name}.webp
```

Example:

```text
https://github.com/rfxlamia/agent-pair-protocol/releases/download/docs-assets-v1/problem.webp
```

To use another host (R2, S3, Cloudinary), keep the **same filenames** and
search-replace that base in `README.md`.

## Catalog

| File | Topic | Use in README |
|------|--------|----------------|
| `problem.webp` | Messenger tax vs trust tax | **Always visible** under Why → 10-second problem |
| `architecture.webp` | Brain / vault / dumb pipe | Diagrams (collapsed) |
| `comparison.webp` | Copy-paste vs SaaS vs AgentPair | Diagrams (collapsed) |
| `lifecycle.webp` | Pair → negotiate → ratify | Diagrams (collapsed) |
| `protocol.webp` | Envelope v1 exploded | Diagrams (collapsed) |
| `spillover.webp` | 64 KiB cap + artifact spill | Diagrams (collapsed) |
| `profiles.webp` | core/1 · nego/1 · atest/1 | Diagrams (collapsed) |
| `quick-start.webp` | `npx agentpair` + 3 steps | Diagrams (collapsed) |

PNG masters (optional, same stems) stay local for re-export; prefer **WebP** on
the release (~1.6 MB total vs ~13 MB PNG).

## Publish checklist (one-time)

From repo root, with `gh` authenticated:

```bash
# 1) Compress (if you changed masters)
cd docs/img
for f in problem architecture comparison lifecycle protocol spillover profiles quick-start; do
  cwebp -q 82 "${f}.png" -o "${f}.webp"
done
cd ../..

# 2) Create release + upload WebPs only
gh release create docs-assets-v1 \
  docs/img/*.webp \
  --title "Docs illustrations v1" \
  --notes "Marketing diagrams for README (not part of the protocol tree)."
```

Re-upload after edits:

```bash
gh release upload docs-assets-v1 docs/img/*.webp --clobber
```

## Local preview

Open the `.webp` files in a browser or image viewer. Git ignores them; they will
not appear in `git status` once `.gitignore` is applied (except this README).
