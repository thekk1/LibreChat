# Patches on the built image

The commits on branch `bos` change the source of `v0.8.8`. These patches change files that are not in this
repository, or only exist in the built image `ghcr.io/librechat-ai/librechat:v0.8.8`. They are applied to a copy of
the file from the image, and the patched file is mounted read-only into the container.

| Patch | File in the image | Purpose |
|---|---|---|
| `ask-user-question-json.diff` | `packages/api/dist/index.cjs` | `ask_user_question` also accepts `questions` and `options` as JSON text |
| `subagent-result.diff` | `node_modules/@librechat/agents/dist/cjs/tools/subagent/SubagentExecutor.cjs` | a short last message of a subagent keeps its longest earlier text |
| `bash-command-size.diff` | `node_modules/@librechat/agents/dist/cjs/tools/BashExecutor.cjs` | clear error for bash commands above 120 000 bytes instead of "temporarily unavailable" |
| `tool-schema-errors.diff` | `node_modules/@langchain/core/dist/tools/index.cjs` | a schema error of a tool call names the field and the allowed values |
| `client-bundle-mkpatch.js` | chunks in `client/dist/assets` and `client/dist/sw.js` | file table with 100 rows per page, legal footer links in a new tab, new service worker revision |

`client-bundle-mkpatch.js` generates the patched chunks from the original files of the image:

```bash
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD/patches/client-bundle:/out" \
  --entrypoint node ghcr.io/librechat-ai/librechat:v0.8.8 /out/mkpatch.js /out
```

The chunk names carry the build hash, so these patches only fit this image.
