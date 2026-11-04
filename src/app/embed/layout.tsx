/**
 * Embed layout - the chrome-free frame for iframe-embedded widgets.
 *
 * The root layout renders app-level chrome (the data-integrity banner, the
 * feedback modal, the global footer) as siblings of the page. For an embed shown
 * inside a partner newsroom's iframe, none of that belongs. This layout renders a
 * scoped <style> that hides anything tagged data-app-chrome. Because the style
 * tag only exists while an /embed/* route is mounted, normal app pages are
 * unaffected (no global rule), and there is no hydration flash (it is
 * server-rendered).
 *
 * No em-dashes or en-dashes anywhere per the project formatting rule.
 */

export default function EmbedLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* Scoped to embed routes only (the layout is only in the tree here). */}
      <style>{`
        [data-app-chrome] { display: none !important; }
        body { background: var(--civic-surface) !important; }
      `}</style>
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </>
  );
}
