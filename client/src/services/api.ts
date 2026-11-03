import { auth } from "../firebase";

export function getApiBaseUrl() {
  const configured = import.meta.env.VITE_API_URL || "http://localhost:4000";
  return /^https?:\/\//i.test(configured) ? configured : `https://${configured}`;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const user = auth.currentUser;
  if (!user) throw new Error("Please sign in to continue.");
  const token = await user.getIdToken();
  const response = await fetch(`${getApiBaseUrl()}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
  });
  if (response.status === 401) throw new Error("Your session expired. Please sign in again.");
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error || "The request could not be completed.");
  return data;
}
