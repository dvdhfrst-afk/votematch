"use client";

import { useEffect, useState } from "react";

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function setCookie(name: string, value: string, days: number) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)};expires=${expires};path=/;SameSite=Lax`;
}

const VARIANTS = {
  A: "Your whole ballot, explained.",
  B: "Walk into the booth knowing every name.",
} as const;

export default function HeadlineAB() {
  const [headline, setHeadline] = useState<string>(VARIANTS.A);

  useEffect(() => {
    let variant = getCookie("bb_variant") as "A" | "B" | null;

    if (!variant || !(variant in VARIANTS)) {
      variant = Math.random() < 0.5 ? "A" : "B";
      setCookie("bb_variant", variant, 90);
    }

    setHeadline(VARIANTS[variant]);

    // Track which variant was shown for A/B analysis
    import("posthog-js")
      .then((mod) => mod.default.capture("headline_ab_shown", { variant }))
      .catch(() => {});
  }, []);

  return (
    <h1 className="text-4xl sm:text-5xl lg:text-6xl font-extrabold text-[var(--color-primary)] leading-tight tracking-tight">
      {headline}
    </h1>
  );
}
