/** @type {import('next').NextConfig} */
const nextConfig = {
  // The E2E suite builds into its own folder so it never collides with a developer's running server.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  reactStrictMode: true,
  poweredByHeader: false,
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
  // Runtime files read from disk (service-area list, SQL migrations) must ship with the server bundle.
  outputFileTracingIncludes: { "/**": ["./knowledge/**", "./drizzle/**"] },
  async headers() {
    return [{
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "Cache-Control", value: "no-store" },
      ],
    }];
  },
};
export default nextConfig;
