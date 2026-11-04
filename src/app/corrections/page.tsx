import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

interface CorrectionRow {
  id: string;
  created_at: string;
  submitted_by: string;
  status: string;
  candidate: { name: string } | null;
  position: { sub_dimension_id: string } | null;
}

export default async function CorrectionsPage() {
  const supabase = await createClient();

  const { data: corrections } = await supabase
    .from("corrections")
    .select("id, created_at, submitted_by, status, candidate:candidates(name), position:positions(sub_dimension_id)")
    .order("created_at", { ascending: false })
    .limit(50);

  const rows = (corrections ?? []) as unknown as CorrectionRow[];

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      {/* Header */}
      <header className="bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center gap-4">
          <Link
            href="/"
            className="text-xl font-bold text-[var(--color-primary)]"
          >
            Havesay
          </Link>
        </div>
      </header>

      <div className="civic-container py-8">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-3xl sm:text-4xl font-extrabold text-[var(--color-primary)] mb-2">
            Public Corrections Log
          </h1>
          <p className="text-[var(--color-text-secondary)] mb-6">
            Transparency is a core principle. Every correction request is
            tracked here.
          </p>

          {/* Council #53 (2026-05-10, voter perspective): #49's ballot-page
              banner sends voters here with the promise "Spot a candidate
              that's missing or wrong? Tell us." But the submission form
              lives at /corrections/new?candidate_id=X — voters arriving at
              the bare /corrections log have no signposted action. Static
              signpost section explains both paths. */}
          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-5 mb-8 text-sm">
            <p className="font-semibold text-[var(--color-text)] mb-2">
              Have a correction?
            </p>
            <ul className="space-y-1.5 text-[var(--color-text-secondary)]">
              <li>
                <span className="font-medium text-[var(--color-text)]">Wrong info on a candidate&apos;s page:</span>{' '}
                visit that candidate&apos;s profile and click <em>Report an issue</em>.
              </li>
              <li>
                <span className="font-medium text-[var(--color-text)]">Candidate missing or general feedback:</span>{' '}
                use the feedback prompt that appears on the home page near election windows, or email{' '}
                <a href="mailto:corrections@example.org" className="underline text-[var(--color-primary)]">
                  corrections@example.org
                </a>.
              </li>
            </ul>
          </div>

          {rows.length === 0 ? (
            <p className="text-[var(--color-text-secondary)] py-8 text-center">
              No corrections have been submitted yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b-2 border-[var(--color-border)]">
                    <th className="py-3 pr-4 font-semibold text-[var(--color-text)]">
                      Date
                    </th>
                    <th className="py-3 pr-4 font-semibold text-[var(--color-text)]">
                      Candidate
                    </th>
                    <th className="py-3 pr-4 font-semibold text-[var(--color-text)]">
                      Reported By
                    </th>
                    <th className="py-3 font-semibold text-[var(--color-text)]">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => (
                    <tr
                      key={c.id}
                      className="border-b border-[var(--color-border)]"
                    >
                      <td className="py-3 pr-4 text-[var(--color-text-secondary)] whitespace-nowrap">
                        {new Date(c.created_at).toLocaleDateString()}
                      </td>
                      <td className="py-3 pr-4 font-medium text-[var(--color-text)]">
                        {c.candidate?.name ?? "Unknown"}
                      </td>
                      <td className="py-3 pr-4 text-[var(--color-text-secondary)]">
                        {c.submitted_by}
                      </td>
                      <td className="py-3">
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-xs font-medium ${
                            c.status === "accepted"
                              ? "bg-green-100 text-green-800"
                              : c.status === "rejected"
                              ? "bg-red-100 text-red-800"
                              : "bg-yellow-100 text-yellow-800"
                          }`}
                        >
                          {c.status.charAt(0).toUpperCase() + c.status.slice(1)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-8">
            <Link
              href="/"
              className="text-[var(--color-primary)] hover:underline font-medium"
            >
              &larr; Back to home
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
