/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Use 'export' for Vercel static hosting, 'standalone' for Docker
  output: process.env.DOCKER_BUILD === '1' ? 'standalone' : 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

module.exports = nextConfig;
