import type { Metadata, Viewport } from "next";
import { Inter, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import FeedbackModal from "@/components/feedback/FeedbackModal";
import PostHogProvider from "@/components/providers/PostHogProvider";
import ErrorBoundary from "@/components/providers/ErrorBoundary";
import DataIntegrityBanner from "@/components/ui/DataIntegrityBanner";
import ServiceWorkerRegistrar from "@/components/pwa/ServiceWorkerRegistrar";

const inter = Inter({
  variable: "--font-inter",
  subsets: ["latin"],
  display: "swap",
});

// The design system's display face (globals.css --font-serif expects it); was
// declared but never loaded, so display type silently fell back to Georgia.
const sourceSerif = Source_Serif_4({
  variable: "--font-source-serif",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  title: {
    default: "Havesay: Your whole ballot, explained.",
    template: "%s | Havesay",
  },
  description:
    "See every race on your ballot. Know every candidate. Walk in confident. Nonpartisan voter-candidate matching for every U.S. voter, every race, every state.",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Havesay",
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/icons/apple-touch-icon.png",
  },
  openGraph: {
    title: "Havesay: Your whole ballot, explained.",
    description:
      "Nonpartisan voter-candidate matching for every U.S. voter, every race, every state.",
    type: "website",
  },
};

export const viewport: Viewport = {
  // Civic primary (globals.css --civic-primary). Matches manifest theme_color
  // so the installed PWA title bar and the browser chrome agree.
  themeColor: "#1a2f5c",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-portal="voter"
      className={`${inter.variable} ${sourceSerif.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-[var(--color-bg)] text-[var(--color-text)] font-sans">
        <PostHogProvider>
          <ErrorBoundary>
            <ServiceWorkerRegistrar />
            {/* App-level chrome tagged data-app-chrome so embedded surfaces
                (/embed/*) can hide it. display:contents makes the wrappers inert
                on normal pages (zero layout impact); the embed layout's scoped
                style flips them to display:none. */}
            <div data-app-chrome style={{ display: "contents" }}>
              <DataIntegrityBanner />
            </div>
            {children}
            <div data-app-chrome style={{ display: "contents" }}>
              <FeedbackModal />
            </div>
            <div
              data-app-chrome
              className="border-t border-[var(--color-border)] py-4 text-center text-xs text-[var(--color-text-muted)] bg-[var(--color-bg)]"
            >
              <a href="/privacy" className="hover:text-[var(--color-primary)] underline">Privacy</a>
              <span className="mx-2">&middot;</span>
              <a href="/terms" className="hover:text-[var(--color-primary)] underline">Terms</a>
              <span className="mx-2">&middot;</span>
              <a href="/corrections" className="hover:text-[var(--color-primary)] underline">Corrections</a>
              <span className="mx-2">&middot;</span>
              <a href="/methodology" className="hover:text-[var(--color-primary)] underline">Methodology</a>
              <span className="mx-2">&middot;</span>
              <a href="/support" className="hover:text-[var(--color-primary)] underline">Support</a>
            </div>
          </ErrorBoundary>
        </PostHogProvider>
      </body>
    </html>
  );
}
