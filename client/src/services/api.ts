import { auth } from "../firebase";

export function getApiBaseUrl() {
  const configured = import.meta.env.VITE_API_URL || "http://localhost:4000";
  return /^https?:\/\//i.test(configured) ? configured.replace(/\/+$/, "") : `https://${configured.replace(/\/+$/, "")}`;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in to continue.");
  const token = await user.getIdToken();
  const baseUrl = getApiBaseUrl();
  const method = options.method ?? "GET";
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "application/json");
  headers.set("Authorization", `Bearer ${token}`);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api${path}`, { ...options, headers });
  } catch (issue) {
    console.error("Gather API request could not reach the server:", {
      method,
      path,
      baseUrl,
      error: issue instanceof Error ? issue.message : String(issue),
    });
    throw new Error(
      `Could not reach the Gather API (${method} /api${path}) at ${baseUrl}. Check that the backend is running, VITE_API_URL points to it, and CLIENT_ORIGIN allows this site.`,
    );
  }
  if (response.status === 401) {
    console.error("Gather API rejected the authenticated request:", { path, status: response.status });
    throw new Error("Your session expired. Please sign in again.");
  }

  let data: T & { error?: string };
  try {
    data = await response.json() as T & { error?: string };
  } catch (issue) {
    console.error("Gather API returned an invalid response:", {
      method,
      path,
      status: response.status,
      error: issue instanceof Error ? issue.message : String(issue),
    });
    throw new Error(`The Gather API returned an invalid response (${response.status}) for ${method} /api${path}.`);
  }
  if (!response.ok) {
    console.error("Gather API request failed:", { path, status: response.status, error: data.error });
    throw new Error(data.error || "The request could not be completed.");
  }
  return data;
}
