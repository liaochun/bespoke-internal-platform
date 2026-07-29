/** @type {import('next').NextConfig} */
const nextConfig = {
  // Static export for Cloudflare Pages — no Node server, no API routes,
  // no middleware. Every route is pre-rendered to static HTML/JS at build
  // time; all data access happens client-side against localStorage (see
  // lib/demoStore.ts).
  output: "export",
  images: {
    // next/image's built-in optimizer needs a server; static export can't
    // run it, so images are served as-is.
    unoptimized: true,
  },
  eslint: {
    // This is a demo build assembled from an intentionally partial excerpt —
    // lint the code, but don't let lint warnings block `next build` the way
    // they would in the original project's CI.
    ignoreDuringBuilds: true,
  },
};

module.exports = nextConfig;
