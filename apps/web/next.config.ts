import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname, "../.."),
  },
  transpilePackages: [
    "@tackle-forger/domain",
    "@tackle-forger/db",
    "@tackle-forger/excel",
    "@tackle-forger/ui",
  ],
};

export default nextConfig;
