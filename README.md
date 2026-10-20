# amai-backend

Node.js 22 · Express 4 · Socket.IO 4 · Prisma 7 (driver adapter `@prisma/adapter-pg`) · PostgreSQL 16 · Redis 7 · BullMQ · Firebase Admin.

## Scripts

| | |
|---|---|
| `npm run dev` | watch mode (tsx) |
| `npm run build` | `prisma generate` + `tsc` → `dist/` |
| `npm start` / `npm run start:worker` | API / background worker |
| `npm run migrate:deploy` | apply migrations with Prisma |
| `npm run db:apply-sql` | apply the same migrations without the Prisma engine (records them in `_prisma_migrations`) |
| `npm run provision -- --slot 1 --email a@b.c` | create/re-invite an account (`--reset-password`, `--list`) |
| `npm run seed:dev` | two dev accounts (never in production) |
| `npm test` | integration tests (Postgres `amai_test` + Redis db 15) |
| `npm run typecheck`, `npm run audit:deps` | |

Tests expect a local Postgres user `amai` / `amai_dev` with `CREATEDB` and Redis on 6379; override with `TEST_DATABASE_URL`, `TEST_REDIS_URL`.

## REST API (`/api/v1`, Bearer access token unless noted)

| Method & path | Purpose |
|---|---|
| POST `/auth/setup` *(public)* | email + one-time code + password (+ name) → tokens |
| POST `/auth/login` *(public)* | email + password → tokens |
| POST `/auth/refresh` *(public)* | rotate refresh token |
| POST `/auth/logout`, `/auth/change-password` | |
| GET `/users/me`, `/users/partner` · PATCH `/users/me` | profile (partner presence respects privacy) |
| PUT/DELETE `/users/me/avatar` · GET `/users/:id/avatar-url` | photo (JPEG/PNG/WebP, magic-byte checked) |
| GET `/conversation` | id, partner, unread count, last message |
| GET `/messages?before&after&limit&pinned` · GET `/messages/sync?since` | history / changes since sequence |
| POST `/messages` · PATCH/DELETE `/messages/:id` | send (idempotent on clientId) / edit / delete for everyone |
| PUT `/messages/:id/reaction`, `/messages/:id/pin` · POST `/messages/receipts`, `/messages/read-all` | |
| GET `/media/limits` · POST `/media/uploads`, `/media/uploads/:id/complete` · GET `/media/:id/url` | encrypted media |
| GET/POST `/statuses` · POST `/statuses/:id/view` · DELETE `/statuses/:id` | |
| PUT `/keys/identity` · GET `/keys/me`, `/keys/partner`, `/keys/history` · PUT/GET/DELETE `/keys/backup` | E2EE keys |
| GET/PATCH `/settings`, PATCH `/settings/theme` | |
| GET `/devices` · PUT/DELETE `/devices/push-token` | |
| GET `/calls/ice-servers`, `/calls` · POST `/calls`, `/calls/:id/accept`, `/calls/:id/end` | |
| GET `/calls/recordings` · PUT/DELETE `/calls/recordings/:id` | |
| GET `/health` *(public)* | DB + Redis check |

## Socket.IO events

Connect with `auth: { token: <access token> }`. Client → server (all acknowledged with `{ok, data | error}`):
`message:send|edit|delete|react|pin|receipts|read-all|sync`, `typing`, `presence:state`, `presence:get`, `location:live`, `call:start|accept|end|signal`, `call:recording-request|recording-consent|recording-stop`.

Server → client: `message:new`, `message:updated`, `receipt:update`, `typing`, `presence:update`, `profile:updated`, `privacy:changed`, `keys:changed`, `status:new|viewed|deleted`, `location:live`, `call:incoming|outgoing|accepted|ended|signal`, `call:recording-*`, `session:revoked`.
