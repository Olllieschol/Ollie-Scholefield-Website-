import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    // This app lives inside a larger repo; keep Turbopack from using the parent's config.
    root: path.join(__dirname),
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
