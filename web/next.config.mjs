/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Prisma's binary engine ships per-platform; mark as external so Next
  // doesn't try to bundle it. (Key name is the Next 14 form; in Next 15+
  // it becomes `serverExternalPackages` at the top level.)
  experimental: {
    serverComponentsExternalPackages: ["@prisma/client"],
  },
};

export default nextConfig;
