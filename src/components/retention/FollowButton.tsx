"use client";

import { useState, useTransition } from "react";
import { followAction, unfollowAction } from "@/app/retention-actions";

type Props = {
  subscriberId: string;
  targetType: "federal_member" | "officeholder" | "candidate";
  targetId: string;
  targetName: string;
  initiallyFollowing?: boolean;
};

export default function FollowButton({
  subscriberId,
  targetType,
  targetId,
  targetName,
  initiallyFollowing = false,
}: Props) {
  const [following, setFollowing] = useState(initiallyFollowing);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  function toggle() {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("subscriber_id", subscriberId);
      formData.set("target_type", targetType);
      formData.set("target_id", targetId);

      const result = following
        ? await unfollowAction(formData)
        : await followAction(formData);

      if (!result.ok) {
        setError(result.error ?? "Action failed");
        return;
      }
      setFollowing(!following);
    });
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
          following
            ? "bg-[var(--color-text)] text-white border-[var(--color-text)]"
            : "bg-white text-[var(--color-text)] border-[var(--color-border)] hover:border-[var(--color-primary)]"
        } disabled:opacity-50`}
        aria-label={following ? `Unfollow ${targetName}` : `Follow ${targetName}`}
      >
        {isPending ? "…" : following ? "✓ Following" : "+ Follow"}
      </button>
      {error && <p className="text-red-600 text-xs mt-1">{error}</p>}
    </div>
  );
}
