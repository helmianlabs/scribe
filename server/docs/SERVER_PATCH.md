# Wiring the Librarian into the v1.1.0 server

The live server source is not in this repo yet (SSH to the box was denied for the keys available on 2026-10-22).
Once `server.src/` exists, the patch is small:

1. `npm run build` here -> `dist/librarian.mjs` (one file, only dependency is the `pg` pool the server already has).
   Copy it into the server as `lib/librarian.mjs`.
2. In the `save_memory` handler, after the INSERT into `messages`, add `RETURNING id` (if not already) and then:
   ```js
   import { fileMessage, LIBRARIAN_TOOLS, listUnsorted, explainFiling, moveMemory, addPlainRule } from './lib/librarian.mjs';
   const filing = await fileMessage(writePool, { id: row.id, text, sender: 'assistant', conversationName: notebookName, source });
   // include filing?.category and filing?.explanation in the tool result text
   ```
   `fileMessage` never throws; if filing fails the memory is still saved and shows in the unsorted tray.
3. Register the four tools in `LIBRARIAN_TOOLS` (scope shown on each): read tools use the read pool,
   write tools use the `DATABASE_WRITE_URL` pool and must be gated on `memory.write`, the same way save_memory is.
4. Optionally: let `search_memory` accept `category` and join `memory_current_filing`.
