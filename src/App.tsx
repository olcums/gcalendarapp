import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import "./App.css";

type CalendarEvent = {
  id: string;
  summary?: string;
  location?: string;
  htmlLink?: string;
  start?: {
    date?: string;
    dateTime?: string;
  };
  end?: {
    date?: string;
    dateTime?: string;
  };
};

function formatEventDate(dateTime?: string, date?: string): string {
  const value = dateTime ?? date;
  if (!value) {
    return "No date";
  }

  if (dateTime) {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(dateTime));
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(new Date(`${date}T00:00:00`));
}

export default function App() {
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  const clientSecret = import.meta.env.VITE_GOOGLE_CLIENT_SECRET;
  const redirectUri = import.meta.env.VITE_GOOGLE_REDIRECT_URI;
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async (token: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        maxResults: "20",
        orderBy: "startTime",
        singleEvents: "true",
        timeMin: new Date().toISOString(),
      });

      const response = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const message =
          payload?.error?.message ??
          "Failed to fetch events from Google Calendar.";
        throw new Error(message);
      }

      const payload = (await response.json()) as { items?: CalendarEvent[] };
      setEvents(payload.items ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unexpected error");
      setEvents([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!accessToken) {
      setEvents([]);
      return;
    }

    void fetchEvents(accessToken);
  }, [accessToken, fetchEvents]);

  const connectGoogleCalendar = async () => {
    if (!clientId) {
      setError("Missing VITE_GOOGLE_CLIENT_ID in .env");
      return;
    }

    setIsAuthenticating(true);
    setError(null);
    try {
      const token = await invoke<{ access_token: string }>("login_with_google", {
        clientId,
        clientSecret: clientSecret || null,
        redirectUri: redirectUri || null,
      });
      setAccessToken(token.access_token);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : typeof err === "string"
            ? err
            : JSON.stringify(err);
      setError(message);
    } finally {
      setIsAuthenticating(false);
    }
  };

  const disconnect = () => {
    setAccessToken(null);
    setEvents([]);
    setError(null);
  };

  return (
    <main className="app-shell">
      <h1>Google Calendar Sync</h1>

      {!accessToken ? (
        <section className="card">
          <p>Connect your Google account to load upcoming events.</p>
          <button onClick={connectGoogleCalendar} disabled={isAuthenticating}>
            {isAuthenticating
              ? "Waiting for Google sign-in..."
              : "Connect Google Calendar"}
          </button>
          {error ? <p className="error">{error}</p> : null}
        </section>
      ) : (
        <section className="card">
          <div className="actions">
            <button onClick={() => void fetchEvents(accessToken)} disabled={isLoading}>
              {isLoading ? "Syncing..." : "Sync Now"}
            </button>
            <button onClick={disconnect} className="secondary">
              Disconnect
            </button>
          </div>

          {error ? <p className="error">{error}</p> : null}

          {!isLoading && events.length === 0 ? (
            <p>No upcoming events found.</p>
          ) : (
            <ul className="event-list">
              {events.map((event) => (
                <li key={event.id} className="event-item">
                  <h2>{event.summary ?? "Untitled event"}</h2>
                  <p>{formatEventDate(event.start?.dateTime, event.start?.date)}</p>
                  {event.location ? <p>{event.location}</p> : null}
                  {event.htmlLink ? (
                    <a href={event.htmlLink} target="_blank" rel="noreferrer">
                      Open in Google Calendar
                    </a>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </main>
  );
}
