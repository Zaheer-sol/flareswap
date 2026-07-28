/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Everything here is either statically rendered or client-side; no remote images are used,
  // so the image optimizer stays off and its whole attack surface with it.
  images: {unoptimized: true},
  env: {
    NEXT_PUBLIC_BUILD_TIME: new Date().toISOString(),
  },
};

export default nextConfig;
