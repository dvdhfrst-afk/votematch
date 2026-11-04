/**
 * Taxonomy-proposal helpers. All writes go through service_role.
 *
 * Design: the database enforces state-machine transitions and validation
 * (see 20260418000001_taxonomy_proposals.sql). These functions are thin
 * wrappers that make the workflow callable from TypeScript — scripts,
 * admin dashboards, etc. They do NOT duplicate server-side validation.
 *
 * Typical flow:
 *   1. createProposal(...)        → status: 'draft'
 *   2. submitProposal(id)         → status: 'under_review' (publicly visible)
 *   3. approveProposal(id, by)    → status: 'approved'  (locked, ready to apply)
 *   4. applyProposal(id, by)      → status: 'applied'   (executes DB changes)
 * Or:
 *   3'. rejectProposal(id, by, reason) → status: 'rejected'
 *   2'. withdrawProposal(id)           → status: 'withdrawn'
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  TaxonomyProposal,
  TaxonomyProposalStatus,
  TaxonomyProposalType,
} from '@/types/database';

export interface CreateProposalInput {
  proposer_name: string;
  proposal_type: TaxonomyProposalType;
  target_sub_dimension_id?: string | null;
  payload: Record<string, unknown>;
  rationale: string;
}

export async function createProposal(
  s: SupabaseClient,
  input: CreateProposalInput,
): Promise<TaxonomyProposal> {
  const { data, error } = await s
    .from('taxonomy_proposals')
    .insert({
      proposer_name: input.proposer_name,
      proposal_type: input.proposal_type,
      target_sub_dimension_id: input.target_sub_dimension_id ?? null,
      payload: input.payload,
      rationale: input.rationale,
      status: 'draft',
    })
    .select()
    .single();
  if (error) throw new Error(`createProposal: ${error.message}`);
  return data as TaxonomyProposal;
}

export async function setProposalStatus(
  s: SupabaseClient,
  id: string,
  patch: {
    status: TaxonomyProposalStatus;
    decision_by?: string;
    decision_reason?: string;
  },
): Promise<TaxonomyProposal> {
  const { data, error } = await s
    .from('taxonomy_proposals')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`setProposalStatus: ${error.message}`);
  return data as TaxonomyProposal;
}

export const submitProposal = (s: SupabaseClient, id: string) =>
  setProposalStatus(s, id, { status: 'under_review' });

export const approveProposal = (s: SupabaseClient, id: string, decision_by: string) =>
  setProposalStatus(s, id, { status: 'approved', decision_by });

export const rejectProposal = (
  s: SupabaseClient,
  id: string,
  decision_by: string,
  decision_reason: string,
) => setProposalStatus(s, id, { status: 'rejected', decision_by, decision_reason });

export const withdrawProposal = (s: SupabaseClient, id: string) =>
  setProposalStatus(s, id, { status: 'withdrawn' });

/**
 * Executes an approved proposal. Calls the apply_taxonomy_proposal() RPC.
 * Returns the affected (or newly-created) sub_dimension id.
 */
export async function applyProposal(
  s: SupabaseClient,
  id: string,
  applier: string,
): Promise<string> {
  const { data, error } = await s.rpc('apply_taxonomy_proposal', {
    proposal_id: id,
    applier,
  });
  if (error) throw new Error(`applyProposal: ${error.message}`);
  return data as string;
}

export async function listProposals(
  s: SupabaseClient,
  status?: TaxonomyProposalStatus,
): Promise<TaxonomyProposal[]> {
  let q = s.from('taxonomy_proposals').select('*').order('created_at', { ascending: false });
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) throw new Error(`listProposals: ${error.message}`);
  return (data ?? []) as TaxonomyProposal[];
}
