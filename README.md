# Gather

Gather is a real-time messaging application built with React, Vite, Firebase Authentication, Cloud Firestore, Firebase Storage, and an Express API. The browser uses Firestore listeners for live conversation and message updates; authenticated writes are checked by the API using revocation-aware Firebase ID tokens.

## Requirements

- Node.js 20 or newer and npm
- A Firebase project with Email/Password Authentication, Cloud Firestore, and Firebase Storage enabled
- Firebase Admin credentials available to the server through Application Default Credentials or a service-account JSON file

## Configure Firebase

1. Create a Firebase project and register a web app. Copy its web-app configuration into `client/.env` using `client/.env.example`.
2. In Firebase Authentication, enable the Email/Password provider and set authorized domains for local and production use.
3. Create a Firestore database and a Storage bucket.
4. Configure server credentials. For local development, create a service account with access to Firebase Authentication, Firestore, and Storage, then set `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path in `server/.env`. Do not put that file in this repository or expose it to the browser. On Google Cloud, prefer the runtime's attached service account instead.
5. Copy `server/.env.example` to `server/.env`, set `FIREBASE_PROJECT_ID`, `CLIENT_ORIGIN`, and (if needed) `GOOGLE_APPLICATION_CREDENTIALS`.
6. Deploy `firestore.rules`, `storage.rules`, and `firestore.indexes.json` from the Firebase console or Firebase CLI:

   ```powershell
   npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage
   ```

The Firebase Admin SDK bypasses Firestore rules. API routes independently validate authentication, membership, sender ownership, group-admin permissions, and request schemas. Browser Firestore access is read-only except for Storage uploads governed by Storage rules.

## Install and run

From the project root:

```powershell
npm install
Copy-Item client\.env.example client\.env
Copy-Item server\.env.example server\.env
npm run dev
```

Set the environment values before opening the app. Vite serves the client at `http://localhost:5173`; the API listens on `http://localhost:4000`. The API health check is `GET /health`.

## Implemented functionality

- Email/password registration and sign-in, email verification, password reset, and logout
- Firebase ID-token JWT bearer authentication on API routes; revoked and expired tokens are rejected, and logout revokes refresh tokens
- Profile initialization and presence heartbeats with stale-online detection
- Search verified registered accounts by username, full name, or email; open profiles with presence, last seen, bio, and opt-in email visibility, then open a private one-to-one chat
- Real-time conversation and message listeners, delivered/read receipts, typing indicators, and message search
- Text, voice, image, PDF, and Word-file messages (maximum 10 MB; voice notes capped at 2 minutes); edit/delete own text messages
- Group creation with name and picture URL, live member listing, and admin-authorized member/admin promotion and removal
- Unread notification counts and opt-in browser notifications
- Built-in Gather Help Bot for common how-to questions (no external AI service; chat history stays in the current browser)
- Responsive dashboard layout with loading, empty, and error states
- Rate limiting, security headers, validated request bodies, Firestore rules, and Storage rules

## API

All `/api/*` routes require an `Authorization` header containing the signed-in user's current ID token; the email address must be verified.

| Method | Route | Purpose |
| --- | --- | --- |
| POST | `/api/profile` | Create/update the signed-in user's profile |
| POST | `/api/presence` | Update the signed-in user's presence |
| POST | `/api/session/logout` | Revoke refresh tokens for the signed-in account |
| GET | `/api/users?search=...` | Search verified profiles by username, full-name, or email prefix; email is returned only when the profile owner opts in |
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
- `publicProfiles/{uid}`: display name, username, avatar, bio, and presence (readable to authenticated users); email is included only when its owner opts in
- `conversations/{conversationId}`: member UIDs, direct/group type, admins, timestamps, and last message
- `conversations/{conversationId}/messages/{messageId}`: sender, text/private Storage path metadata, timestamps, and readers
- `notifications/{notificationId}`: recipient, message preview, conversation ID, read state, timestamp
- Storage: `uploads/{uid}/{conversationId}/{fileName}`. The app reads attachments and voice notes through authenticated Firebase Storage SDK requests; it does not persist public download-token URLs.

## Validation and tests

```powershell
npm run typecheck
npm run build
```

For an end-to-end smoke test, open the client in two separate browser profiles, register two different verified accounts, search for the other account, and send a message in each direction. Also try group creation, unread/read state, message edit/delete, an allowed and rejected attachment, and microphone permission/voice recording/playback over HTTPS or localhost. Automated browser/integration tests are not included yet.

## Deployment

1. Build the client with `npm run build`.
2. Deploy Firestore rules, Storage rules, and indexes with the Firebase CLI as above.
3. Deploy `client/dist` to Firebase Hosting using `npx firebase-tools deploy --only hosting`, or another static host with SPA fallback to `index.html`. Set the production `VITE_*` values at build time.
4. Deploy the Express server separately to Cloud Run, App Engine, Render, or another Node.js host. Set `CLIENT_ORIGIN`, `PORT`, and `FIREBASE_PROJECT_ID`; attach a least-privilege service account with Firebase Admin access. Set `VITE_API_URL` to the deployed API origin before building the client.
5. Configure HTTPS, production Firebase authorized domains, API CORS origin, backups, monitoring, and Firebase billing/quotas before opening the service to users.

## Deploy to Render

The root `render.yaml` defines a Render Blueprint with two services: the Express API and the Vite static site. Push this project to a GitHub/GitLab repository, then create a Blueprint in [Render](https://dashboard.render.com/select-repo) and select that repository. Render will build both services and provision their host URLs.

Before the API can start, add the Firebase Admin service-account JSON to the `gather-api` service as a **Secret File** named `firebase-admin.json` at `/etc/secrets/firebase-admin.json`. This file contains private credentials: never commit it, put it in a normal environment variable, or expose it to the client. The blueprint configures `GOOGLE_APPLICATION_CREDENTIALS` to that secret-file path.

When creating the Blueprint, enter the Firebase web app values from your Firebase project in the `gather-client` environment prompts: `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_STORAGE_BUCKET`, `VITE_FIREBASE_MESSAGING_SENDER_ID`, and `VITE_FIREBASE_APP_ID`. These are public web-app config values, not Admin credentials.

The blueprint connects the client API URL and API CORS origin to each other's Render host. After the first deployment:

1. In Firebase Authentication settings, add the deployed client hostname to **Authorized domains** and ensure Email/Password sign-in is enabled.
2. Deploy Firestore and Storage rules/indexes with the Firebase CLI from a trusted local machine.
3. Wait for the API `/health` check and the static site deployment to become live. The `gather-client` Render URL shown in its service dashboard is the public app link.
4. If `CLIENT_ORIGIN` or the API host has not been resolved by Render on the first deploy, set `CLIENT_ORIGIN` to the client service's exact `https://...onrender.com` origin and redeploy the API.

Render deployment is not complete until the repository is connected, both services are live, and the Firebase Admin Secret File and web configuration are set.

## Production considerations

This project is a functional foundation, not a fully audited large-scale deployment. Before a public launch, add automated unit/integration/browser tests, stronger abuse controls, message pagination and search indexing, direct-message/group notification preferences, privacy review for presence/profile visibility, operational metrics, and formal deployment/IAM review.
