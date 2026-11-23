"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { PhoneCall } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { Alert, Button, Card, Input } from "@/components/ui";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [signupAllowed, setSignupAllowed] = useState<boolean | null>(null);

  useEffect(() => {
    api<{ signupAllowed: boolean }>("/auth/signup-status").then((r) => setSignupAllowed(r.signupAllowed)).catch(() => setSignupAllowed(false));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    setLoading(true);
    const data = Object.fromEntries(new FormData(e.currentTarget));
    try {
      await api(`/auth/${mode}`, { method: "POST", json: data });
      router.replace("/dashboard");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        if (err.fields) setFieldErrors(Object.fromEntries(err.fields.map((f) => [f.path, f.message])));
      } else setError("Something went wrong.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="grid size-11 place-items-center rounded-xl bg-primary text-primary-fg">
            <PhoneCall className="size-5" />
          </div>
          <div>
            <h1 className="text-xl font-semibold">{mode === "login" ? "Sign in" : "Create your account"}</h1>
            <p className="text-sm text-muted">AI Cloud Calling Platform</p>
          </div>
        </div>
        <Card>
          <form onSubmit={onSubmit} className="space-y-4">
            {error && <Alert>{error}</Alert>}
            {mode === "register" && (
              <>
                <Input name="fullName" label="Your name" required autoComplete="name" error={fieldErrors.fullName} />
                <Input name="organizationName" label="Company / workspace name" required error={fieldErrors.organizationName} />
              </>
            )}
            <Input name="email" type="email" label="Email" required autoComplete="email" error={fieldErrors.email} />
            <Input
              name="password"
              type="password"
              label="Password"
              required
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              hint={mode === "register" ? "At least 10 characters, with a letter and a number." : undefined}
              error={fieldErrors.password}
            />
            <Button type="submit" loading={loading} className="w-full">
              {mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
        </Card>
        <p className="mt-4 text-center text-sm text-muted">
          {mode === "login" ? (
            signupAllowed && (
              <>No account yet? <Link className="text-primary hover:underline" href="/register">Create one</Link></>
            )
          ) : (
            <>Already have an account? <Link className="text-primary hover:underline" href="/login">Sign in</Link></>
          )}
        </p>
      </div>
    </div>
  );
}
