# gcalendarwin

Desktop Google Calendar sync app built with Tauri + React + TypeScript.

## Setup

1. Copy `.env.example` to `.env`.
2. Choose one OAuth mode:

Desktop mode (recommended):
- Create an OAuth 2.0 Client ID of type `Desktop app`.
- Set only `VITE_GOOGLE_CLIENT_ID`.

Web mode (fallback):
- Create an OAuth 2.0 Client ID of type `Web application`.
- Add an authorized redirect URI like `http://127.0.0.1:8787/callback`.
- Set `VITE_GOOGLE_CLIENT_ID`, `VITE_GOOGLE_CLIENT_SECRET`, and `VITE_GOOGLE_REDIRECT_URI` to the exact same URI.

## Run

```bash
npm install
npm run tauri dev
```

## How sign-in works

- The app opens Google sign-in in your default system browser.
- Google redirects back to a local loopback callback.
- The app exchanges the authorization code for an access token and syncs your primary calendar.

## What it does

- Signs in with Google OAuth (desktop-safe external browser flow).
- Supports multiple Google accounts in one view.
- Uses distinct colors per account for month/day events.
- Lets you create events to the selected account calendar.
- Triggers local desktop notifications for upcoming timed events.
- Stores refresh tokens securely in OS credential storage and restores sessions automatically on app startup.
