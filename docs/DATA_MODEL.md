# Data model

`Entry` is the central record. It holds immutable `id`, `recordTime`, `createdAt`, and mutable `updatedAt`, alongside references to people, places, tags, media, and related entries. Updating event time never changes record time.

`eventDate` separates `precision` (exact, month, year, approximate, range, season, age, or unknown) from `confidence` (confirmed, likely, approximate, guess, unknown). It supports optional start/end ISO values, season, age, and a future display value. People, Places, Tags, and LifeEras are independent reusable records.

Deleting a Person, Place, or Tag removes only that ID from referencing entries; entries themselves remain unchanged otherwise. New-entry drafts are transient local storage records and never become empty database entries.

Date movement preserves an entry's ID, record timestamp, creation timestamp, content, and relationships. The event-date object is copied whole for undo, retaining precision, confidence, season, range, or age metadata.

`Media` records have stable IDs, type, filename, MIME type, byte size, import time, optional descriptive/capture metadata, and an opaque storage key. Entry `mediaIds` form the relationship; binary files are deliberately excluded from JSON exports. Unattached media remains a future-safe orphan record until explicitly deleted.

The order of `mediaIds` on an Entry is the attachment order. Detaching only removes that relationship, leaving the Media record and binary available for another entry or the Media Library.
