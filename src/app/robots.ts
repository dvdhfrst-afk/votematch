import type { MetadataRoute } from 'next';

const BASE = process.env.NEXT_PUBLIC_APP_URL ?? 'https://ballotbridge.org';

/**
 * /robots.txt — opens public surfaces to crawlers, walls off voter-state routes.
 * Council #38 (distribution): BB had no SEO surface. 452K offices + 7K incumbents
 * are sitting in a corpus search engines couldn't find. This is the inbound channel.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: ['/', '/office/', '/officeholder/', '/person/', '/candidate/', '/guide/', '/methodology', '/corrections', '/privacy', '/terms'],
      disallow: ['/api/', '/admin/', '/quick-match', '/ballot', '/thanks', '/subscribe'],
    },
    sitemap: `${BASE}/sitemap.xml`,
  };
}
