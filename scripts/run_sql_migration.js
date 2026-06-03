#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

require('dotenv').config();

const { runPsql, hasDatabaseConfig, getDatabaseConfigError } = require('../utils/db');

async function main() {
  const migrationPath = process.argv[2];
  if (!migrationPath) {
    throw new Error('Usage: node scripts/run_sql_migration.js <path-to-migration.sql>');
  }

  if (!hasDatabaseConfig()) {
    throw new Error(getDatabaseConfigError());
  }

  const resolvedPath = path.resolve(process.cwd(), migrationPath);
  const sql = fs.readFileSync(resolvedPath, 'utf8');
  await runPsql(sql);
  console.log(`Applied migration: ${path.relative(process.cwd(), resolvedPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
