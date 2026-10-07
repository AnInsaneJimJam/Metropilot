import { useRef, useState } from "react";
import { api } from "./api.ts";
import type { SaveRequest, SavedAgent } from "./api.ts";
/** Keeps the same request identity after transport failures until content or revision changes. */
export function useSaveRevision() {
  const [saving, setSaving] = useState(false);
  const pending = useRef<{ text: string; key: string } | undefined>(undefined);
  const busy = useRef(false);
  const persist = async (
    body: SaveRequest,
    current: SavedAgent | undefined,
  ): Promise<SavedAgent> => {
    if (busy.current) throw new Error("A revision is already being saved.");
    const text = JSON.stringify({
      body,
      id: current?.id,
      version: current?.version,
    });
    if (pending.current?.text !== text)
      pending.current = { text, key: crypto.randomUUID() };
    busy.current = true;
    setSaving(true);
    try {
      return await api<SavedAgent>(
        current ? `/agents/${current.id}/strategy-revisions` : "/agents",
        {
          method: "POST",
          headers: {
            "Idempotency-Key": pending.current.key,
            ...(current ? { "If-Match": `"${current.version}"` } : {}),
          },
          body: JSON.stringify(body),
        },
      );
    } finally {
      busy.current = false;
      setSaving(false);
    }
  };
  return { saving, persist };
}
