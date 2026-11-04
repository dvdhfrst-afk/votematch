import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import CorrectionForm from "@/components/corrections/CorrectionForm";

interface CorrectionPosition {
  id: string;
  sub_dimension_id: string;
  score: number | null;
  view_type: 'stated' | 'inferred';
}

interface SubDimRow {
  id: string;
  name: string;
}

export default async function NewCorrectionPage({
  searchParams,
}: {
  searchParams: Promise<{ candidate_id?: string }>;
}) {
  const { candidate_id } = await searchParams;
  if (!candidate_id) notFound();

  const supabase = await createClient();
  const { data: candidate } = await supabase
    .from("candidates")
    .select("id, name, party")
    .eq("id", candidate_id)
    .eq("published", true)
    .single();
  if (!candidate) notFound();

  const { data: positions } = await supabase
    .from("v_latest_positions")
    .select("id, sub_dimension_id, score, view_type")
    .eq("candidate_id", candidate_id)
    .order("sub_dimension_id");

  const { data: subDims } = await supabase
    .from("sub_dimensions")
    .select("id, name")
    .order("name");

  const subDimsById = new Map<string, SubDimRow>(
    ((subDims ?? []) as SubDimRow[]).map((s) => [s.id, s]),
  );

  const positionOptions = ((positions ?? []) as CorrectionPosition[])
    .filter((p) => p.score !== null)
    .map((p) => ({
      id: p.id,
      label: `${subDimsById.get(p.sub_dimension_id)?.name ?? p.sub_dimension_id} — ${p.view_type === 'stated' ? 'stated' : 'inferred'} (score ${p.score?.toFixed(2) ?? '—'})`,
    }));

  return (
    <main className="min-h-screen bg-[var(--color-bg-alt)]">
      <header className="bg-[var(--color-bg)] border-b border-[var(--color-border)]">
        <div className="civic-container py-4 flex items-center gap-4">
          <Link href="/" className="text-xl font-bold text-[var(--color-primary)]">
            Havesay
          </Link>
        </div>
      </header>

      <div className="civic-container py-8">
        <div className="max-w-2xl mx-auto">
          <Link
            href={`/candidate/${candidate_id}`}
            className="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-primary)] underline"
          >
            ← Back to {candidate.name}
          </Link>

          <h1 className="text-3xl font-extrabold text-[var(--color-primary)] mt-4 mb-2">
            Report an issue
          </h1>
          <p className="text-[var(--color-text-muted)] mb-6">
            Something wrong on <strong>{candidate.name}</strong>&apos;s profile? Tell us which
            position looks off and what evidence you have. We review every submission and
            publish an outcome note at{" "}
            <Link href="/corrections" className="underline hover:text-[var(--color-primary)]">
              /corrections
            </Link>
            .
          </p>

          {positionOptions.length === 0 ? (
            <div className="rounded-md bg-amber-50 border border-amber-200 p-4 text-sm text-amber-900">
              This candidate has no published positions yet, so there&apos;s nothing to
              correct. If you have general feedback (wrong name, wrong party, missing
              profile), please use the <Link href="/" className="underline">home page</Link>{" "}
              feedback prompt.
            </div>
          ) : (
            <CorrectionForm
              candidateId={candidate.id}
              candidateName={candidate.name}
              positions={positionOptions}
            />
          )}
        </div>
      </div>
    </main>
  );
}
