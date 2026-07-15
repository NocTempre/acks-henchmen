/**
 * Build the module's compendium packs: write source JSON to
 * packs/_source/<pack>/ and compile each into a Foundry LevelDB pack at
 * packs/<pack>/ using the official Foundry CLI.
 *
 * All document content lives in tools/pack-data.mjs.
 *
 * Usage:  node tools/build-packs.mjs   (requires dev deps, see package.json)
 */
import { compilePack } from "@foundryvtt/foundryvtt-cli";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { buildProficienciesPowers, buildMacros } from "./pack-data.mjs";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));

async function buildPack(packName, docs) {
  const srcDir = path.join(ROOT, "packs", "_source", packName);
  const dbDir = path.join(ROOT, "packs", packName);

  fs.mkdirSync(srcDir, { recursive: true });
  for (const f of fs.readdirSync(srcDir).filter((f) => f.endsWith(".json"))) fs.rmSync(path.join(srcDir, f));
  for (const doc of docs) {
    const slug = doc.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
    fs.writeFileSync(path.join(srcDir, `${slug}.json`), JSON.stringify(doc, null, 2) + "\n");
  }

  fs.rmSync(dbDir, { recursive: true, force: true });
  await compilePack(srcDir, dbDir, { recursive: false, log: false });
  console.log(`Built pack "${packName}": ${docs.length} document(s) -> ${dbDir}`);
}

await buildPack("proficiencies-powers", buildProficienciesPowers());
await buildPack("macros", buildMacros());
