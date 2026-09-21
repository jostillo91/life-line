# Architecture

React and TypeScript render small domain-focused UI components. Dexie provides IndexedDB tables with schema version 1 and is isolated in `src/db.ts`; the interface reads and writes through this boundary. Domain types are in `src/types.ts` and timeline ordering/date labels are in `src/date.ts`.

The timeline renders sorted event-date entries horizontally. Date-less and age-based items remain in Unsorted Memories. `mediaIds` is an abstraction only: a future media table can store local blob, URL, or cloud-backed metadata without modifying entries.

Editor drafts use local storage only while a new entry is unfinished; existing entries are debounced into IndexedDB. The small undo surface stores a reversible action in UI state. Entity deletion removes references from entries transactionally before removing the entity, so memories are preserved.

Timeline drag/drop opens a compact confirmation step rather than guessing a date. That dialog starts from the existing uncertain-date model and only updates event-date fields. Its inverse action is stored for lightweight undo.

Media metadata is held in the Dexie `media` table, separate from entry records. Binary bytes use the media-storage service and a separate `mediaFiles` table keyed by stable storage keys; writes save bytes before metadata in one transaction. The service checks browser quota and exposes object-URL lifecycle helpers. A future OPFS/cloud provider can implement the same service boundary.

The storage service now owns browser image thumbnail generation and preview URL lifecycle. Thumbnails are separate binary records; original media is never resized or rewritten.
