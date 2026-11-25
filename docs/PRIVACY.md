# Privacy Policy — Doorking Gate

**Last Updated:** November 2026

Doorking Gate (the **Android app** `com.doorking.gate`, its companion **Web UI**, and the **MCP server** `@rouing/doorking-mcp`) is a self-hosted client for managing DoorKing telephone-entry gate systems. Your data is stored solely on the self-hosted DoorKing server operated by your community, property manager, or organization—not by the app developer.

## 1. Information Processed by the App

Depending on your role (Administrator, Editor, Read-Only Staff, or Resident) and the features enabled on your community's server, the app may access and display:

- **Account & Authentication Data:** Username, email address (used for invitations, email verification, password resets, or optional Single Sign-On), passkey public credentials (stored via Android Credential Manager / WebAuthn), and an encrypted local session credential stored in Android Keystore.
- **Hardware Biometric Signing Keys (Android):** When you sign in on Android with biometrics enabled, the app generates a hardware-backed Android Keystore ECDSA P-256 signing keypair (`AUTH_BIOMETRIC_STRONG`) and sends only the random key ID (`and-<uuid>`), the public key (SPKI), and a device model label (`Manufacturer Model`) to your self-hosted DoorKing server (`POST /api/me/biometric-keys`). This public key is used to verify cryptographic signatures for step-up authentication and push passkey approvals. Your fingerprint or biometric template never leaves your device's secure hardware, and the private key cannot be exported.
- **Directory & Gate Access Data:** Resident/vendor display names, directory codes, phone numbers used by the call box, keypad entry codes, assigned card/remote numbers, and unit notes configured by your property administrator.
- **Gate Activity & Optional Camera Media:** Access event timestamps, entry results, and—where configured by your property administrator—camera snapshots or video clips captured by the community's gate cameras.
- **Resident Self-Service Requests:** Change requests or suspicious-activity reports you explicitly submit to your property administrator.
- **Android Auto, Home Screen Widgets, Quick Settings Tiles & Android 16+ AppFunctions:** On Android, your authorized gate and entrance relay names, cooldown timers, and availability statuses are cached locally on your device to power Home Screen Widgets, Quick Settings Tiles, Android Auto (`androidx.car.app.category.IOT`), and—on Android 16+—system AppFunctions voice queries (`listOpenableGateRelays`, `getGateStatus`, `openGateRelay`). Opening a gate via Widgets, Quick Settings Tiles, or AppFunctions honors your app-lock and per-gate passkey step-up requirements.
- **Connected AI Clients (MCP OAuth):** If you authorize an external AI assistant (such as Google Gemini or Claude) via OAuth 2.1, your DoorKing server records a scoped grant (`sessions.mcp_grant`) limited to the specific gate entrances and permissions you select. You can view and revoke any connected AI client at any time under **User Settings → Connected AI Clients** (`GET / DELETE /api/me/ai-clients`).
- **Opt-In Crash Diagnostics:**
  - **Self-Hosted Crash Reports (`POST /api/client-crashes`):** If the Android app encounters an unhandled crash, the trace is saved locally on your device and is **only** sent to your configured DoorKing server if you explicitly tap **"Send crash report"** on the crash screen. Before upload, the stack trace is scrubbed of session credentials, query strings, emails, and phone numbers.
  - **Firebase Crashlytics (Opt-In Only):** Google Firebase Crashlytics (including its Firebase Sessions diagnostic telemetry) is **disabled by default** in the Android manifest and at startup. It only collects crash stack traces, device model, Android OS version, and session diagnostic identifiers if you explicitly opt in via **Account Settings**.
- **Opt-In Push Notification Identifiers (FCM):** Firebase Cloud Messaging (FCM) auto-initialization is **disabled by default** until you explicitly enable push notifications. When enabled, the app uses an FCM registration identifier and Firebase Installation ID solely to deliver gate alerts and 2-digit number-matching passkey approval prompts from your configured DoorKing server.

## 2. How Information Is Used

Information is used exclusively to:
- Authenticate your account and verify sensitive gate actions (including passkey and hardware-backed biometric step-up verification).
- Display and manage your community's gate directory, schedules, board settings, and access history.
- Perform user-initiated gate actions (such as "Buzz Me In" from the app, Web UI, Widgets, Quick Settings Tiles, Android Auto, Android 16+ AppFunctions, or an authorized MCP AI client, as well as administrator-approved syncs to DKS Cloud).
- Deliver optional gate alerts and push passkey approval prompts when enabled on your account.
- Diagnose and fix application crashes when you explicitly submit a crash report or opt in to crash diagnostics.

## 3. Data Sharing & Third Parties

- **No Advertising or Behavioral Analytics:** The app contains **no** third-party advertising SDKs, behavioral analytics trackers, or data brokers, and we never sell or rent personal data.
- **Firebase (Opt-In Push Notifications & Opt-In Crash Diagnostics):** The Google Play Android app includes **Firebase Cloud Messaging (FCM)** and **Firebase Crashlytics**, both disabled by default. FCM is activated only when you enable push notifications to deliver gate alerts and passkey approval prompts (notification payloads never include secret gate keypad codes). Crashlytics (and its bundled Firebase Sessions library) is activated only if you opt in under Account Settings.
- **External AI Clients (User-Authorized MCP):** Data is shared with an external AI client only when you explicitly complete an OAuth 2.1 consent flow granting that client access to your selected gate relays or activity.
- **DKS Cloud & Infrastructure:** Your self-hosted server communicates with DoorKing's DKS Cloud service solely to pull/send gate configuration, access logs, and relay states on behalf of your gate administrator. If your server administrator configures SMTP email, OIDC Single Sign-On (e.g., Google), or Web/FCM push notifications, authentication or notification payloads pass through those configured providers only as needed to deliver the service.

## 4. Data Storage, Security & Retention

- All communication between the Android app, Web UI, MCP clients, and your server uses HTTPS/TLS.
- On Android, your session credential is encrypted at rest using AES-256-GCM backed by Android Keystore (`EncryptedSessionStore`), and biometric step-up keys are stored inside hardware-backed Android Keystore (`BiometricKeyManager`).
- Server-side retention of access logs, camera snapshots, audit logs, and resident records is controlled by your property administrator on their self-hosted server.

## 5. Your Choices & Data Deletion

- **Sign Out & Local Data:** Signing out inside the app immediately revokes your server session, unregisters your push notification device, deletes your local biometric signing key, and clears your locally stored session credential and widget/tile cache. Uninstalling the app removes all local app data from your device.
- **Revoking Connected AI Clients, Passkeys & Push Devices:** You can revoke any connected AI client, passkey, hardware biometric key, or push notification device at any time from **User Settings / Account Settings** in the Web UI or Android app.
- **Opting Out of Crash Diagnostics & Push Notifications:** You can disable Firebase Crashlytics or push notifications at any time in **Account Settings** on Android.
- **Account or Record Deletion:** Because your community's self-hosted server owns and controls your resident directory entry and user account, please contact your property manager or system administrator to update or delete your account, email address, phone number, or access records.

## 6. Contact

For questions about your community's gate records or privacy practices, contact your property manager or the administrator of your DoorKing server. For technical questions about the open-source Doorking Gate software, open an issue in the project repository.
