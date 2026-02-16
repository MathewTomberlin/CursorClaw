import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode
} from "react";
import { getStatus, type ProfileInfo } from "../api";

const STORAGE_KEY_SELECTED_PROFILE = "cursorclaw_selected_profile_id";

interface ProfileContextValue {
  profiles: ProfileInfo[];
  defaultProfileId: string;
  selectedProfileId: string;
  setSelectedProfileId: (id: string) => void;
  refreshProfiles: () => Promise<void>;
  loading: boolean;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

export function useProfile(): ProfileContextValue {
  const ctx = useContext(ProfileContext);
  if (!ctx) throw new Error("useProfile must be used within ProfileProvider");
  return ctx;
}

function loadStoredProfileId(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY_SELECTED_PROFILE);
  } catch {
    return null;
  }
}

function saveStoredProfileId(id: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY_SELECTED_PROFILE, id);
  } catch {
    // ignore
  }
}

interface ProfileProviderProps {
  children: ReactNode;
}

export function ProfileProvider({ children }: ProfileProviderProps) {
  const [profiles, setProfiles] = useState<ProfileInfo[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState("default");
  const [selectedProfileId, setSelectedProfileIdState] = useState("default");
  const [loading, setLoading] = useState(true);
  /** True when last refreshProfiles failed (e.g. gateway unreachable); used to keep retrying in background. */
  const [lastLoadFailed, setLastLoadFailed] = useState(false);

  const refreshProfiles = useCallback(async () => {
    try {
      const status = await getStatus();
      setLastLoadFailed(false);
      const list = status.profiles ?? [{ id: "default", root: "." }];
      const defaultId = status.defaultProfileId ?? "default";
      setProfiles(list);
      setDefaultProfileId(defaultId);
      const stored = loadStoredProfileId();
      const validStored = stored && list.some((p) => p.id === stored);
      setSelectedProfileIdState(validStored ? stored : defaultId);
    } catch {
      setLastLoadFailed(true);
      setProfiles([{ id: "default", root: "." }]);
      setDefaultProfileId("default");
      setSelectedProfileIdState("default");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refreshProfiles();
  }, [refreshProfiles]);

  // When page becomes visible or browser goes online (e.g. phone unlock), retry so gateway recovery works without full refresh.
  useEffect(() => {
    const RECONNECT_DELAY_MS = 500;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const scheduleRetry = () => {
      if (document.visibilityState !== "visible") return;
      timeoutId = setTimeout(() => void refreshProfiles(), RECONNECT_DELAY_MS);
    };
    const onVisibleOrOnline = () => {
      if (timeoutId != null) clearTimeout(timeoutId);
      timeoutId = null;
      scheduleRetry();
    };
    document.addEventListener("visibilitychange", onVisibleOrOnline);
    window.addEventListener("online", onVisibleOrOnline);
    return () => {
      document.removeEventListener("visibilitychange", onVisibleOrOnline);
      window.removeEventListener("online", onVisibleOrOnline);
      if (timeoutId != null) clearTimeout(timeoutId);
    };
  }, [refreshProfiles]);

  // If last load failed (e.g. gateway unreachable on refresh), keep retrying in background so UI recovers without manual refresh.
  useEffect(() => {
    if (!lastLoadFailed) return;
    const intervalMs = 3000;
    const t = setInterval(() => void refreshProfiles(), intervalMs);
    return () => clearInterval(t);
  }, [lastLoadFailed, refreshProfiles]);

  const setSelectedProfileId = useCallback((id: string) => {
    setSelectedProfileIdState(id);
    saveStoredProfileId(id);
  }, []);

  const value: ProfileContextValue = {
    profiles,
    defaultProfileId,
    selectedProfileId,
    setSelectedProfileId,
    refreshProfiles,
    loading
  };

  return (
    <ProfileContext.Provider value={value}>
      {children}
    </ProfileContext.Provider>
  );
}
