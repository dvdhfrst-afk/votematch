import { redirect } from "next/navigation";
import Link from "next/link";
import { getSessionUser } from "@/lib/session";
import { createServiceClient } from "@/lib/supabase/server";

// ---------------------------------------------------------------------------
// Admin auth gate
// ---------------------------------------------------------------------------
// Hard guard in PRODUCTION: every route under /admin/* requires an authenticated
// user whose `users.role` is `editor` or `admin`. Anything else (anon, voter,
// missing session) redirects to `/`. No silent allow, no fancy role UI.
//
// In DEVELOPMENT (NODE_ENV !== 'production'): the gate is bypassed and the role
// is reported as 'dev-bypass' in the header. This lets the local operator open
// /admin/morning-review and /admin/workers in any browser without setting up email-
// based magic-link auth on a dev box. Production paths are unchanged.
//
// We use the service-role client because `public.users` has RLS; the anon
// client can only see its own row via `session_token()`, which is fine, but
// we want a single canonical gate regardless of RLS quirks. The call is
// cheap (indexed on `id`) and never exposed to a client.
// ---------------------------------------------------------------------------

export const dynamic = "force-dynamic";

const DEV_MODE = process.env.NODE_ENV !== "production";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  let role: string | undefined;

  if (DEV_MODE) {
    // Dev bypass — try to read a real role for display, but never redirect.
    try {
      const user = await getSessionUser();
      if (user) {
        const supabase = await createServiceClient();
        const { data: row } = await supabase
          .from("users")
          .select("id, role")
          .eq("id", user.id)
          .single();
        role = (row as { role?: string } | null)?.role ?? "dev-bypass";
      } else {
        role = "dev-bypass";
      }
    } catch {
      role = "dev-bypass";
    }
  } else {
    const user = await getSessionUser();
    if (!user) {
      redirect("/");
    }

    const supabase = await createServiceClient();
    const { data: row } = await supabase
      .from("users")
      .select("id, role")
      .eq("id", user.id)
      .single();

    role = (row as { role?: string } | null)?.role;
    if (role !== "editor" && role !== "admin") {
      redirect("/");
    }
  }

  return (
    <div className="min-h-screen bg-[var(--civic-surface-muted)]">
      <header className="border-b border-[var(--civic-border)] bg-[var(--civic-surface)]">
        <div className="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link
              href="/admin/morning-review"
              className="text-sm font-semibold text-[var(--civic-text)] tracking-tight"
            >
              Havesay · Admin
            </Link>
            <nav className="flex items-center gap-4 text-sm">
              <Link
                href="/admin/morning-review"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Morning review
              </Link>
              <Link
                href="/admin/candidate-review"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Candidate review
              </Link>
              <Link
                href="/admin/workers"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Workers
              </Link>
              <Link
                href="/admin/endorsements-queue"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Endorsements
              </Link>
              <Link
                href="/admin/events-queue"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Events
              </Link>
              <Link
                href="/admin/corrections-review"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Corrections
              </Link>
              <Link
                href="/admin/dedup-queue"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Dedup
              </Link>
              <Link
                href="/admin/labeling"
                className="text-[var(--civic-text-secondary)] hover:text-[var(--civic-primary)]"
              >
                Labeling
              </Link>
            </nav>
          </div>
          <div className="text-xs civic-mono text-[var(--civic-text-muted)]">
            role: {role}
          </div>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
