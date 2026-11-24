# Privacy Policy — Doorking Gate

**Last Updated:** November 2026

Doorking Gate (the **Android app** `com.doorking.gate` and its companion **Web UI**) is a self-hosted client for managing DoorKing telephone-entry gate systems. Your data is stored solely on the self-hosted DoorKing server operated by your community, property manager, or organization—not by the app developer.

## 1. Information Processed by the App

Depending on your role (Administrator, Editor, Read-Only Staff, or Resident) and the features enabled on your community's server, the app may access and display:

- **Account & Authentication Data:** Username, email address (used for invitations, email verification, password resets, or optional Single Sign-On), passkey public credentials (stored via Android Credential Manager / WebAuthn), and an encrypted local session token stored in Android Keystore.
- **Directory & Gate Access Data:** Resident/vendor display names, directory codes, phone numbers used by the call box, keypad entry codes, assigned card/remote numbers, and unit notes configured by your property administrator.
- **Gate Activity & Optional Camera Media:** Access event timestamps, entry results, and—where configured by your property administrator—camera snapshots or video clips captured by the community's gate cameras.
- **Resident Self-Service Requests:** Change requests or suspicious-activity reports you explicitly submit to your property administrator.
- **Optional Crash Diagnostics:** If the Android app encounters an unhandled crash, it stores the stack trace locally and sends basic technical crash metadata (app version, Android SDK level, device model, and stack trace—no passwords or session tokens) to **your own configured DoorKing server** (`/api/client-crashes`) to help diagnose defects.

## 2. How Information Is Used

Information is used exclusively to:
- Authenticate your account and protect sensitive gate actions (including passkey step-up verification).
- Display and manage your community's gate directory, schedules, board settings, and access history.
- Perform user-initiated gate actions (such as "Buzz Me In" or administrator-approved syncs to DKS Cloud).
- Deliver optional gate notifications when enabled on your account.

## 3. Data Sharing & Third Parties

- **No Advertising or Analytics Trackers:** The app contains **no** third-party advertising SDKs, behavioral trackers, or data brokers, and we never sell or rent personal data.
- **DKS Cloud & Infrastructure:** Your self-hosted server communicates with DoorKing's DKS Cloud service solely to pull/send gate configuration, access logs, and relay states on behalf of your gate administrator. If your server administrator configures SMTP email, OIDC Single Sign-On (e.g., Google), or push notifications, authentication or notification payloads pass through those configured providers only as needed to deliver the service.

## 4. Data Storage, Security & Retention

- All communication between the Android app and your server uses HTTPS/TLS.
- On Android, your bearer session token is encrypted at rest using AES-256-GCM backed by Android Keystore (`EncryptedSessionStore`).
- Server-side retention of access logs, camera snapshots, and resident records is controlled by your property administrator on their self-hosted server.

## 5. Your Choices & Data Deletion

- **Sign Out & Local Data:** Signing out inside the app immediately revokes your server session and clears your locally stored encrypted token and widget cache. Uninstalling the app removes all local app data from your device.
- **Account or Record Deletion:** Because your community's self-hosted server owns and controls your resident directory entry and user account, please contact your property manager or system administrator to update or delete your account, email address, phone number, or access records.

## 6. Contact

For questions about your community's gate records or privacy practices, contact your property manager or the administrator of your DoorKing server. For technical questions about the open-source Doorking Gate software, open an issue in the project repository.
