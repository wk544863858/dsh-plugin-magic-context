// 生成 assets/contract-template.db：真库 VACUUM INTO 副本 → 清空全部数据行 → VACUUM
// → 用与 mc-contract-freeze 相同口径算 digest，必须等于 docs/contract-freeze.json 基线。
// 真库只读（VACUUM INTO 只读源），符合巡检纪律。
"use strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, copyFileSync, statSync, rmSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.USERPROFILE + "/.local/share/cortexkit/magic-context/context.db";
const BASELINE = join(HERE, "..", "docs", "contract-freeze.json");
const OUT = join(HERE, "..", "assets", "contract-template.db");
const TMP = join(HERE, "..", "assets", ".template-work.db");

const q = (s) => s.replace(/'/g, "''");

// 1) 真库只读 → VACUUM INTO 副本
mkdirSync(join(HERE, "..", "assets"), { recursive: true });
const src = new DatabaseSync(SRC, { readOnly: true });
try {
  rmSync(TMP, { force: true });
  src.exec(`VACUUM INTO '${q(TMP)}'`);
} finally {
  src.close();
}

// 2) 副本清数据：memories 先删（FTS 触发器同步清索引），其余表逐个清；schema_migrations 保留
const db = new DatabaseSync(TMP);
try {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all();
  const SHADOW = /_(config|data|idx|content|docsize)$/;
  const isVirtual = (sql) => /create\s+virtual/i.test(String(sql));
  const virtuals = tables.filter(t => isVirtual(t.sql)).map(t => String(t.name));
  const virtualSet = new Set(virtuals);
  const deletable = tables
    .filter(t => !virtualSet.has(String(t.name)) && !SHADOW.test(String(t.name)))
    .map(t => String(t.name))
    .sort((a, b) => (a === "memories" ? -1 : b === "memories" ? 1 : a.localeCompare(b)));
  db.exec("PRAGMA foreign_keys = OFF");
  // 删除触发器会回填审计行（session_meta / compartment_history_versions 实测），
  // 所以清表循环跑到位：直到一遍没有任何变化（上限 5 轮）。
  for (let pass = 0; pass < 5; pass += 1) {
    let changed = 0;
    for (const name of deletable) {
      if (name === "schema_migrations") continue; // 版本记录保留
      const r = db.prepare(`DELETE FROM "${q(name)}"`).run();
      changed += Number(r.changes);
    }
    if (changed === 0) break;
  }
  for (const name of virtuals) {
    try {
      db.exec(`INSERT INTO "${q(name)}"("${q(name)}") VALUES('delete-all')`);
    } catch {
      // 普通（非 contentless/external）fts5 表不支持 delete-all，直接清表
      db.exec(`DELETE FROM "${q(name)}"`);
    }
  }
  // 真库遗留：fts 本体已空但影子表仍持有孤儿索引块（实测 message_history_fts_data
  // 4423 行 ≈17MB，上游清理路径绕过了 FTS 同步；SQLite 又禁止直接 DML 影子表）。
  // 标准做法：存原句 → DROP → 原句重建。sqlite_master 文本不变 ⇒ digest 不变，影子归零。
  for (const t of tables.filter(t => isVirtual(t.sql))) {
    const name = String(t.name);
    const ddl = String(t.sql);
    db.exec(`DROP TABLE "${q(name)}"`);
    db.exec(ddl);
  }
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'").get() !== undefined) {
    db.exec("DELETE FROM sqlite_sequence");
  }
  // 上游种子行（schema 语义的一部分）：权限闸的缺省行
  if (db.prepare("SELECT name FROM sqlite_master WHERE name = 'context_privilege_state'").get() !== undefined) {
    db.prepare("INSERT OR IGNORE INTO context_privilege_state(id, enabled) VALUES(1, 0)").run();
  }
  db.exec("VACUUM");
} finally {
  db.close();
}

// 3) 与 freeze 同口径验证：直接复用 mc-contract-freeze 的 collectContract
const { collectContract } = await import("./mc-contract-freeze.mjs");
const snap = collectContract(TMP);
const digest = snap.digest;
const version = snap.contractVersion;
const counts = snap.counts;

const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
if (digest !== baseline.digest) {
  console.error("DIGEST MISMATCH：模板形状与冻结基线不一致，不写出模板。");
  console.error("  template digest:", digest.slice(0, 16), "…");
  console.error("  baseline digest:", String(baseline.digest).slice(0, 16), "…");
  console.error("  template version:", version, "| baseline version:", baseline.contractVersion);
  process.exit(1);
}

// 4) 落盘
rmSync(OUT, { force: true });
copyFileSync(TMP, OUT);
rmSync(TMP, { force: true });
console.log("contractVersion =", version);
console.log("counts =", JSON.stringify(counts));
console.log("digest  =", digest.slice(0, 12), "（与基线一致）");
console.log("size    =", statSync(OUT).size, "bytes");
console.log("out     =", OUT);
