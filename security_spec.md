# Security Specification — PQTV Cloud Users, Invites & Channel Alerts

## 1. Data Invariants
1. Every document in `/users/{userId}`, `/invites/{inviteId}`, and `/channel_alerts/{alertId}` must have a valid alphanumeric/underscore/hyphen ID (`^[a-zA-Z0-9_-]+$`, max 128 chars).
2. Self-registered users without an invite can only create `/users/{request.auth.uid}` with `role == 'user'`, `enabled == false`, `playlists == []`, and `uid == request.auth.uid`. Users WITH a verified matching `/invites/{inviteId}` (where `/invites/{inviteId}/private/info.email == request.auth.token.email.lower()`) can only inherit the exact `playlists` and `enabled` specified by the admin on that invite — never arbitrary values or `role == 'admin'`.
3. Non-admin users can only read their own `/users/{uid}`, `/users/{uid}/private/info`, `/channel_alerts/{uid}`, and an `/invites/{inviteId}` whose `/private/info.email` strictly equals their verified `request.auth.token.email.lower()`. Blanket collection listing is forbidden for non-admins.
4. PII (`email`) is strictly isolated in `/users/{userId}/private/info` and `/invites/{inviteId}/private/info`.
5. `uid` / `emailHash` / `createdAt` are immutable after creation; `createdAt` and `updatedAt` must equal `request.time`.
6. All writes require verified email (`request.auth.token.email_verified == true`) and strict key allowlisting (`hasOnly`) + type/size bounds.

## 2. The "Dirty Dozen" Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read**: `GET /users/u_1` or `GET /invites/{hash}` or `GET /channel_alerts/u_1` without `request.auth`.
2. **Unauthenticated write**: `CREATE /users/u_1` or `/channel_alerts/u_1` without `request.auth`.
3. **Unverified email write**: `CREATE /users/{uid}` when `request.auth.token.email_verified == false`.
4. **Self-assigned admin role**: Non-admin creates `/users/{uid}` with `role: "admin"`.
5. **Self-enabled account without invite**: Non-admin creates `/users/{uid}` with `enabled: true` and no matching invite.
6. **Self-granted playlists without invite**: Non-admin creates `/users/{uid}` with `playlists: ["pqtv"]` and no matching invite (or mismatched playlists).
7. **Shadow / ghost field injection**: Create or update `/users/{uid}`, `/invites/{id}`, or `/channel_alerts/{id}` with extra field `isSuperAdmin: true`.
8. **Cross-user PII read**: User A reads `/users/userB/private/info` or `/invites/{otherHash}/private/info`.
9. **Blanket list scraping**: Non-admin runs `collection('/users')`, `collection('/invites')`, or `collection('/channel_alerts')` without owner/admin constraint.
10. **Immutable field mutation**: Update `/users/{uid}` or `/channel_alerts/{uid}` attempting to change `uid` or `createdAt`, or viewer trying to set `resolved: true` on `/channel_alerts/{uid}`.
11. **Oversized string / ID / array poisoning**: Create `/users/aaaa...200chars` or `items.size() > 50` or `playlists.size() > 20`.
12. **Client-forged timestamp**: Create `/users/{uid}`, `/invites/{id}`, or `/channel_alerts/{id}` with `createdAt` set to a past client timestamp instead of `request.time`.
