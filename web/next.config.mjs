/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prisma's binary engine ships per-platform; mark as external so Next
  // doesn't try to bundle it.
  serverExternalPackages: ["@prisma/client"],
  experimental: {
    // Keep the standalone build small for VPS deployments.
    outputFileTracingRoot: undefined,
  },
};

export default nextConfig;
