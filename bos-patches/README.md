# Patches on the built image

The commits on branch `bos` change the source of `v0.8.8`. These patches change files that are not in this
repository, or only exist in the built image `ghcr.io/librechat-ai/librechat:v0.8.8`. They are applied to a copy of
the file from the image, and the patched file is mounted read-only into the container.

| Patch | File in the image | Purpose |
|---|---|---|
| `ask-user-question-json.diff` | `packages/api/dist/index.cjs` | `ask_user_question` also accepts `questions` and `options` as JSON text; every question needs at least two options |
| `subagent-result.diff` | `node_modules/@librechat/agents/dist/cjs/tools/subagent/SubagentExecutor.cjs` | a short last message of a subagent keeps its longest earlier text; `{{data:ID}}` in a request stays as written, is checked against `bosToolData.cjs` and gets its `[DATA ...]` line appended |
| `tool-data.diff`, `bosToolData.cjs` | `api/server/controllers/agents/callbacks.js`, new file next to `SubagentExecutor.cjs` | lists of 20 or more rows from any tool stay out of the parent agent: they are stored per user and chat in MongoDB (`bostooldata`, 30 days), the parent sees a `[DATA ...]` line and inserts them with `{{data:ID:column}}` in requests and answers; more than 100 rows become a `text/markdown` artifact |
| `tool-args.diff` | `packages/api/dist/index.cjs` (after `ask-user-question-json.diff` and `validation-feedback.diff`) | before any tool runs, for main agents and subagents: `{{data:ID:column}}` in its arguments becomes comma-separated values, `{{data:ID:a,b}}` and `{{data:ID}}` a JSON array of objects; an unknown reference or a `{{toolNturnM}}` the SDK left unresolved returns an error and the tool does not run |
| `mcp-request-timeout.diff` | `packages/api/dist/index.cjs` (after `tool-args.diff`) | a tool call that exceeds the server `timeout` fails alone: the headers timeout of its POST no longer rebuilds the user's connection to that MCP server, which closed every parallel call with "Connection closed" |
| `bash-command-size.diff` | `node_modules/@librechat/agents/dist/cjs/tools/BashExecutor.cjs` | clear error for bash commands above 120 000 bytes instead of "temporarily unavailable" |
| `tool-schema-errors.diff` | `node_modules/@langchain/core/dist/tools/index.cjs` | a schema error of a tool call names the field and the allowed values |
| `validation-feedback.diff` | `packages/api/dist/index.cjs` (same file as `ask-user-question-json.diff`) | the schema error of a tool in the graph counts undeclared arguments and names the declared ones, checks `integer` and `enum` and every field |
| `client-bundle-mkpatch.js` | chunks in `client/dist/assets` and `client/dist/sw.js` | file table with 100 rows per page, legal footer links in a new tab, new service worker revision |

`client-bundle-mkpatch.js` generates the patched chunks from the original files of the image:

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/patches/client-bundle:/out" \
  --entrypoint node ghcr.io/librechat-ai/librechat:v0.8.8 /out/mkpatch.js /out
```

The chunk names carry the build hash, so these patches only fit this image.
