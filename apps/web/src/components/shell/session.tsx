"use client";

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError } from "@/lib/api";
import { Spinner } from "@/components/ui";

export interface Session {
  user: { id: string; email: string; fullName: string; role: string; permissions: string[] };
  organization: { id: string; name: string };
}

const SessionContext = createContext<Session | null>(null);

export function useSession() {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession must be used inside SessionProvider");
  return s;
}

export function can(session: Session, permission: string) {
  return session.user.permissions.includes("*") || session.user.permissions.includes(permission);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Session>("/auth/me")
      .then(setSession)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) router.replace("/login");
        else setError(e.message);
      });
  }, [router]);

  if (error) return <div className="p-10 text-center text-sm text-danger">{error}</div>;
  if (!session) return <Spinner label="Loading your workspace…" />;
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}
