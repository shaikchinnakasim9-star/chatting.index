# Gather

Gather is a real-time messaging application built with React, Vite, Firebase Authentication, Cloud Firestore, Firebase Storage, and an Express API. The browser uses Firestore listeners for live conversation and message updates; authenticated writes are checked by the API using revocation-aware Firebase ID tokens.

## Requirements

- Node.js 20 or newer and npm
- A Firebase project with Email/Password Authentication, Cloud Firestore, Firebase Storage, and Realtime Database enabled
- Firebase Admin credentials available to the server through Application Default Credentials or a service-account JSON file

## Configure Firebase

1. Create a Firebase project and register a web app. Copy its web-app configuration into `client/.env` using `client/.env.example`.
2. In Firebase Authentication, enable the Email/Password provider and set authorized domains for local and production use.
3. Create a Firestore database and a Storage bucket. Create the default Realtime Database and copy its database URL; set it as `VITE_FIREBASE_DATABASE_URL` in `client/.env` and `FIREBASE_DATABASE_URL` in `functions/.env`.
4. Configure server credentials. For local development, create a service account with access to Firebase Authentication, Firestore, and Storage, then set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path in `server/.env`. Do not put that file in this repository or expose it to the browser. On Google Cloud, prefer the runtime's attached service account instead.
5. Copy `server/.env.example` to `server/.env`, set `FIREBASE_PROJECT_ID`, `CLIENT_ORIGIN`, and (if needed) `GOOGLE_APPLICATION_CREDENTIALS`. The API refuses to start without a Firebase project ID; it needs working Firebase Admin credentials to serve conversation and message operations. Set `CLIENT_ORIGINS` to a comma-separated list when the frontend also uses custom domains; each browser origin must match exactly.
6. Copy `functions/.env.example` to `functions/.env` and set `FIREBASE_DATABASE_URL` to the Realtime Database URL and `FIREBASE_STORAGE_BUCKET` to the exact Storage bucket name from Firebase Console. Then deploy Firestore rules/indexes, Realtime Database rules, Storage rules, and the Cloud Functions:

   ```powershell
   npx firebase-tools deploy --project gather-869c5 --only firestore:rules,firestore:indexes,database,storage,functions
   ```

Cloud Functions deployment requires the Firebase project to have billing enabled. The Firebase Admin SDK bypasses Firestore rules and is used only by the backend migration and Cloud Functions. API routes independently validate authentication, membership, sender ownership, group-admin permissions, and request schemas. After registration and login, the browser creates or repairs only the signed-in user's UID-keyed profiles with merge writes. Firestore rules keep email private, restrict client profile writes to the authenticated UID, and prevent clients from changing presence. Realtime Database `onDisconnect` removes a user's connection when a tab or network disconnects; a backend Cloud Function mirrors connection state to both profile documents. Search People listens to `publicProfiles` with Firestore `onSnapshot`, so profile and presence changes appear live.

### Expiration and account deletion

The expiration feature uses trusted Admin SDK writes and two scheduled functions. `runExpirationCleanup` checks message, session, and account deadlines once per minute; `backfillExpirationFields` assigns safe rollout deadlines to existing records in small batches (30 days for existing sessions, 7 days for existing messages, and 365 days for existing accounts). New accounts start with a 365-day server deadline and registration can set one of the offered lifetimes (7, 30, 90, 180, or 365 days). Users can change their default message and session durations, but cannot write expiration timestamps.

Enable Firebase Authentication with Identity Platform for the `beforeUserSignedIn` blocking function, and ensure the Functions runtime service account can administer Firebase Authentication, Firestore, Realtime Database, and Storage objects. This blocking function rejects expired accounts at sign-in; API middleware and Firestore/Storage rules also enforce account and session expiry. Cloud Scheduler and the scheduled functions require a billing-enabled Firebase project. Deploy the feature with:

```powershell
npx firebase-tools deploy --project gather-869c5 --only firestore:rules,firestore:indexes,storage,functions
```

The Firestore index configuration enables TTL only for notification documents (`notifications.expiresAt`). Do not enable TTL for messages or sessions: scheduled cleanup must delete attachment objects and nested message documents before deleting the session, and TTL could remove the parent or message before that cleanup. Scheduled backend checks, not TTL, are authoritative for message/session expiration. No production data is deleted merely by running local builds or tests; deploy the scheduled functions only after reviewing the rollout backfill policy above.

To validate safely, use the Firebase Emulator Suite or a dedicated Firebase project and dedicated test accounts/sessions. Do not test short lifetimes against existing production accounts or conversations. Confirm one-minute message cleanup, offline scheduled cleanup, expired-session denial, account sign-in blocking/deletion, and retry logs in the Functions console before production rollout.

## Migrate existing Authentication users

New Firebase Authentication users are provisioned by a backend Auth trigger and the registration flow. Run the existing Admin SDK migration once to create/repair documents for all Authentication users that existed before deployment. It preserves populated profile values, uses a stable UID-derived username when one is missing, removes any legacy email field from public profiles, and never modifies or deletes Authentication accounts. It is restricted to project `gather-869c5`.

1. Configure server-side Application Default Credentials or set `GOOGLE_APPLICATION_CREDENTIALS` in `server/.env` to a service-account JSON file stored outside this repository. Grant that service account permission to list Firebase Authentication users and read/write Firestore documents. Do not put Admin credentials in `client/.env`.
2. Ensure `FIREBASE_PROJECT_ID=gather-869c5` is set in `server/.env`.
3. From the repository root, run a dry run first:

   ```powershell
   npm run migrate:users --workspace server
   ```

4. Review the counts. To apply the migration, run:

   ```powershell
   npm run migrate:users --workspace server -- --apply
   ```

The command logs progress and a final summary with processed Authentication users plus created, updated, and skipped private/public profile documents. It is safe to rerun: complete documents are skipped, missing fields are merged, and existing profile values are retained. The command exits unsuccessfully if the project ID is wrong or an Admin SDK operation fails.

## Install and run

From the project root:

```powershell
npm install
Copy-Item client\.env.example client\.env
Copy-Item server\.env.example server\.env
Copy-Item functions\.env.example functions\.env
npm run dev
```

Set `VITE_FIREBASE_DATABASE_URL` in `client/.env` and `FIREBASE_DATABASE_URL` in `functions/.env` to the exact Realtime Database URL shown in Firebase Console. Set the other Firebase web config and server credentials as described above. Vite serves the client at `http://localhost:5173`; the API listens on `http://localhost:4000`. The API health check is `GET /health`. If a request reports that the API could not be reached, check that health URL, the client's `VITE_API_URL`, and the frontend origin in `CLIENT_ORIGIN`/`CLIENT_ORIGINS`.

## Implemented functionality

- Email/password registration and sign-in, email verification, password reset, and logout
- Firebase ID-token JWT bearer authentication on API routes; revoked and expired tokens are rejected, and logout revokes refresh tokens
- Profile initialization and presence synchronization using Realtime Database `onDisconnect` and a Firestore mirroring function
- Real-time Search People results from `publicProfiles`, searchable by username or display name; the current user is excluded
- Real-time conversation and message listeners, delivered/read receipts, typing indicators, and message search
- Text, voice, image, PDF, and Word-file messages (maximum 10 MB; voice notes capped at 2 minutes); edit/delete own text messages
- Configurable disappearing-message and private-session durations, server-side expiration checks, attachment cleanup, and scheduled account expiration with authentication deletion
- Account-expiration reminders and a Settings section for retention defaults and account lifetime status
- Group creation with name and picture URL, live member listing, and admin-authorized member/admin promotion and removal
- Unread notification counts and opt-in browser notifications
- Built-in Gather Help Bot for common how-to questions (no external AI service; chat history stays in the current browser)
- Responsive dashboard layout with loading, empty, and error states
- Rate limiting, security headers, validated request bodies, Firestore rules, and Storage rules

## API

All `/api/*` routes require an `Authorization` header containing the signed-in user's current ID token. `/api/register-profile` also accepts a valid token before email verification so registration can create the private and public Firestore profiles; all other routes require a verified email.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/register-profile` | Create the signed-in account's initial Firestore profile after Firebase Authentication registration |
| POST | `/api/profile` | Create/update the signed-in user's profile |
| GET/PATCH | `/api/settings` | Read or update allowed message/session expiration defaults |
| POST | `/api/session/logout` | Revoke refresh tokens for the signed-in account |
| GET | `/api/users?search=...` | Search verified public profiles by username or display name |
| POST | `/api/conversations` | Reuse an existing one-to-one conversation or create one; create a group |
| GET | `/api/conversations` | List conversations for the signed-in member |
| GET | `/api/conversations/:id/messages` | Read the latest message history (maximum 100) |
| POST | `/api/conversations/:id/messages` | Send a message or attachment reference |
| POST | `/api/conversations/:id/read` | Mark incoming messages as read |
| POST | `/api/conversations/:id/typing` | Update the member's typing indicator |
| PATCH/DELETE | `/api/conversations/:id/messages/:messageId` | Edit/delete a message sent by the caller |
| POST | `/api/conversations/:id/members` | Admin-authorized group member addition |
| DELETE | `/api/conversations/:id/members/:uid` | Admin-authorized group member removal |
| POST | `/api/conversations/:id/admins` | Promote a current group member to admin |
| DELETE | `/api/conversations/:id/admins/:uid` | Remove admin rights while preserving at least one admin |
| POST | `/api/notifications/:id/read` | Mark an owned notification as read |

## Data model

- `users/{uid}`: private account profile, including email
- `publicProfiles/{uid}`: display name, username, avatar, bio, and presence (readable to verified authenticated users); email is never stored in the public profile
- Realtime Database `presence/{uid}/connections/{connectionId}`: authenticated user's own live connections, automatically removed by `onDisconnect`
- `internalPresenceState/{uid}`: server-only revision marker that prevents out-of-order presence events from overwriting newer status
- `chats/{chatId}`: private one-to-one participants, creation/update timestamps, and last message
- `chats/{chatId}/messages/{messageId}`: sender, receiver, text or attachment metadata, timestamp, and sent/read status
- `conversations/{conversationId}`: group conversations and existing conversations, including member UIDs, admins, timestamps, and last message
- `conversations/{conversationId}/messages/{messageId}`: sender, text/private Storage path metadata, timestamps, and readers
- `notifications/{notificationId}`: recipient, message preview, conversation ID, read state, timestamp
- Storage: `uploads/{uid}/{conversationId}/{fileName}`. The app reads attachments and voice notes through authenticated Firebase Storage SDK requests; it does not persist public download-token URLs.

## Validation and tests

```powershell
npm run typecheck
npm run build
```

For an end-to-end smoke test, open the client in two separate browser profiles, register two different verified accounts, search for the other account, edit one profile's name/username/photo and verify the other browser updates without refreshing, then open a one-to-one chat and send messages in both directions. Close one browser profile and verify its presence changes to offline. Also try group creation, unread/read state, message edit/delete, an allowed and rejected attachment, and microphone permission/voice recording/playback over HTTPS or localhost. Automated browser/integration tests are not included yet.

## Deployment

1. Build the client with `npm run build`.
2. Deploy Firestore and Realtime Database rules, Storage rules, indexes, and Cloud Functions with the Firebase CLI as above.
3. Deploy `client/dist` to Firebase Hosting using `npx firebase-tools deploy --only hosting`, or another static host with SPA fallback to `index.html`. Set the production `VITE_*` values at build time.
4. Deploy the Express server separately to Cloud Run, App Engine, Render, or another Node.js host. Set `CLIENT_ORIGIN`, `PORT`, and `FIREBASE_PROJECT_ID`; attach a least-privilege service account with Firebase Admin access. Set `VITE_API_URL` to the deployed API origin before building the client.
5. Configure HTTPS, production Firebase authorized domains, API CORS origin, backups, monitoring, and Firebase billing/quotas before opening the service to users.

## Deploy to Render

The root `render.yaml` defines a Render Blueprint with two services: the Express API and the Vite static site. Push this project to a GitHub/GitLab repository, then create a Blueprint in [Render](https://dashboard.render.com/select-repo) and select that repository. Render will build both services and provision their host URLs.

Before the API can start, add the Firebase Admin service-account JSON to the `gather-api` service as a **Secret File** named `firebase-admin.json` at `/etc/secrets/firebase-admin.json`. This file contains private credentials: never commit it, put it in a normal environment variable, or expose it to the client. The blueprint configures `GOOGLE_APPLICATION_CREDENTIALS` to that secret-file path.

When creating the Blueprint, enter the Firebase web app values from your Firebase project in the `gather-client` environment prompts: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, `VITE_FIREBASE_APP_ID`, and `VITE_FIREBASE_DATABASE_URL`. These are public web-app config values, not Admin credentials.

The blueprint connects the client API URL and API CORS origin to each other's Render host. After the first deployment:

1. In Firebase Authentication settings, add the deployed client hostname to **Authorized domains** and ensure Email/Password sign-in is enabled.
2. Deploy Firestore and Storage rules/indexes with the Firebase CLI from a trusted local machine.
3. Wait for the API `/health` check and the static site deployment to become live. The `gather-client` Render URL shown in its service dashboard is the public app link.
4. If `CLIENT_ORIGIN` or the API host has not been resolved by Render on the first deploy, set `CLIENT_ORIGIN` to the client service's exact `https://...onrender.com` origin and redeploy the API.

Render deployment is not complete until the repository is connected, both services are live, and the Firebase Admin Secret File and web configuration are set.

## Production considerations

This project is a functional foundation, not a fully audited large-scale deployment. Before a public launch, add automated unit/integration/browser tests, stronger abuse controls, message pagination and search indexing, direct-message/group notification preferences, privacy review for presence/profile visibility, operational metrics, and formal deployment/IAM review.
