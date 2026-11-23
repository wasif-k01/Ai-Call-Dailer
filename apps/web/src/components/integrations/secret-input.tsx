"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Input } from "@/components/ui";

/**
 * A password-style field for secrets. Saved secrets are never sent back to the browser:
 * only a masked hint ("••••abcd") is shown, and leaving the field empty keeps the saved value.
 */
export function SecretInput({ name, label, saved, hint, error }: { name: string; label: string; saved?: string; hint?: string; error?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        name={name}
        label={label}
        type={show ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        placeholder={saved ? `Saved (${saved}) — leave empty to keep` : ""}
        hint={hint}
        error={error}
        className="pr-10 font-mono"
      />
      <button
        type="button"
        onClick={() => setShow(!show)}
        className="absolute right-2 top-[2.1rem] rounded p-1 text-muted hover:text-text"
        aria-label={show ? "Hide" : "Show"}
      >
        {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
      </button>
    </div>
  );
}
