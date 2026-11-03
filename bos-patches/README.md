# Patches on the built image

The commits on branch `bos` change the source of `v0.8.8`. These patches change files that are not in this
repository, or only exist in the built image `ghcr.io/librechat-ai/librechat:v0.8.8`. They are applied to a copy of
the file from the image, and the patched file is mounted read-only into the container.

| Patch | File in the image | Purpose |
|---|---|---|
| `ask-user-question-json.diff` | `packages/api/dist/index.cjs` | `ask_user_question` also accepts `questions` and `options` as JSON text; every question needs at least two options |
| `subagent-result.diff` | `node_modules/@librechat/agents/dist/cjs/tools/subagent/SubagentExecutor.cjs` | a short last message of a subagent keeps its longest earlier text; `{{data:ID}}` in a request stays as written, is checked against `bosToolData.cjs` and gets its `[DATA ...]` line appended |
| `tool-data.diff`, `bosToolData.cjs` | `api/server/controllers/agents/callbacks.js`, new file next to `SubagentExecutor.cjs` | lists of 20 or more rows from any tool stay out of the parent agent: they are stored per user and chat in MongoDB (`bostooldata`, 30 days), the parent sees a `[DATA ...]` line and inserts them with `{{data:ID:column}}` in requests and answers; more than 100 rows become a `text/markdown` artifact |
| `tool-args.diff` | `packages/api/dist/index.cjs` (after `ask-user-question-json.diff` and `validation-feedback.diff`) | before any tool runs, for main agents and subagents: `{{data:ID:column}}` in its arguments becomes comma-separated values (a JSON array of strings if a value contains a comma, semicolon or line break), `{{data:ID:a,b}}` and `{{data:ID}}` a JSON array of objects; an unknown reference or a `{{toolNturnM}}` the SDK left unresolved returns an error and the tool does not run |
| `tool-files.diff`, `bosToolFiles.cjs` | `packages/api/dist/index.cjs`, `api/server/controllers/agents/callbacks.js`, `SubagentExecutor.cjs`, `bosToolData.cjs` (after the patches above), new file next to `SubagentExecutor.cjs` | files in MCP tool results (images, embedded resources with `blob`, JSON fields `content_base64`) become chat files (`bostoolfiles`, 30 days) and reach the model as `[FILE F-... | name | type | size | source]`; `{{file:ID}}` or `{{file:<name>}}` in tool arguments becomes the base64 content (`:name`, `:mime`, `:size`, `:file_id` that field), in code execution the path under `/mnt/data`, in the answer an inline Markdown image for images and videos (stored under `/images`) and a download link `files/<user>/<file_id>/<name>` for other files; a subagent request also lists the newest data sets and files of the chat, and a subagent result keeps the `[FILE]` lines of its tool results |
| `original-images.diff` | `api/server/services/Files/Local/images.js`, `api/server/services/Files/process.js`, `packages/api/dist/index.cjs` (after `tool-files.diff`) | PNG, JPEG, GIF and WebP from uploads and code execution are stored unchanged instead of resized and re-encoded, with type and size (after EXIF orientation) of the stored bytes; only for the model the image is resized as before (`resizeImageBuffer` with `high`) when it is larger or carries an EXIF orientation; HEIC/HEIF is converted as before |
| `mcp-request-timeout.diff` | `packages/api/dist/index.cjs` (after `tool-args.diff`) | a tool call that exceeds the server `timeout` fails alone: the headers timeout of its POST no longer rebuilds the user's connection to that MCP server, which closed every parallel call with "Connection closed" |
| `bash-command-size.diff` | `node_modules/@librechat/agents/dist/cjs/tools/BashExecutor.cjs` | clear error for bash commands above 120 000 bytes instead of "temporarily unavailable" |
| `tool-schema-errors.diff` | `node_modules/@langchain/core/dist/tools/index.cjs` | a schema error of a tool call names the field and the allowed values |
| `validation-feedback.diff` | `packages/api/dist/index.cjs` (same file as `ask-user-question-json.diff`) | the schema error of a tool in the graph counts undeclared arguments and names the declared ones, checks `integer` and `enum` and every field |
| `client-bundle-mkpatch.js` | chunks in `client/dist/assets` and `client/dist/sw.js` | file table with 100 rows per page, legal footer links in a new tab, videos in markdown images (`.mp4`, `.webm`, …) as a video player, new service worker revision |

`client-bundle-mkpatch.js` generates the patched chunks from the original files of the image:

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/patches/client-bundle:/out" \
  --entrypoint node ghcr.io/librechat-ai/librechat:v0.8.8 /out/mkpatch.js /out
```

The chunk names carry the build hash, so these patches only fit this image.
