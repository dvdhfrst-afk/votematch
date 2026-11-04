/**
 * Candidate-portal layout.
 *
 * Sets `data-portal="candidate"` on the portal root so per-portal theming
 * tokens (defined in globals.css under `[data-portal="candidate"]`) scope to
 * this subtree. The Voter session owns the actual token values + the shared
 * base in globals.css (see PORTALS-PLAN "Shared foundation"); this layout only
 * sets the attribute so a dual-account user always knows which side they're on.
 * Until those tokens land, the attribute is inert and the portal renders with
 * the shared base palette.
 */
export default function ForCandidatesLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div data-portal="candidate">{children}</div>;
}
