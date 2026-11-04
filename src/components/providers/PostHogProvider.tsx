"use client";

import { useEffect } from "react";
import posthog from "posthog-js";

let initialized = false;

export default function PostHogProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  useEffect(() => {
    const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
    const host = process.env.NEXT_PUBLIC_POSTHOG_HOST;

    // Skip when unset or still on the placeholder from .env.local.example.
    if (!key || key.startsWith("your-") || initialized) return;

    posthog.init(key, {
      api_host: host || "https://us.i.posthog.com",
      capture_pageview: true,
      capture_pageleave: true,
      persistence: "localStorage+cookie",
    });

    initialized = true;
  }, []);

  return <>{children}</>;
}
