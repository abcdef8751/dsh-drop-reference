# dsh-drop-reference

A drop-in DSH plugin for the Web GUI: **a dropped file that is not an accepted
image becomes an `@` reference instead of an error.**

Stock DSH accepts exactly four image types in the composer
(`image/png`, `image/jpeg`, `image/webp`, `image/gif`). Anything else reaches
the same admission check and comes back `UNSUPPORTED_IMAGE_TYPE`. This plugin
takes those drops away from the image pipeline, writes the bytes next to the
session's working directory, and splices `@<path>` into the composer, so the
model's `read` tool can open the file.

```
drop report.pdf  →  <cwd>/.dsh-drops/report.pdf  →  composer gains  @.dsh-drops/report.pdf
```

## Why this needs a host half

An `@` reference is prompt text naming a path. A browser drag-and-drop hands the
page the file's bytes but never the path it came from, so the path has to be
created. That means the bytes must reach the host, and the host must write them
— which is why this is a two-face plugin rather than a client-only one.

It also means two DSH internals are used deliberately, and both are worth
knowing about if DSH is upgraded:

| Seam | Why it is needed | Failure mode if it changes |
| --- | --- | --- |
| `ctx.remote.$mount()` with a hand-written descriptor | The client may only call host services through mounted Typert contributions, and only the in-repo build generates those. | `apply` throws at load; the plugin is simply absent. |
| `@Remote` marker replayed by hand | The Host Gateway reaches plugin services only in SRC mode ("endpoints that have never had a strict definition"), which requires a prototype marker. | `dropFiles/commit` answers `invocation-unavailable`. |
| `conversation.input.shell(id).setDraft()` | The only composer write path that does not require a CSS-style compare-and-swap span. | Mentions stop being inserted; uploads still land. |

The client descriptor carries an identity codec. `$mount` requires
`codec.mode === "strict"` and a callable `schema.parse`, and never checks that
the schema came from the Typert generator, so a pass-through validates.

## Behaviour

| Drop | Result |
| --- | --- |
| Only accepted images | Untouched — the image pipeline keeps it. |
| No accepted images | Intercepted: uploaded, written, referenced. |
| Images mixed with other files | **Untouched** — still fails as before. The attachment store owns its media types end to end, and a drop cannot be split between two pipelines without re-implementing its draft-image admission. |

Per-file ceiling is 32 MB, refused in the browser before any upload.

## Install

The package is linked into the profile and enabled by one Loader row:

```sh
ln -s ~/dsh/dsh-drop-reference ~/.dsh/profiles/web/node_modules/dsh-drop-reference
```

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- insert:
    - id: drop-reference
      name: 'dsh-drop-reference'
      config:
        directory: '.dsh-drops'
```

`node_modules/` inside this package is not an accident: Node resolves a linked
package by its real path, so the peer links there are what let `lib/index.js`
import the *same* `@deepseek-ai/dsh-typert-protocol` instance the host is using.
A second instance would carry its own private marker table and the gateway would
see no Remote methods at all.

`exports` must keep publishing `"./package.json"`. The modules node half detects
the browser half with `require.resolve("<name>/package.json")`, so sealing that
subpath makes the plugin invisible to the browser with no error anywhere.

Adding a Loader row is a boot-time change: restart `dsh web` to activate.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `directory` | `.dsh-drops` | Absolute, or relative to each session's working directory. A path outside the working directory is mentioned absolutely. |
| `maxBytes` | `33554432` | Per-file host-side ceiling. |

## Tests

```sh
node test/smoke.mjs      # host: marker, SRC signature, write/dedup/traversal
node test/client.mjs     # browser: bundle registration, descriptor, drop routing
node test/gateway.mjs    # host: real gateway claims, resolves and dispatches the endpoint
```

Those three are offline. The fourth needs a booted instance of its own:

```sh
dsh --profile web --port 8391 --no-open &
node test/browser.mjs http://127.0.0.1:8391 /path/to/workspace
```

It drives real Chromium against the real GUI, dispatches real `DragEvent`s
carrying real `File`s, and asserts on the two places the result is observable —
the composer draft and the file on disk. Point it at a throwaway instance: a
successful drop writes a real file into that session's drop directory. It types
no prompt and sends nothing.

`test/gateway.mjs` mounts the shipped `dsh-typert-registry` and `dsh-api-gateway`
around the plugin and drives the wire-shaped entry point, so SRC discovery,
argument binding, and the write are exercised exactly as a real drop drives
them. Only the `agent` lookup is stubbed, because the real provider sits behind
the whole agent/session stack; the stub reproduces the declaration `dsh-agent`
registers, which is the part the plugin's signature depends on.

`test/client.mjs` loads the real bundle into a bare VM with no DOM, which is why
the overlay-cleanup `catch` branch prints a `DataTransfer is not defined`
warning during the run — that is the Node path, not a browser one.

## Known limitations

- **Mixed drops are not split.** Send images and documents as separate drops.
- **The mention is a path, not content.** Nothing is read into the prompt; the
  agent still has to call `read`.
- **`setDraft` replaces the draft rather than inserting at the caret.** The
  mention is appended; a concurrent keystroke between read and write is lost.
- **No retention policy.** Dropped files accumulate in the drop directory.
