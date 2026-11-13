import {
  onDisconnect, onValue, push, ref, remove, set, type DatabaseReference,
} from "firebase/database";
import { realtimeDb } from "../firebase";

type StopPresence = () => Promise<void>;

export function startPresence(uid: string, onError: (error: Error) => void): StopPresence {
  const database = realtimeDb;
  if (!database) {
    throw new Error("Realtime presence is not configured. Set VITE_FIREBASE_DATABASE_URL to the Realtime Database URL for gather-869c5.");
  }
  if (!uid) throw new Error("Cannot start presence without an authenticated Firebase UID.");

  const connectionState = ref(database, ".info/connected");
  let stopped = false;
  const activeConnections = new Set<DatabaseReference>();
  const setupTasks = new Set<Promise<void>>();
  const reportError = (issue: unknown) => {
    const error = issue instanceof Error ? issue : new Error(String(issue));
    console.error("Firebase Realtime Database presence failed:", error);
    onError(error);
  };
  const unsubscribe = onValue(connectionState, (snapshot) => {
    if (stopped || snapshot.val() !== true) return;
    const nextConnection = push(ref(database, `presence/${uid}/connections`));
    const setup = onDisconnect(nextConnection).remove()
      .then(() => set(nextConnection, true))
      .then(async () => {
        if (stopped) {
          await remove(nextConnection);
          await onDisconnect(nextConnection).cancel();
          return;
        }
        activeConnections.add(nextConnection);
      })
      .catch(reportError);
    setupTasks.add(setup);
    void setup.then(() => setupTasks.delete(setup));
  }, reportError);

  return async () => {
    stopped = true;
    unsubscribe();
    await Promise.all(setupTasks);
    await Promise.all([...activeConnections].map(async (connection) => {
      await remove(connection);
      await onDisconnect(connection).cancel();
    })).catch((issue: unknown) => {
      reportError(issue);
      throw issue;
    });
  };
}
