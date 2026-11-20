# Security Specification — PQTV Full Cloud Database

## 1. Data Invariants
1. Every document across `/users/{userId}`, `/invites/{inviteId}`, `/channel_alerts/{alertId}`, `/cloud_meta/{docId}`, `/sources/{sourceId}`, `/source_index/{sourceId}`, `/epg_sources/{epgId}`, `/catalog_summary/{docId}`, `/catalog_chunks/{chunkId}`, `/catalog_stream_chunks/{chunkId}`, `/app_settings/{settingId}`, and `/admin_settings/{settingId}` must pass strict ID format checks (`^[a-zA-Z0-9_-]+$` max 128 chars, or valid playlist filename `^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$` for `/playlists/{playlistId}`).
2. Self-registered users without an invite can only create `/users/{request.auth.uid}` with `role == 'user'`, `enabled == false`, `playlists == []`, and `uid == request.auth.uid`. Users WITH a verified matching `/invites/{inviteId}` can only inherit the exact `playlists` and `enabled` specified by the admin on that invite.
3. Non-admin viewers can read ONLY:
   - Their own `/users/{uid}`, `/users/{uid}/private/info`, `/channel_alerts/{uid}`, and matching `/invites/{inviteId}`.
   - `/app_settings/streaming` (verified email only).
   - `/playlists/{playlistId}` and `/playlists/{playlistId}/chunks/{chunkId}` ONLY if their `/users/{uid}` document has `enabled == true` and `playlistId in playlists`.
4. All infrastructure & admin collections (`/cloud_meta`, `/sources`, `/source_index`, `/epg_sources`, `/catalog_summary`, `/catalog_chunks`, `/catalog_stream_chunks`, `/admin_settings`, `/users/{uid}/private/credentials`) are strictly **admin-only** (`isAdmin()` for get/write, `isBootstrappedAdmin()` for list, or `list: if false` for credentials/secrets).
5. `uid` / `emailHash` / `createdAt` / `id` / `playlistId` / `sourceId` / `settingId` are immutable after creation; `createdAt` and `updatedAt` must equal `request.time`.
6. Every write requires verified email (`request.auth.token.email_verified == true`), strict key allowlisting (`hasOnly`), string length bounds, and bounded list type guards. No `get()` or `exists()` calls are ever placed inside `allow list`.

## 2. The "Dirty Dozen" Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read**: `GET /users/u_1`, `GET /playlists/pqtv`, `GET /app_settings/streaming`, or `GET /sources/s1` without `request.auth`.
2. **Unauthenticated write**: `CREATE /playlists/pqtv` or `/app_settings/streaming` without `request.auth`.
3. **Unverified email write**: `CREATE /users/{uid}` when `request.auth.token.email_verified == false`.
4. **Self-assigned admin role**: Non-admin creates `/users/{uid}` with `role: "admin"`.
5. **Self-enabled account / playlists without invite**: Non-admin creates `/users/{uid}` with `enabled: true` or `playlists: ["pqtv"]` without a matching invite.
6. **Unauthorized playlist read**: Non-admin viewer reads `/playlists/secret/chunks/c_0` when `"secret"` is not in their `/users/{uid}.playlists` or `enabled == false`.
7. **Non-admin infrastructure tampering**: Non-admin creates/updates `/sources/{id}`, `/epg_sources/{id}`, `/catalog_summary/main`, `/app_settings/streaming`, or `/admin_settings/github`.
8. **Cross-user PII / credentials read**: Non-admin reads `/users/userB/private/info` or `/users/user1/private/credentials` or `/admin_settings/auth`.
9. **Blanket list scraping**: Non-admin runs `list` on `/users`, `/invites`, `/playlists`, `/sources`, `/source_index`, `/epg_sources`, `/catalog_chunks`, or `/admin_settings`.
10. **Shadow / ghost field injection**: Create or update any document with extra field `isSuperAdmin: true` or invalid `mode: "hacked"` on `/app_settings/streaming`.
11. **Oversized string / ID / array poisoning**: Create `/users/aaaa...200chars`, `items.size() > 250`, or `url.size() > 2000`.
12. **Client-forged timestamp**: Create `/playlists/pqtv`, `/sources/s1`, or `/app_settings/streaming` with `createdAt` not equal to `request.time`.
