/**
 * Canonical pre-release validation for ACKS module repos.
 * Synced from acks-module-template — edit there and run bin/sync-toolchain.mjs;
 * do not hand-edit per module. Module-specific checks belong in
 * tools/test-logic.mjs (run via `npm test`), not here.
 *
 * Checks (each section skips cleanly when the dir/file doesn't exist):
 *   1. JS syntax (node --check) of every .mjs under scripts/ and tools/.
 *   2. Handlebars compilation of every .hbs under templates/ (parse errors
 *      otherwise only surface at render time inside Foundry).
 *   3. JSON validity: module.json, package.json, lang/*.json, ruledata/**
 *      (which must carry an `id`), packs/_source/**.
 *   4. Pack-source invariants: 16-char alphanumeric _id, _key ending in _id,
 *      no duplicate _id within a pack.
 *   5. module.json invariants: semver version, compatibility.minimum present,
 *      declared esmodules/scripts/styles/languages/packs paths exist,
 *      manifest/download point at releases/latest/download.
 *   6. i18n: every "<ID-UPPERCASED>.x" key referenced in scripts/templates/
 *      ruledata exists in lang/en.json (dynamic-suffix tolerant).
 *
 * Usage:  npm run validate
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import Handlebars from "handlebars";

const ROOT = path.dirname(path.dirname(url.fileURLToPath(import.meta.url)));
let failed = false;
const fail = (file, message) => {
  console.error(`FAIL ${file}: ${message}`);
  failed = true;
};
const rel = (full) => path.relative(ROOT, full).replaceAll(path.sep, "/");

function walk(dir, cb) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb);
    else cb(full);
  }
}

/* 1. JS syntax of every script/tool module. */
for (const dir of ["scripts", "tools"]) {
  walk(path.join(ROOT, dir), (full) => {
    if (!full.endsWith(".mjs")) return;
    try {
      execFileSync(process.execPath, ["--check", full], { stdio: "pipe" });
    } catch (err) {
      fail(rel(full), String(err.stderr ?? err.message).trim().split("\n")[0]);
    }
  });
}

/* 2. Handlebars templates precompile. */
walk(path.join(ROOT, "templates"), (full) => {
  if (!full.endsWith(".hbs")) return;
  try {
    Handlebars.precompile(fs.readFileSync(full, "utf8"));
  } catch (err) {
    fail(rel(full), err.message.split("\n").slice(0, 2).join(" "));
  }
});

/* 3. JSON validity. */
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8"));
let module_ = null;
for (const file of ["module.json", "package.json"]) {
  try {
    const parsed = readJson(file);
    if (file === "module.json") module_ = parsed;
  } catch (err) {
    fail(file, err.message);
  }
}
walk(path.join(ROOT, "lang"), (full) => {
  if (!full.endsWith(".json")) return;
  try {
    JSON.parse(fs.readFileSync(full, "utf8"));
  } catch (err) {
    fail(rel(full), err.message);
  }
});
walk(path.join(ROOT, "ruledata"), (full) => {
  if (!full.endsWith(".json")) return;
  try {
    const doc = JSON.parse(fs.readFileSync(full, "utf8"));
    if (!doc.id) fail(rel(full), "ruledata document missing `id`");
  } catch (err) {
    fail(rel(full), err.message);
  }
});

/* 4. Pack-source document invariants, including embedded documents (items /
 *    effects / results / pages, recursively — items can nest effects).
 *    Foundry's DocumentIdField requires exactly 16 alphanumerics everywhere. */
const ID_RE = /^[A-Za-z0-9]{16}$/;
const EMBEDDED_COLLECTIONS = ["items", "effects", "results", "pages"];
function checkDoc(fileRel, doc, ids, context) {
  if (doc._id !== undefined) {
    if (!ID_RE.test(doc._id)) fail(fileRel, `${context}_id "${doc._id}" is not 16 alphanumerics`);
    if (doc._key !== undefined && !String(doc._key).endsWith(doc._id)) fail(fileRel, `${context}_key does not end with _id`);
    if (ids.has(doc._id)) fail(fileRel, `${context}duplicate _id ${doc._id}`);
    ids.add(doc._id);
  }
  for (const collection of EMBEDDED_COLLECTIONS) {
    if (!Array.isArray(doc[collection])) continue;
    const childIds = new Set(); // same child id under different parents is legal
    for (const child of doc[collection]) {
      if (child && typeof child === "object") checkDoc(fileRel, child, childIds, `${collection}: `);
    }
  }
}
const sourceRoot = path.join(ROOT, "packs", "_source");
if (fs.existsSync(sourceRoot)) {
  for (const packDir of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!packDir.isDirectory()) continue;
    const ids = new Set();
    walk(path.join(sourceRoot, packDir.name), (full) => {
      if (!full.endsWith(".json")) return;
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch (err) {
        fail(rel(full), err.message);
        return;
      }
      checkDoc(rel(full), doc, ids, "");
    });
  }
}

/* 5. module.json invariants. */
if (module_) {
  const m = module_;
  if (!m.id) fail("module.json", "missing id");
  if (!/^\d+\.\d+\.\d+$/.test(m.version ?? "")) fail("module.json", `version "${m.version}" is not plain semver X.Y.Z`);
  if (!m.compatibility?.minimum) fail("module.json", "missing compatibility.minimum");
  for (const field of ["esmodules", "scripts", "styles"]) {
    for (const p of m[field] ?? []) {
      if (!fs.existsSync(path.join(ROOT, p))) fail("module.json", `${field} entry "${p}" does not exist`);
    }
  }
  for (const l of m.languages ?? []) {
    if (!fs.existsSync(path.join(ROOT, l.path))) fail("module.json", `language "${l.lang}" path "${l.path}" does not exist`);
  }
  for (const p of m.packs ?? []) {
    const compiled = path.join(ROOT, p.path);
    const source = path.join(sourceRoot, p.name);
    if (!fs.existsSync(compiled) && !fs.existsSync(source)) {
      fail("module.json", `declared pack "${p.name}" has neither ${p.path} nor packs/_source/${p.name}`);
    }
  }
  for (const [field, suffix] of [["manifest", "module.json"], ["download", "module.zip"]]) {
    if (m[field] && !m[field].endsWith(`/releases/latest/download/${suffix}`)) {
      fail("module.json", `${field} should end with /releases/latest/download/${suffix}`);
    }
  }
  if (m.id && path.basename(ROOT) !== m.id) {
    console.warn(`WARN module.json: id "${m.id}" does not match directory name "${path.basename(ROOT)}"`);
  }
}

/* 6. Every localization key referenced in code should exist in lang/en.json. */
if (module_?.id && fs.existsSync(path.join(ROOT, "lang", "en.json"))) {
  const lang = readJson("lang/en.json");
  // Support flat and nested key styles by flattening to dot-paths.
  const langKeys = [];
  (function flatten(obj, prefix) {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") flatten(v, key);
      else langKeys.push(key);
    }
  })(lang, "");
  const keyRe = new RegExp(`${module_.id.toUpperCase()}\\.[A-Za-z0-9._-]+`, "g");
  const referenced = new Set();
  for (const dir of ["scripts", "templates", "ruledata", "tools"]) {
    walk(path.join(ROOT, dir), (full) => {
      if (!/[.](mjs|hbs|json)$/.test(full)) return;
      const text = fs.readFileSync(full, "utf8");
      for (const match of text.matchAll(keyRe)) referenced.add(match[0].replace(/[.,]$/, ""));
    });
  }
  for (const key of referenced) {
    // Dynamic families: code builds `PREFIX.${value}` — the captured prefix is
    // fine as long as some real key extends it.
    if (langKeys.some((k) => k.startsWith(key))) continue;
    fail("lang/en.json", `missing key referenced in code: ${key}`);
  }
}

if (failed) process.exit(1);
console.log("validate: scripts, templates, JSON, packs, module.json, and i18n OK");
