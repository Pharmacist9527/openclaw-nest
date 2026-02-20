import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

var __dirname = dirname(fileURLToPath(import.meta.url));
var root = join(__dirname, "..");

// Read HTML and create an inline module
var html = readFileSync(join(root, "public", "index.html"), "utf-8");

var inlineHtmlPlugin = {
  name: "inline-html",
  setup(build) {
    build.onResolve({ filter: /\.\/html\.js$/ }, function(args) {
      return { path: args.path, namespace: "inline-html" };
    });
    build.onLoad({ filter: /.*/, namespace: "inline-html" }, function() {
      return {
        contents: "export var INDEX_HTML = " + JSON.stringify(html) + ";",
        loader: "js",
      };
    });
  },
};

await build({
  entryPoints: [join(root, "bin", "nest.js")],
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  outfile: join(root, "dist", "nest.cjs"),
  plugins: [inlineHtmlPlugin],
  external: ["dockerode"],
  minify: false,
  sourcemap: false,
});

console.log("Build complete: dist/nest.cjs");
