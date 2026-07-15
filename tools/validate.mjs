/**
 * Pre-release validation: JS syntax, JSON validity (module.json, lang,
 * ruledata, pack sources), and Handlebars template compilation (a template
 * parse error otherwise only surfaces at render time inside Foundry).
 *
 * Usage:  node tools/validate.mjs   (run by the release workflow)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import Handlebars from "handlebars";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
let failed = false;

function fail(file, message) {
  console.error(`FAIL ${file}: ${message}`);
  failed = true;
}

function walk(dir, ext, cb) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, ext, cb);
    else if (entry.name.endsWith(ext)) cb(full);
  }
}

for (const dir of ["scripts", "tools"]) {
  walk(path.join(ROOT, dir), ".mjs", (full) => {
    try {
      execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
    } catch (err) {
      fail(path.relative(ROOT, full), String(err.stderr ?? err.message).trim().split("\n")[0]);
    }
  });
}

walk(path.join(ROOT, "templates"), ".hbs", (full) => {
  try {
    Handlebars.precompile(fs.readFileSync(full, "utf8"));
  } catch (err) {
    fail(path.relative(ROOT, full), err.message.split("\n").slice(0, 2).join(" "));
  }
});

for (const file of ["module.json", "lang/en.json", "package.json"]) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
  } catch (err) {
    fail(file, err.message);
  }
}

walk(path.join(ROOT, "ruledata"), ".json", (full) => {
  try {
    const doc = JSON.parse(fs.readFileSync(full, "utf8"));
    if (!doc.id) fail(path.relative(ROOT, full), "ruledata document missing `id`");
  } catch (err) {
    fail(path.relative(ROOT, full), err.message);
  }
});

walk(path.join(ROOT, "packs", "_source"), ".json", (full) => {
  try {
    JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    fail(path.relative(ROOT, full), err.message);
  }
});

// Every localization key referenced in scripts/templates should exist.
const lang = JSON.parse(fs.readFileSync(path.join(ROOT, "lang/en.json"), "utf8"));
const referenced = new Set();
const keyRe = /ACKS-HENCHMEN\.[A-Za-z0-9._-]+/g;
for (const dir of ["scripts", "templates", "ruledata", "tools"]) {
  walk(path.join(ROOT, dir), "", (full) => {
    if (!/[.](mjs|hbs|json)$/.test(full)) return;
    const text = fs.readFileSync(full, "utf8");
    for (const m of text.matchAll(keyRe)) referenced.add(m[0].replace(/[.,]$/, ""));
  });
}
const langKeys = Object.keys(lang);
for (const key of referenced) {
  if (lang[key] !== undefined) continue;
  // Dynamic families: code builds `PREFIX.${value}` — the captured prefix is
  // fine as long as some real key extends it.
  if (langKeys.some((k) => k.startsWith(`${key}.`) || k.startsWith(key))) continue;
  fail("lang/en.json", `missing key referenced in code: ${key}`);
}

if (failed) process.exit(1);
console.log("validate: all scripts, templates, and JSON OK");
