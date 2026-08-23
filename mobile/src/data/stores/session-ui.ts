import { create } from "zustand";

import { terminalMetrics } from "@/theme";

export interface SessionUiState {
  follow: boolean;
  fontSize: number;
  lastKnownTitle: string | null;
}

interface SessionUiStoreState {
  sessions: Record<string, SessionUiState>;
  setFollow: (sessionId: string, follow: boolean) => void;
  setFontSize: (sessionId: string, fontSize: number) => void;
  setLastKnownTitle: (sessionId: string, title: string | null) => void;
  cleanup: (sessionId: string) => void;
  clear: () => void;
}

export const DEFAULT_SESSION_UI: Readonly<SessionUiState> = {
  follow: true,
  fontSize: terminalMetrics.fontSize,
  lastKnownTitle: null,
};

function currentSession(
  sessions: Record<string, SessionUiState>,
  sessionId: string,
): SessionUiState {
  return sessions[sessionId] ?? { ...DEFAULT_SESSION_UI };
}

export const useSessionUiStore = create<SessionUiStoreState>((set) => ({
  sessions: {},
  setFollow: (sessionId, follow) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...currentSession(state.sessions, sessionId), follow },
      },
    }));
  },
  setFontSize: (sessionId, fontSize) => {
    if (!Number.isFinite(fontSize) || fontSize <= 0) {
      return;
    }
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...currentSession(state.sessions, sessionId), fontSize },
      },
    }));
  },
  setLastKnownTitle: (sessionId, lastKnownTitle) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [sessionId]: { ...currentSession(state.sessions, sessionId), lastKnownTitle },
      },
    }));
  },
  cleanup: (sessionId) => {
    set((state) => {
      const { [sessionId]: _removed, ...sessions } = state.sessions;
      return { sessions };
    });
  },
  clear: () => {
    set({ sessions: {} });
  },
}));
