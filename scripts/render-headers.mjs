import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { publicOriginFor, renderHeaders } from "./lib/headers.mjs";

const projectRoot = path.resolve(import.meta.dirname, "..");

const main = async () => {
  const environment = process.argv[2];
  const target = path.join(projectRoot, "dist/client/_headers");
  const source = await readFile(target, "utf8");
  const hosts = JSON.parse(await readFile(path.join(projectRoot, "src/shared/hosts.json"), "utf8"));
  const output = renderHeaders(source, publicOriginFor(environment, process.env.PUBLIC_ORIGIN), hosts);
  await writeFile(target, output);
  console.log(`Rendered dist/client/_headers for ${environment ?? "local"}.`);
};

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
