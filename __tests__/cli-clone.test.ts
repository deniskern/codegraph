import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
type DatabaseSync = InstanceType<typeof DatabaseSync>;

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function runCodegraph(args: string[], cwd: string): string {
  return execFileSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function dbPath(project: string): string {
  return path.join(project, '.codegraph', 'codegraph.db');
}

describe('codegraph clone', () => {
  let tempDir: string;
  let source: string;
  let target: string;
  let writer: DatabaseSync;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-clone-'));
    source = path.join(tempDir, 'source');
    target = path.join(tempDir, 'target');
    fs.mkdirSync(source);
    fs.mkdirSync(target);
    CodeGraph.initSync(source).close();
    // A live writer whose last commit is still only in the WAL, like a running daemon's.
    writer = new DatabaseSync(dbPath(source));
    writer.exec('PRAGMA wal_autocheckpoint = 0; CREATE TABLE clone_probe(v); INSERT INTO clone_probe VALUES (42);');
  });

  afterEach(() => {
    writer.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function probe(project: string): number {
    const db = new DatabaseSync(dbPath(project), { readOnly: true });
    try {
      return (db.prepare('SELECT v FROM clone_probe').get() as { v: number }).v;
    } finally {
      db.close();
    }
  }

  it('copies commits that are still in the source WAL', () => {
    expect(fs.statSync(dbPath(source) + '-wal').size).toBeGreaterThan(0);
    runCodegraph(['clone', '--source', source, target], tempDir);
    expect(probe(target)).toBe(42);
  });

  it('--force replaces an existing index without replaying its stale WAL', () => {
    CodeGraph.initSync(target).close();
    const stale = new DatabaseSync(dbPath(target));
    stale.exec('PRAGMA wal_autocheckpoint = 0; CREATE TABLE stale_probe(v); INSERT INTO stale_probe VALUES (1);');
    fs.copyFileSync(dbPath(target) + '-wal', path.join(tempDir, 'stale-wal'));
    stale.close();
    fs.copyFileSync(path.join(tempDir, 'stale-wal'), dbPath(target) + '-wal');

    runCodegraph(['clone', '--force', '--source', source, target], tempDir);

    expect(probe(target)).toBe(42);
    expect(fs.existsSync(dbPath(target) + '-wal') && fs.statSync(dbPath(target) + '-wal').size > 0).toBe(false);
  });
});
