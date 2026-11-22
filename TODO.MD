# TODO

Open work, unverified hardware tests, and backlog items.

## Security & tests
- [ ] **Passkey step-up on live relay control:** add `PUT /api/gates/:phone/relays` to `STEP_UP` in `web/requests.ts` so holding a gate open requires a recent passkey confirmation (same as Send to gate).
- [ ] **Missing route & unit tests:**
  - Live relays (`GET` / `PUT /api/gates/:phone/relays`)
  - HTTP password reset and invitation acceptance flows
  - `POST /api/gates/:phone/delete-data` full cleanup verification (beyond the busy-refusal test)
  - Forced password change cleared for accounts linked to a `passwords: false` SSO provider
  - `recordGateState` rebuild check with master code
  - `doorKingCsv` export format

## Physical gate & hardware checks (unverified against a real gate)
- [ ] **First real Send to gate built from values:** test a small working-copy change end to end with a post-send verify pull.
- [ ] **Middle-entry pointer (`names.bin` `0xF8`):** live gate holds `0x141C` (entry 59) where `updateMiddlePointer()` computes `0x1430` (entry 60). Procedure: note the first name shown when browsing on the gate → hide/show one resident on the gate or in DoorKing32 → Pull residents → note the new first name and compare `0xF8` with the formula.
- [ ] **New / removed directory codes on a real gate:** confirm a send adding and removing a code matches on the subsequent pull.
- [ ] **Tracker relays 3–18 live switching:** verify `SetRelays` on expansion banks against a Tracker-equipped gate.
- [ ] **10 Area Codes resized send:** verify DKS Cloud accepts a `63104`-byte `names.bin` and check what layout a pull returns.
- [ ] **Master code containing `0`:** confirm `0x00` encoding against a real gate pull (`FUN_0045b490` writes `0x00`, newer firmware sends `AAAA`).
- [ ] **Read-only board settings:** confirm `dialType` (`0x0F`) and `multipleSystems` (`0x06`) via one-change diffs before making them editable; investigate unexplained bytes `0x13`–`0x14`, `0x37`, `0x43`, `0xC5`.
- [ ] **Dahua video mode edge cases:** test the gap-skip / resume path and browser H.265 playback across a full app snapshot run.

## Features & roadmap
- [ ] **Web Push notifications** to installed apps (PWA) for failed sends and scheduled transfers (VAPID keys in `config.json`, subscription table, `push` handler in service worker via `injectManifest`, toggle in User Settings).
- [ ] **Single sign-on enhancements:**
  - Count strong SSO logins toward step-up (requires provider `amr`/`acr` or Entra `acrs` + `auth_time`)
  - Optional per-gate "strong sign-in required for admins"
  - Optional Entra / Google group-to-gate-role mapping and an SSO badge in Gate users
  - Configure and test against a real Entra ID or Google Workspace tenant
- [ ] **Incremental transaction pulls:** send the last-read 12-byte marker instead of `ZERO_MARKER` so pulls fetch only new events rather than the full 10,000-event buffer.
- [ ] **Multi-channel live camera view:** handle queued streams on `dahua-p2p` (one stream at a time) so simultaneous viewers don't hit ffmpeg's 45 s open timeout.
- [ ] **Non-Cellular DKS communication types:** add `comType` option in `gateConfig` (currently hardcoded to `'DKS Cellular'`).
- [ ] **Automated PostgreSQL backups** (`pg_dump` + `doorking.key` rotation/offsite copy).

## Code cleanup (low priority)
- [ ] Split remaining large modules/components if they keep growing (`gatesRoutes`, `createSnapshots`, `createAuth`, large settings page components) and simplify remaining nested ternaries.
