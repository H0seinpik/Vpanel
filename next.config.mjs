/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // TEMPORARY: the sandbox blocks writes to `.next/trace`, so this build is sent
  // to a sibling directory and renamed to `.next` afterwards (see the deploy
  // note in the session log). Remove this line once the build works normally.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Standalone output keeps the Docker image small.
  output: 'standalone',
  experimental: {
    // Server Actions are used for a few mutations; cap the body size.
    serverActions: {
      bodySizeLimit: '2mb',
    },
  },
  async headers() {
    // Baseline security headers. Nginx adds HSTS at the edge in production.
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-DNS-Prefetch-Control', value: 'off' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
