# Operating Model Explorer

A dependency-free (HTML + CSS + vanilla ES modules) web app for exploring the Collibra operating model: asset type hierarchy, assigned attributes, relation types, complex relations and the assets themselves. Built from [`../MCP/operating-model-explorer-spec.md`](../MCP/operating-model-explorer-spec.md).

## Deployment

1. Copy this folder to the Collibra `images` folder: `<collibra data dir>/dgc/images/om-explorer/`.
2. Open `https://<collibra-host>/images/om-explorer/index.html` in a browser where you're signed in to Collibra.

- **No credentials anywhere.** The app uses the browser's Collibra session (`credentials: 'same-origin'`) and sends the CSRF token from `GET /rest/2.0/auth/sessions/current?include=csrfToken&include=user` as `X-CSRF-TOKEN` on every POST (GraphQL).
- Signed-out users get a sign-in prompt. Collibra itself also redirects unauthenticated requests for `/images/**` to `/signin`.
- **Module mode:** native ES modules (`<script type="module">`). Collibra serves `.js` as `application/javascript` (verified on the Sandbox instance, 2026.06), so no single-file fallback is needed.
- **Do not deploy `tests/` to production.** It contains fixtures recorded from Sandbox and development tools.

### Base URL override

API calls go to `window.location.origin`. To point a locally served copy at another Collibra origin, set:

```html
<meta name="collibra-base-url" content="https://host:port">
```

Browsers only send the Collibra session cookie to the same origin, so for local development use the dev proxy (below) instead.

## Features (spec cross-reference)

| Spec | Where |
|---|---|
| §2 session, CSRF, 401/403/5xx handling, backoff | `js/api/http.js` |
| §3 pagination (offset + cursor, ≤ 1000), request queue (6, interactive > background, abort) | `js/api/rest.js`, `js/api/queue.js`, `js/api/graphql.js` |
| §4.1 metadata load + sessionStorage cache (60 min, per origin + user) | `js/main.js` (`loadMeta`), `js/model/store.js` |
| §4.2 assignment normalization, direction, scopes, inheritance | `js/model/assignment.js` |
| §5.2 tree (ARIA, keyboard, filter, `/` and Ctrl/Cmd+K) | `js/ui/tree.js`, `js/model/hierarchy.js` |
| §5.3 visualization (orbital + columns, pan/zoom, hover, keyboard, animation) | `js/ui/viz.js`, `js/ui/layout.js` (pure geometry) |
| §5.4 details and drill-down | `js/ui/details.js` |
| §5.5 reverse index | `js/model/indexer.js` |
| §6 asset search + CSV | `js/ui/search.js` |
| §8 export (SVG/PNG/PDF/JSON) and print | `js/ui/export.js`, `js/util/pdf.js`, `css/print.css` |
| §9 rich-text sanitizer | `js/util/sanitize.js` |

### Implementation notes (verified against Sandbox)

- `/rest/2.0/assetTypes` leaves out meta types by default, including the **Asset** root. Missing parents are fetched individually (`withMissingParents`) so the tree has a single root and inheritance can be traced back to Asset.
- Assignments are read from `assignedCharacteristicTypeReferences`, falling back to the deprecated `characteristicTypes`. `relationTypeDirection` `TO_TARGET` means the selected type is the source (outgoing, shows the role); `TO_SOURCE` means incoming (shows the co-role).
- The **default status** is the first status in the assignment. `defaultStatusId` is deprecated and ignored.
- `assignmentInheritances` comes back empty, so "inherited from" is worked out by comparing against each ancestor's own assignment.
- **Reverse lookups** use `GET /rest/2.0/assignments/forResource?resourceId=…&resourceDiscriminator=AttributeType|RelationType|ComplexRelationType` directly. The background crawl only runs if that endpoint fails.
- **Workflows:** `/workflowDefinitions` has no asset-type filter, so definitions are filtered client-side on `assetAssignmentRules` (honouring `exactResourceTypeMatch`).
- **Counts** use offset mode with `limit=1&countLimit=-1`, because cursor mode skips counting.
- **GraphQL search:** `contains` is case-insensitive, and all filters go through the `$where: AssetFilter` variable.
- **"Open in Collibra" links:** `/assettype/{id}` and `/asset/{id}`. Collibra has no UI route for attribute or relation types.

## Testing

Everything runs with Node ≥ 18 and a local Chrome. There are no npm dependencies. Run the commands from this folder.

| Suite | Command | What it covers |
|---|---|---|
| Unit | `node --test 'tests/unit/*.test.mjs'` | Pagination, queue, HTTP retry/CSRF/401/403, GraphQL where-builder, hierarchy, filter performance, assignment normalization and direction, inheritance, reverse index, storage, router, layout (no overlaps at 0–150 nodes), CSV, PDF structure, sanitizer URLs; lint checks for `innerHTML`/`eval`, external URLs and broken imports |
| Contract (live, read-only) | `node tests/contract/probe.mjs [--record]` | 20 checks against Sandbox through the app's own REST/GraphQL modules. `--record` refreshes `tests/fixtures/` |
| MCP cross-check | `node tests/contract/mcp-golden.mjs ["Type" …]` | Compares attributes, relation types, directions and statuses with the Woffles MCP server's `describe_asset_type` |
| Browser (DOM + live) | open `/images/om-explorer/tests/browser/index.html` while signed in | Sanitizer XSS payloads, tree ARIA/keyboard, viz interaction, details, export SVG/PNG/PDF, live session/CSRF/GraphQL |
| Dev proxy / E2E | `node tests/e2e/dev-proxy.mjs 8766`, then open `http://127.0.0.1:8766/` | Runs the real app locally against Sandbox through a loopback proxy, without touching your browser session |

Contract tests read `../MCP/config.json` (instance `Sandbox`). Override with `COLLIBRA_CONFIG_PATH` / `OM_INSTANCE`. Through the dev proxy, the browser test "session returns csrfToken" is expected to fail: the proxy uses Basic auth, which issues no CSRF token.

Headless run of the browser suite (DOM only):

```sh
node tests/e2e/dev-proxy.mjs 8766 &
google-chrome --headless=new --virtual-time-budget=120000 --dump-dom \
  'http://127.0.0.1:8766/tests/browser/index.html?live=0' | grep -o 'id="summary"[^<]*'
```

### Manual acceptance checklist (spec §12)

- [ ] DevTools → Network shows requests only to the Collibra origin.
- [ ] In a private window, the signed-out view appears with no console errors.
- [ ] The tree starts collapsed. Filter "data set" reveals Asset › Data Asset › Data Set. Keyboard-only navigation works.
- [ ] Selecting a type refreshes the viz and details. Selecting an attribute or relation refreshes only the details.
- [ ] Attribute → "Asset types that also use this attribute" → clicking a type navigates there with the attribute highlighted.
- [ ] Asset search with and without subtypes. Infinite scroll on a type with more than 1,000 assets (e.g. Column). Links open in Collibra.
- [ ] PNG, PDF, SVG and JSON exports each include the viz and the details. Print gives the viz on page 1, then details.
- [ ] Check at 1920 / 1440 / 1024 / 768 / 390 widths, in light and dark themes, and with OS "reduce motion" on.
- [ ] Pan and zoom stay smooth on a large type (Column: 51 attributes).
