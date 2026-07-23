import tailwindcss from "@tailwindcss/postcss";
import postcss from "postcss";
import type { Plugin } from "vite";

// Vinext's Nitro/RSC child environments do not inherit Vite's root PostCSS
// config lookup. Transform CSS before Vite's built-in import pass so the
// package import in globals.css resolves identically in review builds.
export function vercelTailwind(): Plugin {
  return {
    name: "tackle-forger:vercel-tailwind",
    enforce: "pre",
    async transform(source, id) {
      const filePath = id.split("?", 1)[0];
      if (!filePath.endsWith(".css")) return null;

      const result = await postcss([tailwindcss()]).process(source, {
        from: filePath,
        map: false,
      });
      for (const warning of result.warnings()) this.warn(warning.toString());

      return { code: result.css, map: null };
    },
  };
}
