/**
 * React binding for `SessionConnection`. Creates one instance per component
 * lifetime and mirrors its state into React via `subscribe`.
 */
import { useEffect, useState } from "react";
import {
  INITIAL_SESSION_CONNECTION_STATE,
  SessionConnection,
} from "../lib/session-connection";

export function useSessionConnection() {
  // Lazy initializer guarantees exactly one instance per mount (unlike
  // useMemo, which React may discard and recompute).
  const [connection] = useState(() => new SessionConnection());
  const [state, setState] = useState(INITIAL_SESSION_CONNECTION_STATE);

  useEffect(() => {
    const unsubscribe = connection.subscribe(setState);
    return () => {
      unsubscribe();
      connection.close();
    };
  }, [connection]);

  return {
    ...state,
    createSession: () => connection.createSession(),
    joinSession: (sessionId: string) => connection.joinSession(sessionId),
    close: () => connection.close(),
  };
}
