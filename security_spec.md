# Security Specification — PQTV User Database

## 1. Data Invariants
1. Every document in `/users/{userId}` must have a valid alphanumeric/underscore/hyphen `userId` (`^[a-zA-Z0-9_-]+$`, max 128 chars).
2. Self-registered users can only create `/users/{request.auth.uid}` with `role == 'user'`, `enabled == false`, `playlists == []`, and `uid == request.auth.uid`. They cannot self-assign `role == 'admin'`, `enabled == true`, or arbitrary playlists.
3. Non-admin users can only read their own `/users/{uid}` and `/users/{uid}/private/info` documents. Blanket collection listing is forbidden; `allow list` restricts non-admins to `resource.data.uid == request.auth.uid`.
4. PII (`email`) is strictly isolated in `/users/{userId}/private/info` and never stored on `/users/{userId}`.
5. `uid` and `createdAt` are immutable after creation; `createdAt` and `updatedAt` must equal `request.time`.
6. All writes require verified email (`request.auth.token.email_verified == true`) and strict key allowlisting (`hasOnly`) + type/size bounds.

## 2. The "Dirty Dozen" Payloads (Must Return PERMISSION_DENIED)
1. **Unauthenticated read**: `GET /users/u_1` without `request.auth`.
2. **Unauthenticated write**: `CREATE /users/u_1` without `request.auth`.
3. **Unverified email write**: `CREATE /users/{uid}` when `request.auth.token.email_verified == false`.
4. **Self-assigned admin role**: Non-admin creates `/users/{uid}` with `role: "admin"`.
5. **Self-enabled account**: Non-admin creates `/users/{uid}` with `enabled: true`.
6. **Self-granted playlists**: Non-admin creates `/users/{uid}` with `playlists: ["pqtv"]`.
7. **Shadow / ghost field injection**: Create or update `/users/{uid}` with extra field `isSuperAdmin: true`.
8. **Cross-user PII read**: User A reads `/users/userB/private/info`.
9. **Blanket user list scraping**: Non-admin runs `collection('/users')` without `where('uid', '==', auth.uid)`.
10. **Immutable field mutation**: Update `/users/{uid}` attempting to change `uid` or `createdAt`.
11. **Oversized string / ID poisoning**: Create `/users/aaaa...200chars` or `name` > 80 chars or `playlists.size() > 20`.
12. **Client-forged timestamp**: Create `/users/{uid}` with `createdAt` set to a past client timestamp instead of `request.time`.
