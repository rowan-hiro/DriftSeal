'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync, execSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DRIFTSEAL = path.join(__dirname, '..', 'bin', 'driftseal.js');

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-test-'));
  const run = (args, opts = {}) =>
    execFileSync(process.execPath, [DRIFTSEAL, ...args], {
      env: { ...process.env, DRIFTSEAL_HOME: dir, DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions') },
      cwd: os.tmpdir(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  const runFail = (args, opts = {}) => {
    try {
      run(args, opts);
    } catch (err) {
      return err;
    }
    throw new Error(`expected failure: driftseal ${args.join(' ')}`);
  };
  const events = () =>
    fs
      .readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
  return { dir, run, runFail, events };
}

function spawnResult(args, env, cwd = os.tmpdir()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [DRIFTSEAL, ...args], {
      env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function setupGitRepository(prefix = 'driftseal-git-test-') {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
  delete env.DRIFTSEAL_HOME;
  delete env.DRIFTSEAL_DECISION_HOME;
  const git = (args, opts = {}) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  const gitFail = (args) => {
    try {
      git(args);
    } catch (err) {
      return err;
    }
    throw new Error(`expected failure: git ${args.join(' ')}`);
  };
  const run = (args, opts = {}) =>
    execFileSync(process.execPath, [DRIFTSEAL, ...args], {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
  const runFail = (args, opts = {}) => {
    try {
      run(args, opts);
    } catch (err) {
      return err;
    }
    throw new Error(`expected failure: driftseal ${args.join(' ')}`);
  };
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  run(['init']);
  git([
    'config',
    '--local',
    'merge.driftseal.driver',
    `${process.execPath} ${DRIFTSEAL} absorb --git %O %A %B`,
  ]);
  return { cwd, env, git, gitFail, run, runFail };
}

/** The remediation command a warning tells the user to run, verbatim. */
function remediationCommand(output) {
  const match = output.match(/run `([^`]+)`/);
  assert.ok(match, `expected a remediation command in: ${output}`);
  return match[1];
}

/**
 * Run a printed remediation through the platform default shell, as a user
 * would paste it. Optional `cwd` is the init directory the warning names.
 */
function runInShell(repo, command, cwd = repo.cwd) {
  return execSync(command, {
    cwd,
    encoding: 'utf8',
    env: repo.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line.length > 0)
    .map(JSON.parse);
}

function protocolV12(content) {
  return content
    .replace('driftseal-version: 13', 'driftseal-version: 12')
    .replace('driftseal-decisions-version: 13', 'driftseal-decisions-version: 12')
    .replace(
      '   `driftseal begin "<what this round will accomplish>" --accept "<observable outcome>" --verify "<exact command that proves it>"`.\n' +
        '   Repeat `--accept` when completion has multiple independently observable criteria.',
      '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.'
    )
    .replace(
      '3. **Reconcile, verify, then close**: for a linked intent, first reconcile every\n' +
        '   declared decision as described below. For an acceptance-bound intent, inspect the\n' +
        '   exact command shown by `driftseal status`, then run `driftseal verify` to execute it\n' +
        '   and bind its exit status to the current Git-visible workspace contents. A command\n' +
        '   sourced from the repository intent log is untrusted and requires\n' +
        '   `--allow-tracked-command` after inspection; locally parked commands do not.\n' +
        '   An intent without `--accept` uses its declared check directly. Then run\n' +
        '   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<optional context for the next agent>"`.\n' +
        '   DriftSeal rejects `completed` when machine verification failed, never ran, or\n' +
        '   the workspace changed after it. Ignored files are outside the workspace fingerprint.\n' +
        '   Outside a Git worktree, only the recorded exit status is available.',
      '3. **Verify, then close**: run the declared verification, then\n' +
        '   `driftseal end -s completed|partial|failed|abandoned -n "<what happened>" -r "<what the verification showed, written for the next agent>"`.'
    );
}

/** A committed repository whose open intents are parked in Git metadata. */
function setupParkedRepository(prefix) {
  const repo = setupGitRepository(prefix);
  repo.git(['add', '.gitattributes', 'AGENTS.md']);
  repo.git(['commit', '-m', 'base protocol']);
  const park = path.resolve(
    repo.cwd,
    repo.git(['rev-parse', '--git-path', 'driftseal-in-progress.jsonl']).trim()
  );
  return {
    ...repo,
    park,
    log: () => readJsonl(path.join(repo.cwd, '.intent-log', 'events.jsonl')),
    parkedRecords: () => readJsonl(park),
  };
}

/** A parked open intent plus an incoming open intent merged in from another branch. */
function setupParkedMergeConflict(prefix) {
  const repo = setupParkedRepository(prefix);
  repo.git(['checkout', '-b', 'incoming']);
  repo.run(['begin', 'incoming open intent'], {
    env: { ...repo.env, DRIFTSEAL_HOME: path.join(repo.cwd, '.intent-log') },
  });
  repo.git(['add', '.intent-log/events.jsonl']);
  repo.git(['commit', '-m', 'incoming open intent']);
  repo.git(['checkout', 'main']);
  repo.run(['begin', 'local parked intent']);
  repo.git(['merge', 'incoming', '--no-ff', '--no-edit']);
  return repo;
}

test('package metadata identifies the DriftSeal CLI, ownership, and support URLs', () => {
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(metadata.name, 'driftseal');
  assert.deepEqual(metadata.bin, {
    driftseal: 'bin/driftseal.js',
    'driftseal-mcp': 'bin/driftseal-mcp.js',
  });
  assert.deepEqual(metadata.repository, {
    type: 'git',
    url: 'git+https://github.com/rowan-hiro/DriftSeal.git',
  });
  assert.equal(metadata.homepage, 'https://github.com/rowan-hiro/DriftSeal#readme');
  assert.deepEqual(metadata.bugs, {
    url: 'https://github.com/rowan-hiro/DriftSeal/issues',
  });
  assert.equal(metadata.author, 'Hiro <rowan_hiro@proton.me>');
});

test('--version and -V print the package version', () => {
  const { run, runFail } = setup();
  const metadata = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(run(['--version']), `${metadata.version}\n`);
  assert.equal(run(['-V']), `${metadata.version}\n`);
  assert.match(run(['help']), /driftseal --version \| -V/);
  assert.match(run(['help']), /driftseal init \[--lang <tag>\] \[--local-log\]/);
  assert.match(run(['help']), /driftseal verify/);
  assert.match(run(['help']), /parks an open intent in Git metadata until end/);
  assert.match(runFail(['--version', 'extra']).stderr, /usage: driftseal --version \| -V/);
});

test('subcommand --help prints its usage and exits 0', () => {
  const { run } = setup();
  const cases = [
    [['decision', 'update', '--help'], /usage: driftseal decision update <id>/],
    [['decision', '--help'], /usage: driftseal decision add\|update\|list\|show/],
    [['decision', 'add', '-h'], /usage: driftseal decision add/],
    [['decision', 'list', '--help'], /usage: driftseal decision list/],
    [['decision', 'show', '--help'], /usage: driftseal decision show/],
    [['begin', '--help'], /usage: driftseal begin/],
    [['verify', '--help'], /usage: driftseal verify/],
    [['end', '--help'], /usage: driftseal end/],
    [['status', '--help'], /usage: driftseal status/],
    [['log', '--help'], /usage: driftseal log/],
    [['hook', 'prompt', '--help'], /driftseal hook prompt\|stop/],
    [['hook', 'stop', '--help'], /driftseal hook prompt\|stop/],
    [['hook', '--help'], /usage: driftseal hook install/],
    [['absorb', '--help'], /usage: driftseal absorb/],
    [['init', '--help'], /usage: driftseal init/],
    [['reclaim', '--help'], /usage: driftseal reclaim/],
    [['unreclaim', '-h'], /usage: driftseal unreclaim/],
    [['mcp', '--help'], /usage: driftseal mcp install/],
    [['skill', '--help'], /usage: driftseal skill install/],
    [['begin', '--verify', 'x', '--help'], /usage: driftseal begin/],
  ];
  for (const [args, pattern] of cases) {
    const out = run(args);
    assert.match(out, pattern, `driftseal ${args.join(' ')}`);
    assert.doesNotMatch(out, /unknown flag/, `driftseal ${args.join(' ')}`);
  }
});

test('subcommand --help prints usage even while a mutation lock is held', () => {
  const { dir, run } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  const out = run(['decision', 'update', '--help']);
  assert.match(out, /usage: driftseal decision update <id>/);
  assert.equal(fs.existsSync(lock), true);
});

test('help after a boolean flag prints usage even while a mutation lock is held', () => {
  const { dir, run } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  const cases = [
    [['begin', '--force', '--help'], /usage: driftseal begin/],
    [['end', '-s', 'completed', '--help'], /usage: driftseal end/],
    [['decision', 'update', '0001', '--note', 'x', '--help'], /usage: driftseal decision update/],
  ];
  for (const [args, pattern] of cases) {
    assert.match(run(args), pattern, `driftseal ${args.join(' ')}`);
  }
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.existsSync(path.join(dir, 'decisions')), false);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), false);
});

test('help after a boolean flag creates no storage directories', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-help-nolock-')));
  const env = { ...process.env };
  delete env.DRIFTSEAL_HOME;
  delete env.DRIFTSEAL_DECISION_HOME;
  const run = (args) =>
    execFileSync(process.execPath, [DRIFTSEAL, ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  assert.match(run(['begin', '--force', '--help']), /usage: driftseal begin/);
  assert.match(run(['end', '-s', 'completed', '--help']), /usage: driftseal end/);
  assert.match(run(['decision', 'update', '0001', '--note', 'x', '--help']), /usage: driftseal decision update/);
  assert.equal(fs.existsSync(path.join(root, '.intent-log')), false);
  assert.equal(fs.existsSync(path.join(root, '.decision-log')), false);
});

test('a --help token consumed as a flag value is not treated as help', () => {
  const { runFail } = setup();
  // parseArgs rejects it: --help is not a valid value for the value-taking --verify.
  const err = runFail(['begin', '--verify', '--help']);
  assert.match(err.stderr, /flag --verify requires a value/);
});

test('begin creates an in_progress intent and prints its id', () => {
  const { run, events } = setup();
  const id = run(['begin', 'add login form', '--verify', 'npm test']).trim();
  assert.match(id, /^\d{4}-\d{2}-\d{2}-001$/);
  const [ev] = events();
  assert.equal(ev.type, 'begin');
  assert.equal(ev.schemaVersion, 4);
  assert.equal(ev.intent, 'add login form');
  assert.deepEqual(ev.acceptance, []);
  assert.equal(ev.verify, 'npm test');
});

test('begin records acceptance criteria and requires a machine verification command', () => {
  const { run, runFail, events } = setup();
  assert.match(
    runFail(['begin', 'missing command', '--accept', 'observable result']).stderr,
    /--accept requires --verify/
  );
  assert.match(
    runFail(['begin', 'blank criterion', '--accept', '   ', '--verify', 'true']).stderr,
    /non-empty observable outcome/
  );

  run([
    'begin',
    'acceptance-bound work',
    '--accept',
    'first observable result',
    '--accept',
    'second observable result',
    '--verify',
    'true',
  ]);
  assert.deepEqual(events()[0].acceptance, [
    'first observable result',
    'second observable result',
  ]);
});

test('machine verification records evidence and blocks failed completion', () => {
  const { run, runFail, events } = setup();
  const id = run([
    'begin',
    'prove a failing command',
    '--accept',
    'the command exits successfully',
    '--verify',
    `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
  ]).trim();

  const failure = runFail(['verify']);
  assert.equal(failure.status, 7);
  const verification = events().find((event) => event.type === 'verify');
  assert.equal(verification.id, id);
  assert.equal(verification.passed, false);
  assert.equal(verification.exitCode, 7);
  assert.match(verification.outputHash, /^[a-f0-9]{64}$/);
  assert.equal(verification.workspace, null);
  assert.match(run(['status']), /machine-verification: failed/);
  assert.match(runFail(['end', '--status', 'completed']).stderr, /without successful machine verification/);
  assert.equal(run(['end', '--status', 'failed']).trim(), `${id} failed`);
});

test('machine verification is opt-in and requires an open acceptance-bound intent', () => {
  const { run, runFail } = setup();
  assert.match(runFail(['verify']).stderr, /no intent in progress/);
  run(['begin', 'manual compatibility round', '--verify', 'true']);
  assert.match(runFail(['verify']).stderr, /has no acceptance criteria/);
  run(['end', '--status', 'completed']);
});

test('completed acceptance-bound intents require fresh workspace-bound verification', () => {
  const { cwd, git, run, runFail } = setupGitRepository('driftseal-machine-proof-');
  fs.writeFileSync(path.join(cwd, 'work.txt'), 'before\n');
  git(['add', '.gitattributes', 'AGENTS.md', 'work.txt']);
  git(['commit', '-m', 'base']);

  const id = run([
    'begin',
    'change tracked content',
    '--accept',
    'the declared check passes for the resulting workspace',
    '--verify',
    `${JSON.stringify(process.execPath)} -e "process.stdout.write('verified')"`,
  ]).trim();
  const verified = run(['verify']);
  assert.match(verified, /verified/);
  assert.match(verified, /verification passed/);

  fs.writeFileSync(path.join(cwd, 'work.txt'), 'after\n');
  assert.match(runFail(['end', '--status', 'completed']).stderr, /workspace changed/);

  run(['verify']);
  assert.equal(run(['end', '--status', 'completed']).trim(), `${id} completed`);

  const history = run(['log', '--last', '1']);
  assert.match(history, /accept: the declared check passes/);
  assert.match(history, /machine-verification: passed/);
});

test('tracked-log verification commands require explicit opt-in before execution', () => {
  const { cwd, git, run, runFail, park } = setupParkedRepository(
    'driftseal-tracked-verifier-'
  );
  const marker = path.join(cwd, 'tracked-command-ran.txt');
  const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran\\n')`;
  const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;

  run([
    'begin',
    'repository-supplied verification command',
    '--accept',
    'the command runs only after explicit trust',
    '--verify',
    command,
  ]);
  const intentLog = path.join(cwd, '.intent-log', 'events.jsonl');
  fs.mkdirSync(path.dirname(intentLog), { recursive: true });
  fs.copyFileSync(park, intentLog);
  fs.unlinkSync(park);
  git(['add', '.intent-log/events.jsonl']);
  git(['commit', '-m', 'ship an open intent']);

  const denied = runFail(['verify']);
  assert.match(denied.stderr, /verification command:/);
  assert.match(denied.stderr, /sourced from the repository intent log/);
  assert.match(denied.stderr, /--allow-tracked-command/);
  assert.equal(fs.existsSync(marker), false);

  const allowed = run(['verify', '--allow-tracked-command']);
  assert.match(allowed, /verification passed/);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'ran\n');
  run(['end', '--status', 'abandoned']);
});

test('acceptance-bound linked intents reconcile before verification and complete', () => {
  const { run } = setupParkedRepository('driftseal-acceptance-decision-order-');
  run([
    'decision',
    'add',
    'Confirm the linked acceptance decision',
    '--context',
    'The acceptance-bound workflow links a decision.',
    '--outcome',
    'Reconcile it before machine verification.',
    '--status',
    'proposed',
  ]);
  const id = run([
    'begin',
    'complete linked acceptance work',
    '--accept',
    'the linked decision and declared check are current',
    '--verify',
    'true',
    '--decision',
    '1',
  ]).trim();

  run([
    'decision',
    'update',
    '1',
    '--status',
    'accepted',
    '--note',
    'Confirmed before running the final machine verification.',
  ]);
  run(['verify']);
  assert.equal(run(['end', '--status', 'completed']).trim(), `${id} completed`);
});

test('begin is rejected while another intent is open', () => {
  const { run, runFail } = setup();
  run(['begin', 'first']);
  const err = runFail(['begin', 'second']);
  assert.match(err.stderr, /still in_progress/);
});

test('begin --force abandons the open intent', () => {
  const { run, events } = setup();
  run(['begin', 'first']);
  const id = run(['begin', 'second', '--force']).trim();
  const evs = events();
  assert.equal(evs[1].type, 'end');
  assert.equal(evs[1].status, 'abandoned');
  assert.equal(evs[2].type, 'begin');
  assert.equal(evs[2].id, id);
  assert.notEqual(evs[0].id, id);
});

test('begin --force cancels pending reconciliation and respects prior cancellation', () => {
  const first = setup();
  first.run(['decision', 'add', 'Force-close decision', '-c', 'context', '-o', 'outcome']);
  const abandonedId = first.run(['begin', 'interrupted linked work', '--decision', '1']).trim();
  first.runFail(['decision', 'update', '1', '--note', 'Prepared only.'], {
    env: {
      ...process.env,
      DRIFTSEAL_HOME: first.dir,
      DRIFTSEAL_DECISION_HOME: path.join(first.dir, 'decisions'),
      _DRIFTSEAL_TEST_CRASH_AFTER_RECONCILIATION_PREPARE: '1',
    },
  });
  first.run(['begin', 'replacement work', '--force']);
  const abandonedEvents = first.events().filter((event) => event.id === abandonedId);
  assert.ok(abandonedEvents.some((event) => event.type === 'decision_reconcile_cancel'));
  assert.equal(abandonedEvents.find((event) => event.type === 'end').status, 'abandoned');

  const second = setup();
  second.run(['decision', 'add', 'Failed-close decision', '-c', 'context', '-o', 'outcome']);
  const failedId = second.run(['begin', 'failed linked work', '--decision', '1']).trim();
  second.runFail(['decision', 'update', '1', '--note', 'Prepared only.'], {
    env: {
      ...process.env,
      DRIFTSEAL_HOME: second.dir,
      DRIFTSEAL_DECISION_HOME: path.join(second.dir, 'decisions'),
      _DRIFTSEAL_TEST_CRASH_AFTER_RECONCILIATION_PREPARE: '1',
    },
  });
  second.runFail(['end', '--status', 'failed'], {
    env: {
      ...process.env,
      DRIFTSEAL_HOME: second.dir,
      DRIFTSEAL_DECISION_HOME: path.join(second.dir, 'decisions'),
      _DRIFTSEAL_TEST_CRASH_AFTER_RECONCILIATION_CANCEL: '1',
    },
  });
  second.run(['begin', 'replacement after failed close', '--force']);
  const failedEvents = second.events().filter((event) => event.id === failedId);
  assert.equal(failedEvents.find((event) => event.type === 'end').status, 'failed');
});

test('begin and end record the git head in a git repository', () => {
  const { cwd, git, run } = setupGitRepository();
  git(['add', '.gitattributes', 'AGENTS.md']);
  git(['commit', '-m', 'base protocol']);
  const beginHead = git(['rev-parse', 'HEAD']).trim();

  run(['begin', 'head tracking', '--verify', 'true']);
  assert.match(run(['status']), new RegExp(`head: ${beginHead}`));

  fs.writeFileSync(path.join(cwd, 'work.txt'), 'work');
  git(['add', 'work.txt']);
  git(['commit', '-m', 'work']);
  const endHead = git(['rev-parse', 'HEAD']).trim();
  assert.notEqual(beginHead, endHead);

  run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  assert.match(run(['log']), new RegExp(`head: ${beginHead}\\.\\.${endHead}`));

  const evs = readJsonl(path.join(cwd, '.intent-log', 'events.jsonl'));
  assert.equal(evs.find((event) => event.type === 'begin').head, beginHead);
  assert.equal(evs.find((event) => event.type === 'end').head, endHead);
});

test('begin and end record a null head outside a git repository', () => {
  const { run, events } = setup();
  run(['begin', 'no repo work']);
  assert.doesNotMatch(run(['status']), /head:/);
  run(['end', '--status', 'completed', '--note', 'done']);
  const [beginEv, endEv] = events();
  assert.equal(beginEv.head, null);
  assert.equal(endEv.head, null);
  assert.doesNotMatch(run(['log']), /head:/);
});

test('absorb preserves head fields on remapped events', () => {
  const repo = setupGitRepository();
  repo.git(['add', '.gitattributes', 'AGENTS.md']);
  repo.git(['commit', '-m', 'base protocol']);
  const head = repo.git(['rev-parse', 'HEAD']).trim();
  repo.run(['begin', 'head source']);
  repo.run(['end', '--status', 'completed', '--note', 'done']);

  const ours = setup();
  ours.run(['begin', 'ours work']);
  ours.run(['end', '--status', 'completed', '--note', 'done']);
  ours.run(['absorb', path.join(repo.cwd, '.intent-log', 'events.jsonl')]);

  const absorbedBegin = ours
    .events()
    .find((event) => event.type === 'begin' && event.intent === 'head source');
  assert.match(absorbedBegin.id, /-002$/);
  assert.equal(absorbedBegin.head, head);
  const absorbedEnd = ours
    .events()
    .find((event) => event.type === 'end' && event.id === absorbedBegin.id);
  assert.equal(absorbedEnd.head, head);
});

test('escape closes record the head in a git repository', () => {
  const { cwd, git, run } = setupGitRepository();
  git(['add', '.gitattributes', 'AGENTS.md']);
  git(['commit', '-m', 'base protocol']);
  const head = git(['rev-parse', 'HEAD']).trim();

  run(['begin', 'head abandoned']);
  run(['end', '--status', 'abandoned', '--note', 'gave up']);
  run(['begin', 'head forced out']);
  run(['begin', 'head replacement', '--force']);

  const ends = readJsonl(path.join(cwd, '.intent-log', 'events.jsonl')).filter(
    (event) => event.type === 'end'
  );
  assert.equal(ends.length, 2);
  assert.ok(ends.every((event) => event.status === 'abandoned'));
  for (const end of ends) assert.equal(end.head, head);
});

test('absorb --abandon-theirs records the head on the synthesized end event', () => {
  const { git, run, log } = setupParkedMergeConflict('driftseal-git-park-absorb-head-');
  const head = git(['rev-parse', 'HEAD']).trim();

  run(['absorb', '--abandon-theirs']);
  const absorbed = log();
  const synthesizedEnd = absorbed.find((event) => event.type === 'end');
  assert.equal(synthesizedEnd.status, 'abandoned');
  assert.equal(synthesizedEnd.head, head);

  const beginHead = absorbed.find((event) => event.type === 'begin').head;
  assert.match(run(['log']), new RegExp(`head: ${beginHead}\\.\\.${head}`));
});

test('log and status treat a non-string head as null instead of crashing', () => {
  const { dir, run } = setup();
  const corrupt = [
    {
      type: 'begin',
      id: '2026-01-01-001',
      ts: '2026-01-01T00:00:00.000Z',
      intent: 'closed with a corrupt end head',
      verify: null,
      decisions: [],
      head: 'abc123',
    },
    {
      type: 'end',
      id: '2026-01-01-001',
      ts: '2026-01-01T01:00:00.000Z',
      status: 'completed',
      note: null,
      verifyResult: null,
      head: 42,
    },
    {
      type: 'begin',
      id: '2026-01-01-002',
      ts: '2026-01-01T02:00:00.000Z',
      intent: 'open with a corrupt begin head',
      verify: null,
      decisions: [],
      head: {},
    },
  ];
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    corrupt.map((event) => JSON.stringify(event)).join('\n') + '\n'
  );

  const log = run(['log']);
  assert.match(log, /closed with a corrupt end head/);
  assert.match(log, /head: abc123\.\.-/);
  assert.doesNotMatch(log, /head: abc123\.\.42/);

  const status = run(['status']);
  assert.match(status, /open with a corrupt begin head/);
  assert.doesNotMatch(status, /head:/);
});

test('mutation lock rejects active owners and recovers dead owners', () => {
  const { dir, run, runFail } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  assert.match(runFail(['begin', 'blocked']).stderr, /another DriftSeal mutation is in progress/);

  fs.rmSync(lock, { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: 99999999, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  assert.match(run(['begin', 'after stale lock']), /-001/);
  assert.equal(fs.existsSync(lock), false);
});

test('mutation lock recovers malformed locks and covers a shared decision root', () => {
  const { dir, run, runFail } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock, { recursive: true });
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  run(['begin', 'after malformed stale lock']);
  run(['end']);

  const decisions = path.join(dir, 'decisions');
  const decisionLock = path.join(decisions, '.driftseal.lock');
  fs.mkdirSync(decisionLock, { recursive: true });
  fs.writeFileSync(
    path.join(decisionLock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  const alternateLog = path.join(dir, 'alternate-log');
  assert.match(
    runFail(['decision', 'add', 'Shared root', '-c', 'context', '-o', 'outcome'], {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: alternateLog,
        DRIFTSEAL_DECISION_HOME: decisions,
      },
    }).stderr,
    /another DriftSeal mutation is in progress/
  );
  assert.equal(fs.existsSync(path.join(alternateLog, '.driftseal.lock')), false);
});

test('mutation lock initialization failure removes the unowned lock', () => {
  const { dir, run, runFail } = setup();
  const env = {
    ...process.env,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
    _DRIFTSEAL_TEST_FAIL_LOCK_OWNER_INIT: '1',
  };
  assert.match(
    runFail(['begin', 'interrupted lock setup'], { env }).stderr,
    /simulated lock owner initialization failure/
  );
  assert.equal(fs.existsSync(path.join(dir, '.driftseal.lock')), false);
  assert.match(run(['begin', 'retry after lock setup failure']), /-001/);
});

test('unowned lock directories recover after a short initialization grace', () => {
  const { dir, run, runFail } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock);

  assert.match(runFail(['begin', 'blocked during lock initialization']).stderr, /mutation is in progress/);

  const old = new Date(Date.now() - 10 * 1000);
  fs.utimesSync(lock, old, old);
  assert.match(run(['begin', 'recover abandoned lock initialization']), /-001/);
  assert.equal(fs.existsSync(lock), false);
});

test('stale locks without process-start identity use the age fallback', () => {
  const { dir, run } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  assert.match(
    run(['begin', 'recover reused pid lock'], {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: dir,
        DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
        _DRIFTSEAL_TEST_NO_PROCESS_START_TOKEN: '1',
      },
    }),
    /-001/
  );
});

test('macOS preserves old locks held by the same process instance', () => {
  if (process.platform !== 'darwin') return;
  const { dir, runFail } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  const started = execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(process.pid)], {
    encoding: 'utf8',
    env: { ...process.env, LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
  }).trim();
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      processStart: `darwin:${started}`,
      startedAt: new Date().toISOString(),
    })
  );
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);

  assert.match(runFail(['begin', 'must stay blocked']).stderr, /another DriftSeal mutation is in progress/);
  assert.equal(fs.existsSync(lock), true);
});

test('Windows preserves old locks held by the same process instance', () => {
  if (process.platform !== 'win32') return;
  const { dir, runFail } = setup();
  const lock = path.join(dir, '.driftseal.lock');
  const script =
    `$start = (Get-Process -Id ${process.pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks; ` +
    '[Console]::Write($start.ToString([Globalization.CultureInfo]::InvariantCulture))';
  const started = execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true }
  ).trim();
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      processStart: `win32:${started}`,
      startedAt: new Date().toISOString(),
    })
  );
  const old = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(lock, old, old);

  assert.match(runFail(['begin', 'must stay blocked']).stderr, /another DriftSeal mutation is in progress/);
  assert.equal(fs.existsSync(lock), true);
});

test('status and log fall back to read-only reads when a mutation lock is held', async () => {
  const { dir, run } = setup();
  const intentId = run(['begin', 'open during read contention']).trim();
  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  const env = {
    ...process.env,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
    _DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS: '50',
  };

  const status = run(['status'], { env });
  assert.match(status, /\(read-only: another mutation holds the lock; tail repair skipped\)/);
  assert.match(status, /in_progress/);
  const log = run(['log'], { env });
  assert.match(log, /read-only: another mutation holds the lock/);
  assert.match(log, new RegExp(`\\[${intentId}\\] in_progress`));

  const hook = await spawnResult(['hook', 'stop'], env);
  assert.equal(hook.code, 0);
  assert.match(hook.stdout, /still in_progress/);
  assert.match(hook.stderr, /read-only: another mutation holds the lock/);
  assert.equal(fs.existsSync(lock), true);

  fs.rmSync(lock, { recursive: true });
  const clean = run(['status']);
  assert.doesNotMatch(clean, /read-only/);
  assert.match(clean, /open during read contention/);
});

test('read-only fallback ignores a torn tail without repairing it', () => {
  const { dir, run } = setup();
  const eventFile = path.join(dir, 'events.jsonl');
  const intentId = run(['begin', 'complete before read-only torn tail']).trim();
  run(['end']);
  fs.appendFileSync(eventFile, '{"schemaVersion":3,"type":"begin"');
  const torn = fs.readFileSync(eventFile, 'utf8');

  const lock = path.join(dir, '.driftseal.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  const env = {
    ...process.env,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
    _DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS: '50',
  };

  const degraded = run(['log'], { env });
  assert.match(degraded, /read-only: another mutation holds the lock/);
  assert.match(degraded, new RegExp(`\\[${intentId}\\] completed`));
  assert.equal(fs.readFileSync(eventFile, 'utf8'), torn);

  fs.rmSync(lock, { recursive: true });
  assert.match(run(['log']), new RegExp(`\\[${intentId}\\] completed`));
  const repaired = fs.readFileSync(eventFile, 'utf8');
  assert.ok(repaired.endsWith('\n'));
  assert.doesNotThrow(() => repaired.trim().split('\n').map(JSON.parse));
});

test('read-only fallback performs no park-file writes or deletes', () => {
  const { cwd, env, run, park } = setupParkedRepository('driftseal-readonly-park-');
  const id = run(['begin', 'parked work under lock']).trim();
  const parkedLine = fs.readFileSync(park, 'utf8');
  const other = `${id.slice(0, -3)}009`;
  const ts = new Date().toISOString();
  // A flush that wrote the log but could not unlink the park, then a merge appending after it.
  fs.mkdirSync(path.join(cwd, '.intent-log'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.intent-log', 'events.jsonl'),
    parkedLine +
      JSON.stringify({ schemaVersion: 3, type: 'begin', id: other, ts, intent: 'merged in' }) +
      '\n' +
      JSON.stringify({ schemaVersion: 3, type: 'end', id: other, ts, status: 'completed' }) +
      '\n'
  );

  const lock = path.join(cwd, '.intent-log', '.driftseal.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  const degraded = run(['status'], {
    env: { ...env, _DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS: '50' },
  });
  assert.match(degraded, /read-only: another mutation holds the lock/);
  assert.match(degraded, /parked work under lock/);
  assert.equal(fs.existsSync(park), true);
  assert.equal(fs.readFileSync(park, 'utf8'), parkedLine);

  fs.rmSync(lock, { recursive: true });
  const clean = run(['status']);
  assert.doesNotMatch(clean, /read-only/);
  assert.match(clean, /parked work under lock/);
  assert.equal(fs.existsSync(park), false);
});

function holdLogLock(logDirPath) {
  const lock = path.join(logDirPath, '.driftseal.lock');
  fs.mkdirSync(logDirPath, { recursive: true });
  fs.mkdirSync(lock);
  fs.writeFileSync(
    path.join(lock, 'owner.json'),
    JSON.stringify({ pid: process.pid, hostname: os.hostname(), startedAt: new Date().toISOString() })
  );
  return lock;
}

test('read-only status and log survive the park vanishing mid-read', () => {
  const { cwd, env, run, park } = setupParkedRepository('driftseal-readonly-toctou-');
  run(['begin', 'parked intent racing a flush']);
  const lock = holdLogLock(path.join(cwd, '.intent-log'));
  const raceEnv = {
    ...env,
    _DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS: '50',
    _DRIFTSEAL_TEST_UNLINK_PARK_BEFORE_READ: '1',
  };

  const status = run(['status'], { env: raceEnv });
  assert.match(status, /read-only: another mutation holds the lock/);
  assert.match(status, /no intent in progress/);
  assert.equal(fs.existsSync(park), false);
  assert.equal(fs.existsSync(lock), true);

  const log = run(['log'], { env: raceEnv });
  assert.match(log, /read-only: another mutation holds the lock/);
  assert.match(log, /log is empty/);
});

test('read-only status re-reads the main log when the park flush lands mid-read', () => {
  const { cwd, env, run, park } = setupParkedRepository('driftseal-readonly-flush-race-');
  run(['begin', 'flushed during a read-only status']);
  const logDirPath = path.join(cwd, '.intent-log');
  fs.mkdirSync(logDirPath, { recursive: true });
  // The writer's flush appended the park to the main log but has not unlinked it yet.
  fs.writeFileSync(path.join(logDirPath, 'events.jsonl'), fs.readFileSync(park, 'utf8'));
  holdLogLock(logDirPath);

  const status = run(['status'], {
    env: {
      ...env,
      _DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS: '50',
      _DRIFTSEAL_TEST_UNLINK_PARK_BEFORE_READ: '1',
    },
  });
  assert.match(status, /read-only: another mutation holds the lock/);
  assert.match(status, /flushed during a read-only status/);
  assert.match(status, /in_progress/);
  assert.equal(fs.existsSync(park), false);
});

test('hook from a subdirectory contends on the root log lock, not a cwd-relative one', async () => {
  const { cwd, env, run, park } = setupParkedRepository('driftseal-hook-subdir-lock-');
  run(['begin', 'parked intent behind the root lock']);
  const parkedLine = fs.readFileSync(park, 'utf8');
  const nested = path.join(cwd, 'packages', 'app');
  fs.mkdirSync(nested, { recursive: true });
  const lock = holdLogLock(path.join(cwd, '.intent-log'));

  const hook = await spawnResult(
    ['hook', 'stop'],
    { ...env, _DRIFTSEAL_TEST_READ_ONLY_LOCK_WAIT_MS: '50' },
    nested
  );
  assert.equal(hook.code, 0);
  assert.match(hook.stdout, /still in_progress/);
  assert.match(hook.stderr, /read-only: another mutation holds the lock/);
  assert.equal(fs.existsSync(path.join(nested, '.intent-log')), false);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(fs.readFileSync(park, 'utf8'), parkedLine);
});

test('hook in a repository without any intent log creates no directories', () => {
  const { cwd, run } = setupGitRepository('driftseal-hook-no-log-');
  const nested = path.join(cwd, 'sub');
  fs.mkdirSync(nested);

  assert.equal(run(['hook', 'prompt'], { cwd: nested }), '');
  assert.equal(run(['hook', 'stop'], { cwd: nested }), '');
  assert.equal(fs.existsSync(path.join(cwd, '.intent-log')), false);
  assert.equal(fs.existsSync(path.join(nested, '.intent-log')), false);
});

test('normal lock release failures make the mutation fail visibly', () => {
  const { dir, run, runFail } = setup();
  assert.match(
    runFail(['begin', 'release must be durable'], {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: dir,
        DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
        _DRIFTSEAL_TEST_FAIL_LOCK_RELEASE: '1',
      },
    }).stderr,
    /simulated lock release failure/
  );
  assert.equal(fs.existsSync(path.join(dir, '.driftseal.lock')), true);
  assert.match(run(['status']), /release must be durable/);
  run(['end']);
  assert.equal(fs.existsSync(path.join(dir, '.driftseal.lock')), false);
});

test('mutation locks deduplicate roots that resolve to the same directory', () => {
  if (process.platform === 'win32') return;
  const { dir, run } = setup();
  const shared = path.join(dir, 'shared-state');
  const alias = path.join(dir, 'shared-state-alias');
  fs.mkdirSync(shared);
  fs.symlinkSync(shared, alias, 'dir');
  const output = run(
    ['decision', 'add', 'Aliased roots', '-c', 'context', '-o', 'outcome'],
    {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: shared,
        DRIFTSEAL_DECISION_HOME: alias,
      },
    }
  ).trim();
  assert.match(output, /0001-aliased-roots\.md$/);
  assert.equal(fs.existsSync(path.join(shared, '0001-aliased-roots.md')), true);
  assert.equal(fs.existsSync(path.join(shared, '.driftseal.lock')), false);
});

test('concurrent begin attempts create exactly one open intent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-concurrent-'));
  const env = {
    ...process.env,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
  };
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, index) => spawnResult(['begin', `concurrent ${index}`], env))
  );
  assert.equal(results.filter((result) => result.code === 0).length, 1);
  assert.ok(
    results
      .filter((result) => result.code !== 0)
      .every((result) => /mutation is in progress|still in_progress/.test(result.stderr))
  );
  const eventLines = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n');
  assert.equal(eventLines.length, 1);
  assert.equal(JSON.parse(eventLines[0]).type, 'begin');
});

test('intent folding rejects duplicate ids and multiple open intents', () => {
  const { dir, runFail } = setup();
  const eventFile = path.join(dir, 'events.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const begin = (id, intent) => JSON.stringify({ type: 'begin', id, ts: new Date().toISOString(), intent });

  fs.writeFileSync(eventFile, begin('2026-01-01-001', 'first') + '\n' + begin('2026-01-01-001', 'duplicate') + '\n');
  assert.match(runFail(['status']).stderr, /duplicate begin event/);

  fs.writeFileSync(eventFile, begin('2026-01-01-001', 'first') + '\n' + begin('2026-01-01-002', 'second') + '\n');
  assert.match(runFail(['status']).stderr, /multiple intents in progress/);
});

test('event schema fails closed on newer clients and unreconciled legacy closure', () => {
  const { dir, runFail } = setup();
  const eventFile = path.join(dir, 'events.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    eventFile,
    JSON.stringify({ schemaVersion: 999, type: 'begin', id: 'x', ts: 'now', intent: 'future' }) + '\n'
  );
  assert.match(runFail(['status']).stderr, /requires a newer DriftSeal client/);

  fs.writeFileSync(
    eventFile,
    [
      {
        schemaVersion: 4,
        type: 'begin',
        id: '2026-01-01-001',
        ts: 'now',
        intent: 'acceptance-bound',
        acceptance: ['observable outcome'],
        verify: 'true',
      },
      {
        schemaVersion: 4,
        type: 'end',
        id: '2026-01-01-001',
        ts: 'later',
        status: 'completed',
      },
    ].map(JSON.stringify).join('\n') + '\n'
  );
  assert.match(runFail(['log']).stderr, /without successful machine verification/);

  fs.writeFileSync(
    eventFile,
    [
      { type: 'begin', id: '2026-01-01-001', ts: 'now', intent: 'linked', decisions: ['0001'] },
      { type: 'end', id: '2026-01-01-001', ts: 'later', status: 'completed' },
    ].map(JSON.stringify).join('\n') + '\n'
  );
  assert.match(runFail(['log']).stderr, /closed without reconciling/);

  fs.writeFileSync(
    eventFile,
    JSON.stringify({ type: 'begin', id: '2026-01-01-001', ts: 'now', intent: 'bad', decisions: [1] }) + '\n'
  );
  assert.match(runFail(['status']).stderr, /invalid decision id/);

  fs.writeFileSync(
    eventFile,
    [
      {
        schemaVersion: 2,
        type: 'begin',
        id: '2026-01-01-001',
        ts: 'now',
        intent: 'v2 linked',
        decisions: ['0001'],
      },
      {
        type: 'decision_reconcile',
        id: '2026-01-01-001',
        decisionId: '0001',
        ts: 'later',
        fromStatus: 'accepted',
        toStatus: 'accepted',
        note: 'legacy',
      },
      { type: 'end', id: '2026-01-01-001', ts: 'last', status: 'completed' },
    ].map(JSON.stringify).join('\n') + '\n'
  );
  assert.match(runFail(['log']).stderr, /schema-v2 intent.*legacy decision reconciliation/);

  fs.writeFileSync(
    eventFile,
    [
      {
        schemaVersion: 2,
        type: 'begin',
        id: '2026-01-01-001',
        ts: 'now',
        intent: 'v2 linked',
        decisions: ['0001'],
      },
      {
        schemaVersion: 2,
        type: 'decision_reconcile_commit',
        id: '2026-01-01-001',
        decisionId: '0001',
        reconciliationId: 'orphan',
        ts: 'later',
        fromStatus: 'accepted',
        toStatus: 'accepted',
        note: 'orphan',
        fileHash: 'a'.repeat(64),
      },
    ].map(JSON.stringify).join('\n') + '\n'
  );
  assert.match(runFail(['status']).stderr, /no matching prepare/);
});

test('reconciliation events enforce one matched terminal per unique prepare', () => {
  const { dir, runFail } = setup();
  const eventFile = path.join(dir, 'events.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const begin = {
    schemaVersion: 2,
    type: 'begin',
    id: '2026-01-01-001',
    ts: 'now',
    intent: 'linked',
    decisions: ['0001', '0002'],
  };
  const prepare = {
    schemaVersion: 2,
    type: 'decision_reconcile_prepare',
    id: begin.id,
    decisionId: '0001',
    reconciliationId: 'transaction-1',
    ts: 'later',
    fromStatus: 'accepted',
    toStatus: 'deferred',
    oldHash: 'a'.repeat(64),
    newHash: 'b'.repeat(64),
  };
  const commit = {
    schemaVersion: 2,
    type: 'decision_reconcile_commit',
    id: begin.id,
    decisionId: '0001',
    reconciliationId: prepare.reconciliationId,
    ts: 'last',
    fromStatus: 'accepted',
    toStatus: 'deferred',
    fileHash: prepare.newHash,
  };
  const writeEvents = (records) =>
    fs.writeFileSync(eventFile, records.map(JSON.stringify).join('\n') + '\n');

  writeEvents([
    begin,
    {
      schemaVersion: 2,
      type: 'decision_reconcile_abort',
      id: begin.id,
      decisionId: '0001',
      reconciliationId: 'orphan',
      ts: 'later',
    },
  ]);
  assert.match(runFail(['status']).stderr, /terminal has no matching prepare/);

  writeEvents([begin, prepare, { ...prepare, decisionId: '0002' }]);
  assert.match(runFail(['status']).stderr, /duplicate reconciliation id/);

  writeEvents([
    begin,
    prepare,
    commit,
    {
      schemaVersion: 2,
      type: 'decision_reconcile_abort',
      id: begin.id,
      decisionId: '0001',
      reconciliationId: prepare.reconciliationId,
      ts: 'after commit',
    },
  ]);
  assert.match(runFail(['status']).stderr, /already has a terminal event/);

  writeEvents([begin, { ...prepare, decisionId: '0003' }]);
  assert.match(runFail(['status']).stderr, /unlinked decision 0003/);

  writeEvents([begin, commit]);
  assert.match(runFail(['status']).stderr, /terminal has no matching prepare/);

  const failedEnd = {
    schemaVersion: 2,
    type: 'end',
    id: begin.id,
    ts: 'closed',
    status: 'failed',
  };
  writeEvents([begin, failedEnd, prepare]);
  assert.match(runFail(['status']).stderr, /after intent .* was closed/);

  writeEvents([begin, prepare, failedEnd, commit]);
  assert.match(runFail(['status']).stderr, /after intent .* was closed/);

  writeEvents([
    { ...begin, schemaVersion: 1 },
    failedEnd,
    {
      type: 'decision_reconcile',
      id: begin.id,
      decisionId: '0001',
      ts: 'after close',
      fromStatus: 'accepted',
      toStatus: 'accepted',
    },
  ]);
  assert.match(runFail(['status']).stderr, /after intent .* was closed/);
});

test('mutations repair a torn final JSONL record before appending', () => {
  const { dir, run } = setup();
  const eventFile = path.join(dir, 'events.jsonl');
  fs.mkdirSync(dir, { recursive: true });
  const firstId = run(['begin', 'first']).trim();
  run(['end']);
  fs.appendFileSync(eventFile, '{"schemaVersion":2,"type":"begin"');

  const secondId = run(['begin', 'after torn tail']).trim();
  assert.notEqual(firstId, secondId);
  const content = fs.readFileSync(eventFile, 'utf8');
  assert.ok(content.endsWith('\n'));
  assert.doesNotThrow(() => content.trim().split('\n').map(JSON.parse));
});

test('status and log repair a torn final JSONL record while holding the lock', () => {
  const { dir, run } = setup();
  const eventFile = path.join(dir, 'events.jsonl');
  const intentId = run(['begin', 'complete before torn reads']).trim();
  run(['end']);

  fs.appendFileSync(eventFile, '{"schemaVersion":2,"type":"begin"');
  assert.equal(run(['status']), 'no intent in progress\n');
  assert.ok(fs.readFileSync(eventFile, 'utf8').endsWith('\n'));

  fs.appendFileSync(eventFile, '{"schemaVersion":2,"type":"end"');
  assert.match(run(['log']), new RegExp(`\\[${intentId}\\] completed`));
  const content = fs.readFileSync(eventFile, 'utf8');
  assert.doesNotThrow(() => content.trim().split('\n').map(JSON.parse));
});

test('linked decisions require reconciliation before a successful close', () => {
  const { run, runFail, events } = setup();
  const decisionFile = run([
    'decision',
    'add',
    'Keep local storage',
    '-c',
    'Storage is local today.',
    '-o',
    'Keep it local until scale requires otherwise.',
  ]).trim();
  const intentId = run([
    'begin',
    'confirm storage architecture',
    '--decision',
    '1',
    '--decision',
    '0001',
  ]).trim();

  assert.deepEqual(events()[0].decisions, ['0001']);
  assert.match(run(['status']), /decisions: 0001/);
  assert.match(runFail(['end']).stderr, /decision 0001 was not reconciled/);

  const update = run([
    'decision',
    'update',
    '1',
    '--status',
    'accepted',
    '--note',
    'Confirmed after reviewing current scale.',
  ]).trim();
  assert.equal(update, `0001 accepted -> accepted (${intentId})`);
  const content = fs.readFileSync(decisionFile, 'utf8');
  assert.match(content, /## Decision History/);
  assert.match(content, new RegExp('Intent `' + intentId + '`'));
  assert.match(content, /Status: Accepted → Accepted/);
  assert.match(content, /Confirmed after reviewing current scale\./);
  assert.equal(events().at(-1).type, 'decision_reconcile_commit');
  assert.equal(events().at(-1).decisionId, '0001');
  assert.match(events().at(-1).fileHash, /^[a-f0-9]{64}$/);
  assert.equal(run(['end']).trim(), `${intentId} completed`);
});

test('decision reconciliation recovers a committed file after event interruption', () => {
  const { dir, run, runFail, events } = setup();
  const decisionFile = run([
    'decision',
    'add',
    'Choose queue',
    '-c',
    'Work needs serialization.',
    '-o',
    'Use a local queue.',
  ]).trim();
  const intentId = run(['begin', 'revisit queue', '--decision', '1']).trim();
  const interrupted = runFail(
    ['decision', 'update', '1', '--status', 'deferred', '--note', 'Wait for load data.'],
    {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: dir,
        DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
        _DRIFTSEAL_TEST_CRASH_AFTER_DECISION_WRITE: '1',
      },
    }
  );
  assert.match(interrupted.stderr, /simulated interruption/);
  assert.equal(events().at(-1).type, 'decision_reconcile_prepare');
  assert.match(fs.readFileSync(decisionFile, 'utf8'), /## Status\n\nDeferred/);

  assert.equal(run(['end']).trim(), `${intentId} completed`);
  assert.equal(events().at(-2).type, 'decision_reconcile_commit');
  assert.equal(events().at(-2).reconciliationId, events().at(-3).reconciliationId);
});

test('decision reconciliation aborts an interrupted prepare and can be retried', () => {
  const { dir, run, runFail, events } = setup();
  const decisionFile = run([
    'decision',
    'add',
    'Choose cache',
    '-c',
    'Caching is optional.',
    '-o',
    'Start without a cache.',
  ]).trim();
  const intentId = run(['begin', 'revisit cache', '--decision', '1']).trim();
  const interrupted = runFail(
    ['decision', 'update', '1', '--status', 'deferred', '--note', 'Wait for profiling.'],
    {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: dir,
        DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
        _DRIFTSEAL_TEST_CRASH_AFTER_RECONCILIATION_PREPARE: '1',
      },
    }
  );
  assert.match(interrupted.stderr, /simulated interruption after reconciliation prepare/);
  assert.match(fs.readFileSync(decisionFile, 'utf8'), /## Status\n\nAccepted/);
  assert.match(runFail(['end']).stderr, /was not reconciled/);
  assert.equal(events().at(-1).type, 'decision_reconcile_abort');

  run(['decision', 'update', '1', '--status', 'deferred', '--note', 'Wait for profiling.']);
  assert.equal(run(['end']).trim(), `${intentId} completed`);
});

test('every linked decision must reconcile and the latest update controls closure', () => {
  const { run, runFail } = setup();
  run(['decision', 'add', 'First policy', '-c', 'context', '-o', 'outcome']);
  run(['decision', 'add', 'Second policy', '-c', 'context', '-o', 'outcome']);
  const intentId = run([
    'begin',
    'revisit both policies',
    '--decision',
    '1',
    '--decision',
    '2',
  ]).trim();

  run(['decision', 'update', '1', '--note', 'Initially confirmed.']);
  assert.match(runFail(['end']).stderr, /decision 0002 was not reconciled/);
  run(['decision', 'update', '1', '--status', 'deferred', '--note', 'New evidence requires delay.']);
  assert.equal(run(['decision', 'list', '--status', 'deferred', '--count']), '1\n');
  run(['decision', 'update', '2', '--note', 'Confirmed unchanged.']);
  assert.equal(run(['end']).trim(), `${intentId} completed`);
});

test('decision reconciliation validates links and detects status conflicts', () => {
  const { run, runFail } = setup();
  const decisionFile = run([
    'decision',
    'add',
    'Choose transport',
    '-c',
    'A transport is required.',
    '-o',
    'Use HTTP.',
  ]).trim();
  assert.match(runFail(['begin', 'invalid link', '--decision', '9']).stderr, /unknown decision id/);

  run(['begin', 'unlinked work']);
  assert.match(
    runFail(['decision', 'update', '1', '--note', 'Not declared.']).stderr,
    /is not linked/
  );
  run(['end', '--status', 'abandoned']);

  run(['begin', 'revisit transport', '--decision', '1']);
  assert.match(
    runFail(['decision', 'update', '1', '--status', 'unknown', '--note', 'Invalid.']).stderr,
    /invalid decision status/
  );
  run(['decision', 'update', '1', '--status', 'accepted', '--note', 'HTTP remains suitable.']);
  fs.writeFileSync(
    decisionFile,
    fs.readFileSync(decisionFile, 'utf8').replace('Use HTTP.', 'Use a manually edited transport.')
  );
  assert.match(runFail(['end', '--status', 'partial']).stderr, /changed after its latest reconciliation/);
  assert.match(run(['end', '--status', 'failed']).trim(), /failed$/);
  assert.match(
    runFail(['decision', 'update', '1', '--note', 'No open intent.']).stderr,
    /requires an intent in progress/
  );
});

test('end closes the open intent with status, note and verify result', () => {
  const { run, events } = setup();
  const id = run(['begin', 'do a thing', '-v', 'make check']).trim();
  const out = run(['end', '--status', 'partial', '-n', 'half done', '-r', '2 of 4 pass']).trim();
  assert.equal(out, `${id} partial`);
  const end = events().find((e) => e.type === 'end');
  assert.equal(end.id, id);
  assert.equal(end.status, 'partial');
  assert.equal(end.note, 'half done');
  assert.equal(end.verifyResult, '2 of 4 pass');
});

test('end defaults to completed and fails with nothing open', () => {
  const { run, runFail, events } = setup();
  const err = runFail(['end']);
  assert.match(err.stderr, /no intent in progress/);
  run(['begin', 'x']);
  run(['end']);
  assert.equal(events().at(-1).status, 'completed');
});

test('end rejects invalid status and closing a closed intent', () => {
  const { run, runFail } = setup();
  const id = run(['begin', 'x']).trim();
  assert.match(runFail(['end', '-s', 'done']).stderr, /invalid status/);
  run(['end']);
  assert.match(runFail(['end', id]).stderr, /already closed/);
});

test('commands reject stray positionals, duplicate flags, and boolean values', () => {
  const { run, runFail } = setup();
  assert.match(runFail(['status', 'extra']).stderr, /usage: driftseal status/);
  assert.match(runFail(['log', 'extra']).stderr, /usage: driftseal log/);
  assert.match(runFail(['decision', 'list', 'deferred']).stderr, /usage: driftseal decision list/);
  assert.match(
    runFail(['decision', 'list', '--count=false']).stderr,
    /does not take a value/
  );
  assert.match(
    runFail(['decision', 'list', '--last', '1', '--last=2']).stderr,
    /may only be specified once/
  );

  const id = run(['begin', 'strict arguments']).trim();
  assert.match(
    runFail(['end', '--status=failed', '--status=completed']).stderr,
    /may only be specified once/
  );
  assert.match(runFail(['end', id, 'extra']).stderr, /usage: driftseal end/);
  run(['end', '--status', 'abandoned']);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-init-args-'));
  assert.match(runFail(['init', 'extra'], { cwd }).stderr, /usage: driftseal init \[--lang <tag>\] \[--local-log\]/);
  assert.equal(fs.existsSync(path.join(cwd, 'AGENTS.md')), false);
});

test('ordinary intents ignore unrelated malformed decisions', () => {
  const { dir, run } = setup();
  const decisions = path.join(dir, 'decisions');
  fs.mkdirSync(decisions);
  fs.writeFileSync(path.join(decisions, '0001-broken.md'), '# 1. Broken\n\n## Status\n\n');

  const first = run(['begin', 'ordinary work']).trim();
  assert.equal(run(['end']).trim(), `${first} completed`);
  const second = run(['begin', 'failed ordinary work']).trim();
  assert.equal(run(['end', '--status', 'failed']).trim(), `${second} failed`);
});

test('failed and abandoned remain escape paths for divergent pending reconciliation', () => {
  const { dir, run, runFail, events } = setup();
  const decisionFile = run([
    'decision',
    'add',
    'Fragile decision',
    '-c',
    'context',
    '-o',
    'outcome',
  ]).trim();
  const intentId = run(['begin', 'risky revisit', '--decision', '1']).trim();
  runFail(
    ['decision', 'update', '1', '--status', 'deferred', '--note', 'Interrupted.'],
    {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: dir,
        DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
        _DRIFTSEAL_TEST_CRASH_AFTER_DECISION_WRITE: '1',
      },
    }
  );
  fs.appendFileSync(decisionFile, '\nManual divergent edit.\n');
  assert.equal(run(['end', '--status', 'abandoned']).trim(), `${intentId} abandoned`);

  const closedEvents = events();
  const cancellation = closedEvents.find(
    (event) =>
      event.type === 'decision_reconcile_cancel' &&
      event.id === intentId
  );
  assert.ok(cancellation);
  assert.equal(cancellation.intentStatus, 'abandoned');

  // Simulate a log written before cancellation events existed. Scoped recovery
  // must still keep the historical conflict from poisoning a new linked intent.
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    closedEvents
      .filter((event) => event !== cancellation)
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n'
  );
  const nextIntentId = run(['begin', 'safe revisit', '--decision', '1']).trim();
  run(['decision', 'update', '1', '--note', 'Confirmed after the abandoned conflict.']);
  assert.equal(run(['end']).trim(), `${nextIntentId} completed`);
});

test('status shows the open intent and its verify method', () => {
  const { run } = setup();
  assert.match(run(['status']), /no intent in progress/);
  run(['begin', 'fix the bug', '-v', 'repro script exits 0']);
  const out = run(['status']);
  assert.match(out, /in_progress/);
  assert.match(out, /fix the bug/);
  assert.match(out, /repro script exits 0/);
  run(['end']);
  assert.match(run(['status']), /no intent in progress/);
});

test('log renders history, --last limits it', () => {
  const { run } = setup();
  for (const intent of ['one', 'two', 'three']) {
    run(['begin', intent]);
    run(['end']);
  }
  const full = run(['log']);
  assert.match(full, /one/);
  assert.match(full, /three/);
  const last = run(['log', '--last', '1']);
  assert.doesNotMatch(last, /one/);
  assert.match(last, /three/);
});

test('reclaim hides a failed record behind a marker without deleting it', () => {
  const { run, events } = setup();
  const id = run(['begin', 'sandbox-bound step']).trim();
  run(['end', '-s', 'failed', '-n', 'sandbox denied the write']);
  const out = run(['reclaim', id, '--reason', 'harness sandbox noise, not project signal']);
  assert.match(out, new RegExp(`${id} reclaimed`));

  const evs = events();
  const marker = evs.at(-1);
  assert.equal(marker.type, 'reclaim');
  assert.equal(marker.schemaVersion, 4);
  assert.equal(marker.id, id);
  assert.equal(marker.reason, 'harness sandbox noise, not project signal');
  assert.ok(evs.some((ev) => ev.type === 'end' && ev.id === id)); // original lines kept

  assert.match(run(['log']), /log is empty/);
  const all = run(['log', '--all']);
  assert.match(all, new RegExp(id));
  assert.match(all, /reclaimed: harness sandbox noise/);
});

test('reclaim requires a reason and a closed, known intent', () => {
  const { run, runFail } = setup();
  const id = run(['begin', 'work']).trim();
  assert.match(runFail(['reclaim', id]).stderr, /usage: driftseal reclaim/);
  assert.match(runFail(['reclaim', id, '--reason', 'x']).stderr, /in_progress/);
  assert.match(runFail(['reclaim', '1999-01-01-001', '--reason', 'x']).stderr, /unknown intent id/);
  run(['end', '-s', 'failed']);
  run(['reclaim', id, '--reason', 'noise']);
  assert.match(runFail(['reclaim', id, '--reason', 'again']).stderr, /already reclaimed/);
});

test('reclaim of completed, partial, or decision-linked intents requires --force', () => {
  const { run, runFail } = setup();
  run(['decision', 'add', 'Keep WAL append-only', '--context', 'c', '--outcome', 'o']);
  const done = run(['begin', 'finished work']).trim();
  run(['end']);
  const linked = run(['begin', 'linked work', '--decision', '1']).trim();
  run(['end', '-s', 'failed', '-n', 'escape']);

  assert.match(runFail(['reclaim', done, '--reason', 'x']).stderr, /--force/);
  assert.match(runFail(['reclaim', linked, '--reason', 'x']).stderr, /--force/);
  run(['reclaim', done, linked, '--reason', 'explicit cleanup', '--force']);
  const all = run(['log', '--all']);
  assert.match(all, /reclaimed: explicit cleanup/);
  assert.equal(run(['log']), 'log is empty\n');
});

test('batch reclaim keeps fresh, completed, and decision-linked records', () => {
  const { dir, run, runFail, events } = setup();
  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const fresh = new Date().toISOString();
  const line = (ev) => JSON.stringify({ schemaVersion: 3, ...ev });
  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    [
      line({ type: 'begin', id: '2020-01-01-001', ts: old, intent: 'old failure' }),
      line({ type: 'end', id: '2020-01-01-001', ts: old, status: 'failed' }),
      line({ type: 'begin', id: '2020-01-01-002', ts: old, intent: 'old abandonment' }),
      line({ type: 'end', id: '2020-01-01-002', ts: old, status: 'abandoned' }),
      line({ type: 'begin', id: '2020-01-01-003', ts: old, intent: 'old success' }),
      line({ type: 'end', id: '2020-01-01-003', ts: old, status: 'completed' }),
      line({ type: 'begin', id: '2020-01-01-004', ts: fresh, intent: 'fresh failure' }),
      line({ type: 'end', id: '2020-01-01-004', ts: fresh, status: 'failed' }),
    ].join('\n') + '\n'
  );

  const before = events().length;
  const dry = run(['reclaim', '--reason', 'sandbox noise', '--dry-run']);
  assert.match(dry, /2020-01-01-001/);
  assert.match(dry, /2020-01-01-002/);
  assert.doesNotMatch(dry, /2020-01-01-003/);
  assert.doesNotMatch(dry, /2020-01-01-004/);
  assert.equal(events().length, before); // dry-run appends nothing

  assert.match(runFail(['reclaim', '--reason', 'x', '--force']).stderr, /--force requires explicit/);
  run(['reclaim', '--reason', 'sandbox noise']);
  const visible = run(['log']);
  assert.doesNotMatch(visible, /old failure/);
  assert.doesNotMatch(visible, /old abandonment/);
  assert.match(visible, /old success/);
  assert.match(visible, /fresh failure/);
  assert.equal(events().filter((ev) => ev.type === 'reclaim').length, 2);
  assert.match(run(['reclaim', '--reason', 'nothing left']), /no reclaimable intents/);
});

test('unreclaim restores a reclaimed record and requires one to be reclaimed', () => {
  const { run, runFail, events } = setup();
  const id = run(['begin', 'flaky round']).trim();
  run(['end', '-s', 'failed']);
  assert.match(runFail(['unreclaim', id, '--reason', 'x']).stderr, /not reclaimed/);
  assert.match(runFail(['unreclaim', id]).stderr, /usage: driftseal unreclaim/);
  run(['reclaim', id, '--reason', 'sandbox noise']);
  assert.equal(run(['log']), 'log is empty\n');
  run(['unreclaim', id, '--reason', 'actually relevant after all']);
  assert.match(run(['log']), /flaky round/);
  assert.equal(events().at(-1).type, 'unreclaim');
});

test('init injects the protocol into AGENTS.md, idempotently', () => {
  const { dir, run, runFail } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-init-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');
  const runIn = (args) => run(args, { cwd });

  runIn(['init']);
  const first = fs.readFileSync(agentsFile, 'utf8');
  assert.match(first, /intent write-ahead log/);
  assert.match(first, /driftseal begin/);
  assert.match(first, /--decision <id>/);
  assert.match(first, /may need a rollback/);
  assert.match(first, /Git operations never need an intent/);
  assert.match(first, /branch and worktree\s+management/);
  assert.match(first, /merges, rebases, cherry-picks, tags, and pushes/);
  assert.match(first, /normal authorization and safety requirements/);
  assert.match(first, /need no intent/);
  assert.match(first, /Agent protocol: decision log/);
  assert.match(first, /driftseal decision add/);
  assert.match(first, /cannot be\s+recovered from the intent log and Git history/);
  assert.match(first, /Do not record routine, local/);
  assert.match(first, /proposed\|accepted\|rejected\|deferred\|deprecated\|superseded/);
  assert.match(first, /Use `deferred`\s+for a deliberately postponed choice/);
  assert.match(first, /driftseal decision list --status deferred --count/);
  assert.match(first, /driftseal decision update/);
  assert.match(first, /rejects a successful close/);
  assert.match(first, /Log access goes only through DriftSeal/);
  assert.match(first, /driftseal reclaim \[id \.\.\.\] --reason/);
  assert.match(first, /never\s+deletes log lines/);
  assert.match(first, /resume it when its\s+objective still matches/);
  assert.match(first, /--driver "<decision driver>"/);
  assert.match(first, /AGENTS\.md` protocol is the source of truth/);
  assert.match(first, /Use the `driftseal` CLI by\s+default/);
  assert.match(first, /MCP and lifecycle hooks are optional adapters/);
  assert.match(first, /driftseal-version: 13/);
  assert.match(first, /--accept "<observable outcome>"/);
  assert.match(first, /run `driftseal verify`/);
  assert.match(first, /first reconcile every\s+declared decision/);
  assert.match(first, /--allow-tracked-command/);
  assert.match(first, /workspace changed after it/);
  assert.match(first, /reconstructed from Git state/);
  assert.match(first, /Size an intent to the smallest unit/);
  assert.match(first, /To revise a decision's prose/);
  assert.match(first, /per the step 1 test/);
  assert.match(first, /driftseal-log-language: en/);
  assert.match(first, /\*\*Log language:\*\* `en`/);
  assert.match(first, /Write intent-log prose/);
  assert.match(first, /Write decision-log prose/);
  assert.match(first, /driftseal absorb/);
  assert.match(first, /--abandon-theirs/);
  assert.match(first, /colliding decision ids are remapped/);
  assert.match(first, /<!-- \/driftseal -->/);

  runIn(['init']); // second run must not duplicate
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), first);

  fs.unlinkSync(agentsFile);
  fs.writeFileSync(agentsFile, '# existing instructions\n');
  runIn(['init']);
  const appended = fs.readFileSync(agentsFile, 'utf8');
  assert.match(appended, /^# existing instructions/);
  assert.match(appended, /intent write-ahead log/);

  const upgradeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-'));
  const upgradeFile = path.join(upgradeCwd, 'AGENTS.md');
  const versionTwelve = protocolV12(first);
  const upgradeTwelveCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v12-'));
  const upgradeTwelveFile = path.join(upgradeTwelveCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeTwelveFile, versionTwelve);
  run(['init'], { cwd: upgradeTwelveCwd });
  assert.equal(fs.readFileSync(upgradeTwelveFile, 'utf8'), first);

  const versionEleven = versionTwelve
    .replace('driftseal-version: 12', 'driftseal-version: 11')
    .replace('driftseal-decisions-version: 12', 'driftseal-decisions-version: 11')
    .replace(
      '-r "<what the verification showed, written for the next agent>"',
      '-r "<verify output>"'
    )
    .replace(
      '\n   A command whose result can be reconstructed from Git state (for example a\n' +
        '   patch file regenerated from a commit range, or a scratch harness that\n' +
        '   re-runs) needs no intent; content that will be committed and cannot be\n' +
        '   reconstructed (for example a .gitignore edit) does.',
      ''
    )
    .replace(
      '\n   Size an intent to the smallest unit that leaves the tree self-consistent\n' +
        '   and can be verified on its own.',
      ''
    )
    .replace(
      '   To revise a decision\'s prose, edit the file, then run `decision update` to\n' +
        '   record the new content hash. Do not edit a decision after reconciling it;\n' +
        '   run `decision update` again so the final content hash is recorded.\n' +
        '   Interrupted reconciliation is recovered',
      '   Do not edit a decision after reconciling it; run `decision update` again so\n' +
        '   the final content hash is recorded. Interrupted reconciliation is recovered'
    )
    .replace(
      'preparing a Git operation does require a new intent, per the step 1 test.',
      'preparing a Git operation does require a new intent.'
    );
  const versionTen = versionEleven
    .replace('driftseal-version: 11', 'driftseal-version: 10')
    .replace('driftseal-decisions-version: 11', 'driftseal-decisions-version: 10')
    .replace(/<!-- driftseal-log-language: en -->\n/g, '')
    .replace(
      '\n**Log language:** `en`. Write intent-log prose (intent, note,\n' +
        'verify-result, and reclaim/unreclaim reason) in that language. Keep command\n' +
        'names, flags, status tokens, and ids in English.\n',
      ''
    )
    .replace(
      '\n**Log language:** `en`. Write decision-log prose (title, context,\n' +
        'outcome, drivers, options, consequences, and update notes) in that language.\n' +
        'Keep MADR section headings, status tokens, and ids in English.\n',
      ''
    );
  const versionNine = versionTen
    .replace('driftseal-version: 10', 'driftseal-version: 9')
    .replace('driftseal-decisions-version: 10', 'driftseal-decisions-version: 9')
    .replace(
      '1. **Write intent first**, before modifying, creating, or deleting files, or\n' +
        '   making any other non-Git change that may need a rollback:\n' +
        '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.\n' +
        '   Git operations never need an intent and are not included in the intent log;\n' +
        '   Git maintains their history. This includes inspection, branch and worktree\n' +
        '   management, staging, commits, merges, rebases, cherry-picks, tags, and pushes.\n' +
        '   Single-step commands that only build or check work already done, such as\n' +
        '   compiling or running tests, also need no intent.',
      '1. **Write intent first**, before modifying, creating, or deleting files, or\n' +
        '   making any other change that may need a rollback:\n' +
        '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.\n' +
        '   Single-step commands that only build, check, or record work already done\n' +
        '   (compiling, running tests, `git add`/`git commit`) need no intent.'
    )
    .replace(
      '   Git operations remain subject to normal authorization and safety requirements\n' +
        '   even though they do not require an intent. Any non-Git content change made while\n' +
        '   preparing a Git operation does require a new intent.',
      '   An authorized Git commit that only stages and records the verified changes and\n' +
        '   just-closed log finalizes that round without requiring a new intent. Any content\n' +
        '   change made while preparing the commit does require a new intent.'
    );
  const versionEight = versionNine
    .replace('driftseal-version: 9', 'driftseal-version: 8')
    .replace('driftseal-decisions-version: 9', 'driftseal-decisions-version: 8')
    .replace(
      '\nAfter a merge collision, run `driftseal absorb` rather than editing the log;\n' +
        'if both sides still have an open intent, add `--abandon-theirs` or\n' +
        '`--abandon-ours`.',
      ''
    )
    .replace(
      '\nAfter a merge, colliding decision ids are remapped with `driftseal absorb`;\n' +
        'concurrent edits of a shared decision are not auto-merged.',
      ''
    );
  const versionSeven = versionEight
    .replace('driftseal-version: 8', 'driftseal-version: 7')
    .replace('driftseal-decisions-version: 8', 'driftseal-decisions-version: 7')
    .replace(
      '\nThis `AGENTS.md` protocol is the source of truth. Use the `driftseal` CLI by\n' +
        'default; the companion skill only helps discover and resume the workflow, while\n' +
        'MCP and lifecycle hooks are optional adapters.\n',
      ''
    );
  const versionSix = versionSeven
    .replace('driftseal-version: 7', 'driftseal-version: 6')
    .replace('driftseal-decisions-version: 7', 'driftseal-decisions-version: 6')
    .replace(
      'doing anything else. The open intent is the source of truth: resume it when its\n' +
        '   objective still matches the current task; otherwise close it (`partial` or\n' +
        '   `abandoned`, with a note) and `begin` a new one.',
      'doing anything else. The open intent is the source of truth.'
    )
    .replace(' --driver "<decision driver>"', '');
  const versionFive = versionSix
    .replace('driftseal-version: 6', 'driftseal-version: 5')
    .replace('driftseal-decisions-version: 6', 'driftseal-decisions-version: 5')
    .replace(
      '\n**Log access goes only through DriftSeal.** Never read, edit, move, or delete\n' +
        '`.intent-log/events.jsonl` (or anything under `$DRIFTSEAL_HOME`) directly; use\n' +
        '`driftseal` commands or the MCP tools. Retire meaningless closed records with\n' +
        '`driftseal reclaim [id ...] --reason "<why>"` — it appends a marker, never\n' +
        'deletes log lines; `driftseal unreclaim <id> --reason "<why>"` restores one.\n',
      ''
    );
  const versionFour = versionFive
    .replace('driftseal-version: 5', 'driftseal-version: 4')
    .replace('driftseal-decisions-version: 5', 'driftseal-decisions-version: 4')
    .replace(
      '1. **Write intent first**, before modifying, creating, or deleting files, or\n' +
        '   making any other change that may need a rollback:\n' +
        '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.\n' +
        '   Single-step commands that only build, check, or record work already done\n' +
        '   (compiling, running tests, `git add`/`git commit`) need no intent.',
      '1. **Write intent first**, before modifying a file or running a mutating command:\n' +
        '   `driftseal begin "<what this round will accomplish>" --verify "<command or check that proves it>"`.\n' +
        '   Add one `--decision <id>` for each existing decision this round may change.'
    );
  const versionThree = versionFour
    .replace('driftseal-version: 4', 'driftseal-version: 3')
    .replace('driftseal-decisions-version: 4', 'driftseal-decisions-version: 3')
    .replace(
      '   by the next linked `decision update` or successful `end`. Closing as\n' +
        '   `failed` or `abandoned` cancels pending recovery for that intent.',
      '   by the next `decision update` or `end`.'
    )
    .trimEnd() + '\n\n# trailing user instructions\n';
  fs.writeFileSync(upgradeFile, versionThree);
  run(['init'], { cwd: upgradeCwd });
  const upgraded = fs.readFileSync(upgradeFile, 'utf8');
  assert.equal((upgraded.match(/<!-- driftseal -->/g) || []).length, 1);
  assert.equal((upgraded.match(/<!-- driftseal-decisions -->/g) || []).length, 1);
  assert.match(upgraded, /driftseal-version: 13/);
  assert.match(upgraded, /driftseal-decisions-version: 13/);
  assert.match(upgraded, /driftseal-log-language: en/);
  assert.match(upgraded, /# trailing user instructions/);

  const upgradeNineCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v9-'));
  const upgradeNineFile = path.join(upgradeNineCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeNineFile, versionNine.trimEnd() + '\n');
  run(['init'], { cwd: upgradeNineCwd });
  const upgradedNine = fs.readFileSync(upgradeNineFile, 'utf8');
  assert.match(upgradedNine, /driftseal-version: 13/);
  assert.match(upgradedNine, /Git operations never need an intent/);
  assert.match(upgradedNine, /merges, rebases, cherry-picks, tags, and pushes/);

  const upgradeTenCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v10-'));
  const upgradeTenFile = path.join(upgradeTenCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeTenFile, versionTen.trimEnd() + '\n');
  run(['init'], { cwd: upgradeTenCwd });
  const upgradedTen = fs.readFileSync(upgradeTenFile, 'utf8');
  assert.match(upgradedTen, /driftseal-version: 13/);
  assert.match(upgradedTen, /driftseal-log-language: en/);
  assert.match(upgradedTen, /Write intent-log prose/);

  const upgradeElevenCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v11-'));
  const upgradeElevenFile = path.join(upgradeElevenCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeElevenFile, versionEleven.trimEnd() + '\n');
  run(['init'], { cwd: upgradeElevenCwd });
  const upgradedEleven = fs.readFileSync(upgradeElevenFile, 'utf8');
  assert.match(upgradedEleven, /driftseal-version: 13/);
  assert.match(upgradedEleven, /driftseal-decisions-version: 13/);
  assert.match(upgradedEleven, /run `driftseal verify`/);
  assert.match(upgradedEleven, /reconstructed from Git state/);
  assert.match(upgradedEleven, /Size an intent to the smallest unit/);
  assert.doesNotMatch(upgradedEleven, /<verify output>/);

  const upgradeEightCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v8-'));
  const upgradeEightFile = path.join(upgradeEightCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeEightFile, versionEight.trimEnd() + '\n');
  run(['init'], { cwd: upgradeEightCwd });
  const upgradedEight = fs.readFileSync(upgradeEightFile, 'utf8');
  assert.match(upgradedEight, /driftseal-version: 13/);
  assert.match(upgradedEight, /driftseal absorb/);
  assert.match(upgradedEight, /colliding decision ids are remapped/);

  const upgradeSevenCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v7-'));
  const upgradeSevenFile = path.join(upgradeSevenCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeSevenFile, versionSeven.trimEnd() + '\n');
  run(['init'], { cwd: upgradeSevenCwd });
  const upgradedSeven = fs.readFileSync(upgradeSevenFile, 'utf8');
  assert.match(upgradedSeven, /driftseal-version: 13/);
  assert.match(upgradedSeven, /source of truth/);
  assert.match(upgradedSeven, /--driver "<decision driver>"/);

  const upgradeSixCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v6-'));
  const upgradeSixFile = path.join(upgradeSixCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeSixFile, versionSix.trimEnd() + '\n');
  run(['init'], { cwd: upgradeSixCwd });
  const upgradedSix = fs.readFileSync(upgradeSixFile, 'utf8');
  assert.match(upgradedSix, /driftseal-version: 13/);
  assert.match(upgradedSix, /resume it when its\s+objective still matches/);
  assert.match(upgradedSix, /--driver "<decision driver>"/);

  const upgradeFiveCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v5-'));
  const upgradeFiveFile = path.join(upgradeFiveCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeFiveFile, versionFive.trimEnd() + '\n');
  run(['init'], { cwd: upgradeFiveCwd });
  const upgradedFive = fs.readFileSync(upgradeFiveFile, 'utf8');
  assert.match(upgradedFive, /driftseal-version: 13/);
  assert.match(upgradedFive, /Log access goes only through DriftSeal/);

  const upgradeFourCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-upgrade-v4-'));
  const upgradeFourFile = path.join(upgradeFourCwd, 'AGENTS.md');
  fs.writeFileSync(upgradeFourFile, versionFour.trimEnd() + '\n');
  run(['init'], { cwd: upgradeFourCwd });
  const upgradedFour = fs.readFileSync(upgradeFourFile, 'utf8');
  assert.match(upgradedFour, /driftseal-version: 13/);
  assert.match(upgradedFour, /driftseal-decisions-version: 13/);
  assert.match(upgradedFour, /need no intent/);

  const crlfCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-crlf-'));
  const crlfFile = path.join(crlfCwd, 'AGENTS.md');
  const currentCrLf = first.replace(/\n/g, '\r\n');
  fs.writeFileSync(crlfFile, currentCrLf);
  run(['init'], { cwd: crlfCwd });
  assert.equal(fs.readFileSync(crlfFile, 'utf8'), currentCrLf);

  const crlfUpgradeCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-crlf-upgrade-'));
  const crlfUpgradeFile = path.join(crlfUpgradeCwd, 'AGENTS.md');
  fs.writeFileSync(crlfUpgradeFile, versionThree.replace(/\n/g, '\r\n'));
  run(['init'], { cwd: crlfUpgradeCwd });
  const upgradedCrLf = fs.readFileSync(crlfUpgradeFile, 'utf8');
  assert.match(upgradedCrLf, /driftseal-version: 13/);
  assert.equal(upgradedCrLf.replace(/\r\n/g, '').includes('\n'), false);

  const preservedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-preserve-'));
  const preservedFile = path.join(preservedCwd, 'AGENTS.md');
  const preservedPrefix = '# user instructions  \r\n\r\n\r\n';
  fs.writeFileSync(preservedFile, preservedPrefix);
  if (process.platform !== 'win32') fs.chmodSync(preservedFile, 0o644);
  run(['init'], {
    cwd: preservedCwd,
    env: { ...process.env, _DRIFTSEAL_TEST_UMASK: '077' },
  });
  const preserved = fs.readFileSync(preservedFile, 'utf8');
  assert.ok(preserved.startsWith(preservedPrefix));
  assert.equal(preserved.replace(/\r\n/g, '').includes('\n'), false);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(preservedFile).mode & 0o777, 0o644);
  }

  const customizedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-customized-'));
  const customizedFile = path.join(customizedCwd, 'AGENTS.md');
  const customized = first.replace('Every work round:', 'Every customized work round:');
  fs.writeFileSync(customizedFile, customized);
  assert.match(
    runFail(['init'], { cwd: customizedCwd }).stderr,
    /cannot safely upgrade customized protocol block/
  );
  assert.equal(fs.readFileSync(customizedFile, 'utf8'), customized);

  const futureCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-future-'));
  const futureFile = path.join(futureCwd, 'AGENTS.md');
  const future = first.replace('driftseal-version: 13', 'driftseal-version: 999');
  fs.writeFileSync(futureFile, future);
  assert.match(
    runFail(['init'], { cwd: futureCwd }).stderr,
    /protocol version 999 requires a newer DriftSeal client/
  );
  assert.equal(fs.readFileSync(futureFile, 'utf8'), future);

  const ambiguousCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-ambiguous-'));
  const ambiguousFile = path.join(ambiguousCwd, 'AGENTS.md');
  const ambiguous = [
    '<!-- driftseal -->',
    'customized legacy content',
    'Log: `.intent-log/events.jsonl` (override with `$DRIFTSEAL_HOME`); commit it with the code.',
    '',
  ].join('\n');
  fs.writeFileSync(ambiguousFile, ambiguous);
  assert.match(
    runFail(['init'], { cwd: ambiguousCwd }).stderr,
    /cannot safely upgrade customized protocol block/
  );
  assert.equal(fs.readFileSync(ambiguousFile, 'utf8'), ambiguous);

  const legacyCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-legacy-'));
  const legacyFile = path.join(legacyCwd, 'AGENTS.md');
  const decisionStart = first.indexOf('<!-- driftseal-decisions -->');
  const decisionEnd = first.indexOf('<!-- /driftseal-decisions -->') +
    '<!-- /driftseal-decisions -->'.length;
  const legacyDecision = first
    .slice(decisionStart, decisionEnd)
    .replace('<!-- driftseal-decisions-version: 13 -->\n', '')
    .replace('<!-- driftseal-log-language: en -->\n', '')
    .replace(
      '\n**Log language:** `en`. Write decision-log prose (title, context,\n' +
        'outcome, drivers, options, consequences, and update notes) in that language.\n' +
        'Keep MADR section headings, status tokens, and ids in English.\n',
      ''
    )
    .replace(' --driver "<decision driver>"', '')
    .replace(
      '\nAfter a merge, colliding decision ids are remapped with `driftseal absorb`;\n' +
        'concurrent edits of a shared decision are not auto-merged.',
      ''
    )
    .replace('\n<!-- /driftseal-decisions -->', '');
  fs.writeFileSync(legacyFile, `# existing instructions\n\n${legacyDecision}\n`);
  run(['init'], { cwd: legacyCwd });
  const migratedLegacy = fs.readFileSync(legacyFile, 'utf8');
  assert.equal((migratedLegacy.match(/<!-- driftseal-decisions -->/g) || []).length, 1);
  assert.match(migratedLegacy, /driftseal-decisions-version: 13/);
  assert.match(migratedLegacy, /driftseal-version: 13/);

  assert.ok(dir); // DRIFTSEAL_HOME unused by init, but keeps setup() symmetric
});

test('init --lang sets, preserves, and canonicalizes the log language', () => {
  const { run, runFail } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-lang-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');

  assert.match(runFail(['init', '--lang'], { cwd }).stderr, /flag --lang requires a value/);
  assert.match(
    runFail(['init', '--lang', 'en_US'], { cwd }).stderr,
    /invalid log language/
  );
  assert.match(runFail(['init', '--lang', 'zh CN'], { cwd }).stderr, /invalid log language/);
  assert.match(runFail(['init', '--lang', 'en-12'], { cwd }).stderr, /invalid log language/);
  assert.match(runFail(['init', '--lang', 'en-US-var'], { cwd }).stderr, /invalid log language/);
  assert.equal(fs.existsSync(agentsFile), false);

  run(['init', '--lang', 'zh-cn'], { cwd });
  const chinese = fs.readFileSync(agentsFile, 'utf8');
  assert.match(chinese, /driftseal-log-language: zh-CN/);
  assert.match(chinese, /\*\*Log language:\*\* `zh-CN`/);
  assert.equal((chinese.match(/driftseal-log-language: zh-CN/g) || []).length, 2);

  run(['init'], { cwd });
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), chinese);

  run(['init', '--lang', 'ja'], { cwd });
  const japanese = fs.readFileSync(agentsFile, 'utf8');
  assert.match(japanese, /driftseal-log-language: ja/);
  assert.match(japanese, /\*\*Log language:\*\* `ja`/);
  assert.doesNotMatch(japanese, /zh-CN/);

  run(['init', '--lang=en'], { cwd });
  const english = fs.readFileSync(agentsFile, 'utf8');
  assert.match(english, /driftseal-log-language: en/);
  assert.doesNotMatch(english, /driftseal-log-language: ja/);

  run(['init', '--lang', 'x-private'], { cwd });
  const privateUse = fs.readFileSync(agentsFile, 'utf8');
  assert.match(privateUse, /driftseal-log-language: x-private/);
  assert.match(privateUse, /\*\*Log language:\*\* `x-private`/);

  run(['init', '--lang', 'en-US-u-ca-gregory'], { cwd });
  const extension = fs.readFileSync(agentsFile, 'utf8');
  assert.match(extension, /driftseal-log-language: en-US-u-ca-gregory/);
  assert.doesNotMatch(extension, /u-CA-gregory/);

  const longTag = 'zh-Hans-CN-x-private-example-long-tag';
  assert.ok(longTag.length > 32);
  run(['init', '--lang', longTag], { cwd });
  const longLanguage = fs.readFileSync(agentsFile, 'utf8');
  assert.match(longLanguage, new RegExp(`driftseal-log-language: ${longTag}`));
  assert.match(longLanguage, new RegExp(`\\*\\*Log language:\\*\\* \`${longTag}\``));

  run(['init', '--lang=en'], { cwd });
  const restored = fs.readFileSync(agentsFile, 'utf8');
  const mismatchedBlocks = restored
    .replace('<!-- driftseal-log-language: en -->', '<!-- driftseal-log-language: fr -->')
    .replace('**Log language:** `en`', '**Log language:** `fr`');
  fs.writeFileSync(agentsFile, mismatchedBlocks);
  assert.match(
    runFail(['init'], { cwd }).stderr,
    /intent and decision protocols declare different log languages/
  );
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), mismatchedBlocks);

  const intraBlock = restored.replace('**Log language:** `en`', '**Log language:** `zh-CN`');
  fs.writeFileSync(agentsFile, intraBlock);
  assert.match(
    runFail(['init'], { cwd }).stderr,
    /intent protocol declares different log languages in the comment \(en\) and prose \(zh-CN\)/
  );
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), intraBlock);

  run(['init', '--lang', 'pt-BR'], { cwd });
  const portuguese = fs.readFileSync(agentsFile, 'utf8');
  assert.match(portuguese, /driftseal-log-language: pt-BR/);
  assert.equal((portuguese.match(/driftseal-log-language: pt-BR/g) || []).length, 2);
});

test('init upgrades a v11 protocol block written in a non-English log language', () => {
  const { run } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-lang-upgrade-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');

  run(['init', '--lang', 'zh-CN'], { cwd });
  const current = fs.readFileSync(agentsFile, 'utf8');
  const versionElevenChinese = protocolV12(current)
    .replace('driftseal-version: 12', 'driftseal-version: 11')
    .replace('driftseal-decisions-version: 12', 'driftseal-decisions-version: 11')
    .replace(
      '-r "<what the verification showed, written for the next agent>"',
      '-r "<verify output>"'
    )
    .replace(
      '\n   A command whose result can be reconstructed from Git state (for example a\n' +
        '   patch file regenerated from a commit range, or a scratch harness that\n' +
        '   re-runs) needs no intent; content that will be committed and cannot be\n' +
        '   reconstructed (for example a .gitignore edit) does.',
      ''
    )
    .replace(
      '\n   Size an intent to the smallest unit that leaves the tree self-consistent\n' +
        '   and can be verified on its own.',
      ''
    )
    .replace(
      '   To revise a decision\'s prose, edit the file, then run `decision update` to\n' +
        '   record the new content hash. Do not edit a decision after reconciling it;\n' +
        '   run `decision update` again so the final content hash is recorded.\n' +
        '   Interrupted reconciliation is recovered',
      '   Do not edit a decision after reconciling it; run `decision update` again so\n' +
        '   the final content hash is recorded. Interrupted reconciliation is recovered'
    )
    .replace(
      'preparing a Git operation does require a new intent, per the step 1 test.',
      'preparing a Git operation does require a new intent.'
    );
  fs.writeFileSync(agentsFile, versionElevenChinese);

  run(['init'], { cwd }); // plain init upgrades in place, keeping the language
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), current);
});

test('init --local-log persists the local, untracked log mode', () => {
  const { run, runFail } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-local-log-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');

  run(['init', '--local-log'], { cwd });
  const local = fs.readFileSync(agentsFile, 'utf8');
  assert.equal((local.match(/<!-- driftseal-local-log: true -->/g) || []).length, 2);
  assert.match(local, /driftseal-version: 13/);
  assert.match(local, /keeps the log local and untracked; do not add it to commits\./);
  assert.match(local, /Keep `\.decision-log\/` local and untracked; do not add it to commits\./);
  assert.doesNotMatch(local, /commit it with the code/);
  assert.doesNotMatch(local, /Commit `\.decision-log\/` with the code/);

  run(['init'], { cwd }); // plain re-run preserves the persisted choice
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), local);

  run(['init', '--lang', 'zh-CN'], { cwd }); // combines with --lang
  const chinese = fs.readFileSync(agentsFile, 'utf8');
  assert.match(chinese, /driftseal-log-language: zh-CN/);
  assert.equal((chinese.match(/<!-- driftseal-local-log: true -->/g) || []).length, 2);
  assert.match(chinese, /local and untracked/);

  run(['init'], { cwd }); // still preserved after the language switch
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), chinese);

  assert.match(
    runFail(['init', '--local-log=yes'], { cwd }).stderr,
    /flag --local-log does not take a value/
  );

  const defaultCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-no-local-log-'));
  run(['init'], { cwd: defaultCwd });
  const committed = fs.readFileSync(path.join(defaultCwd, 'AGENTS.md'), 'utf8');
  assert.doesNotMatch(committed, /driftseal-local-log/);
  assert.match(committed, /commit it with the code\./);
  assert.match(committed, /Commit `\.decision-log\/` with the code\./);
});

test('init --local-log enables local mode on an already-current repository', () => {
  const { run, runFail } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-local-enable-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');

  run(['init'], { cwd });
  const committed = fs.readFileSync(agentsFile, 'utf8');
  assert.doesNotMatch(committed, /driftseal-local-log/);

  run(['init', '--local-log'], { cwd }); // same-version default -> local is an upgrade, not a customization
  const local = fs.readFileSync(agentsFile, 'utf8');
  assert.equal((local.match(/<!-- driftseal-local-log: true -->/g) || []).length, 2);
  assert.match(local, /driftseal-version: 13/);
  assert.match(local, /keeps the log local and untracked; do not add it to commits\./);
  assert.match(local, /Keep `\.decision-log\/` local and untracked; do not add it to commits\./);

  run(['init'], { cwd }); // plain re-run preserves the persisted choice
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), local);

  const disabled = local.replace(/^<!-- driftseal-local-log: true -->\n/gm, '');
  fs.writeFileSync(agentsFile, disabled);
  assert.match(
    runFail(['init'], { cwd }).stderr,
    /cannot safely upgrade customized protocol block/
  );
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), disabled);
});

test('init --local-log --lang switches language and enables local mode in one run', () => {
  const { run } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-local-lang-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');

  run(['init'], { cwd }); // default v12 protocol in English
  assert.match(fs.readFileSync(agentsFile, 'utf8'), /driftseal-log-language: en/);

  run(['init', '--local-log', '--lang', 'zh-CN'], { cwd });
  const switched = fs.readFileSync(agentsFile, 'utf8');
  assert.match(switched, /driftseal-log-language: zh-CN/);
  assert.match(switched, /\*\*Log language:\*\* `zh-CN`/);
  assert.equal((switched.match(/<!-- driftseal-local-log: true -->/g) || []).length, 2);
  assert.match(switched, /local and untracked/);

  run(['init'], { cwd }); // plain re-run preserves both persisted choices
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), switched);
});

test('init --local-log --lang upgrades a v11 English protocol to local mode in one run', () => {
  const { run } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-v11-local-lang-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');

  run(['init'], { cwd });
  const current = fs.readFileSync(agentsFile, 'utf8');
  const versionEleven = protocolV12(current)
    .replace('driftseal-version: 12', 'driftseal-version: 11')
    .replace('driftseal-decisions-version: 12', 'driftseal-decisions-version: 11')
    .replace(
      '-r "<what the verification showed, written for the next agent>"',
      '-r "<verify output>"'
    )
    .replace(
      '\n   A command whose result can be reconstructed from Git state (for example a\n' +
        '   patch file regenerated from a commit range, or a scratch harness that\n' +
        '   re-runs) needs no intent; content that will be committed and cannot be\n' +
        '   reconstructed (for example a .gitignore edit) does.',
      ''
    )
    .replace(
      '\n   Size an intent to the smallest unit that leaves the tree self-consistent\n' +
        '   and can be verified on its own.',
      ''
    )
    .replace(
      '   To revise a decision\'s prose, edit the file, then run `decision update` to\n' +
        '   record the new content hash. Do not edit a decision after reconciling it;\n' +
        '   run `decision update` again so the final content hash is recorded.\n' +
        '   Interrupted reconciliation is recovered',
      '   Do not edit a decision after reconciling it; run `decision update` again so\n' +
        '   the final content hash is recorded. Interrupted reconciliation is recovered'
    )
    .replace(
      'preparing a Git operation does require a new intent, per the step 1 test.',
      'preparing a Git operation does require a new intent.'
    );
  fs.writeFileSync(agentsFile, versionEleven);

  run(['init', '--local-log', '--lang', 'zh-CN'], { cwd });
  const upgraded = fs.readFileSync(agentsFile, 'utf8');
  assert.match(upgraded, /driftseal-version: 13/);
  assert.match(upgraded, /driftseal-decisions-version: 13/);
  assert.match(upgraded, /driftseal-log-language: zh-CN/);
  assert.equal((upgraded.match(/<!-- driftseal-local-log: true -->/g) || []).length, 2);
  assert.match(upgraded, /local and untracked/);
});

test('init --local-log --lang recovers a block whose language declarations disagree', () => {
  // A v12 default block can carry a comment and a prose declaration that name
  // different languages; --lang is the documented repair, and asking for local
  // mode in the same run must not turn that into a "customized" rejection.
  const cases = [
    { label: 'prose drifted', from: '**Log language:** `en`', to: '**Log language:** `fr`' },
    {
      label: 'comment drifted',
      from: '<!-- driftseal-log-language: en -->',
      to: '<!-- driftseal-log-language: fr -->',
    },
  ];

  for (const { label, from, to } of cases) {
    const { run, runFail } = setup();
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-lang-mismatch-'));
    const agentsFile = path.join(cwd, 'AGENTS.md');

    run(['init'], { cwd });
    const mismatched = fs.readFileSync(agentsFile, 'utf8').split(from).join(to);
    assert.notEqual(mismatched, fs.readFileSync(agentsFile, 'utf8'), `${label}: setup must edit`);
    fs.writeFileSync(agentsFile, mismatched);

    // Without --lang the mismatch is still an error that points at --lang.
    assert.match(
      runFail(['init', '--local-log'], { cwd }).stderr,
      /declares different log languages in the comment \(\w+\) and prose \(\w+\); pass --lang to set one/,
      `${label}: the mismatch must still be reported`
    );
    assert.equal(fs.readFileSync(agentsFile, 'utf8'), mismatched, `${label}: no partial write`);

    // --lang alone repairs it, and --local-log in the same run must too.
    run(['init', '--local-log', '--lang', 'zh-CN'], { cwd });
    const repaired = fs.readFileSync(agentsFile, 'utf8');
    assert.equal(
      (repaired.match(/<!-- driftseal-log-language: zh-CN -->/g) || []).length,
      2,
      `${label}: both comments must switch`
    );
    assert.equal(
      (repaired.match(/\*\*Log language:\*\* `zh-CN`/g) || []).length,
      2,
      `${label}: both prose declarations must switch`
    );
    assert.doesNotMatch(
      repaired,
      /(driftseal-log-language: |\*\*Log language:\*\* `)(?!zh-CN)/,
      `${label}: no stale language declaration may survive`
    );
    assert.equal(
      (repaired.match(/<!-- driftseal-local-log: true -->/g) || []).length,
      2,
      `${label}: local mode must be enabled in the same run`
    );

    run(['init'], { cwd }); // the repaired file is a clean default again
    assert.equal(fs.readFileSync(agentsFile, 'utf8'), repaired, `${label}: re-run must be stable`);
  }
});

test('init --local-log --lang still rejects a customized protocol block', () => {
  const { run, runFail } = setup();
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-custom-local-lang-'));
  const agentsFile = path.join(cwd, 'AGENTS.md');

  run(['init'], { cwd });
  const customized = fs
    .readFileSync(agentsFile, 'utf8')
    .replace('to prevent agent drift.', 'to prevent agent drift, most of the time.');
  fs.writeFileSync(agentsFile, customized);

  assert.match(
    runFail(['init', '--local-log', '--lang', 'zh-CN'], { cwd }).stderr,
    /cannot safely upgrade customized protocol block/
  );
  assert.equal(fs.readFileSync(agentsFile, 'utf8'), customized);
});

test('init --local-log warns when the logs are still tracked by git', () => {
  const trackedRepo = setupGitRepository('driftseal-local-tracked-');
  fs.mkdirSync(path.join(trackedRepo.cwd, '.intent-log'), { recursive: true });
  fs.writeFileSync(path.join(trackedRepo.cwd, '.intent-log', 'events.jsonl'), '');
  trackedRepo.git(['add', '.intent-log']);

  const warned = trackedRepo.run(['init', '--local-log']);
  assert.match(warned, /warning: local log mode is on, but \.intent-log is still tracked by git/);
  assert.match(warned, /`git rm -r --cached -- \.intent-log`/); // only the actually-tracked path
  assert.match(warned, /from this directory/);
  assert.doesNotMatch(warned, /rm -r --cached [^`]*\.decision-log/);
  runInShell(trackedRepo, remediationCommand(warned)); // must work as printed
  assert.equal(trackedRepo.git(['ls-files', '--', '.intent-log']), '');

  const bothRepo = setupGitRepository('driftseal-local-both-tracked-');
  fs.mkdirSync(path.join(bothRepo.cwd, '.intent-log'), { recursive: true });
  fs.writeFileSync(path.join(bothRepo.cwd, '.intent-log', 'events.jsonl'), '');
  fs.mkdirSync(path.join(bothRepo.cwd, '.decision-log'), { recursive: true });
  fs.writeFileSync(path.join(bothRepo.cwd, '.decision-log', '0001-choice.md'), '');
  bothRepo.git(['add', '.intent-log', '.decision-log']);

  const bothWarned = bothRepo.run(['init', '--local-log']);
  assert.match(bothWarned, /\.intent-log and \.decision-log are still tracked by git/);
  assert.match(bothWarned, /`git rm -r --cached -- \.intent-log \.decision-log`/);
  runInShell(bothRepo, remediationCommand(bothWarned));
  assert.equal(bothRepo.git(['ls-files', '--', '.intent-log', '.decision-log']), '');

  const untrackedRepo = setupGitRepository('driftseal-local-untracked-');
  fs.mkdirSync(path.join(untrackedRepo.cwd, '.intent-log'), { recursive: true });
  fs.writeFileSync(path.join(untrackedRepo.cwd, '.intent-log', 'events.jsonl'), '');

  const quiet = untrackedRepo.run(['init', '--local-log']);
  assert.doesNotMatch(quiet, /warning: local log mode/);
});

test('init --local-log detects tracked logs nested at the init cwd', () => {
  const nestedRepo = setupGitRepository('driftseal-local-nested-');
  const nested = path.join(nestedRepo.cwd, 'packages', 'app');
  fs.mkdirSync(path.join(nested, '.intent-log'), { recursive: true });
  fs.writeFileSync(path.join(nested, '.intent-log', 'events.jsonl'), '');
  nestedRepo.git(['add', 'packages/app/.intent-log']);

  const warned = nestedRepo.run(['init', '--local-log'], { cwd: nested });
  assert.match(warned, /packages\/app\/\.intent-log is still tracked by git/);
  assert.match(warned, /`git rm -r --cached -- \.intent-log`/);
  assert.match(warned, /from this directory/);
  runInShell(nestedRepo, remediationCommand(warned), nested);
  assert.equal(nestedRepo.git(['ls-files', '--', 'packages/app/.intent-log']), '');

  const rootRepo = setupGitRepository('driftseal-local-root-only-');
  fs.mkdirSync(path.join(rootRepo.cwd, '.intent-log'), { recursive: true });
  fs.writeFileSync(path.join(rootRepo.cwd, '.intent-log', 'events.jsonl'), '');
  rootRepo.git(['add', '.intent-log']);
  const subdir = path.join(rootRepo.cwd, 'packages', 'app');
  fs.mkdirSync(subdir, { recursive: true });

  const quiet = rootRepo.run(['init', '--local-log'], { cwd: subdir });
  assert.doesNotMatch(quiet, /warning: local log mode/); // no false positive from the root log
});

test('init --local-log warns with a runnable command for awkward nested paths', () => {
  // git's human-readable ls-files C-quotes non-ASCII names, and a repo-relative
  // suggestion is not paste-safe in cmd.exe (spaces, percent, no sh). The
  // warning still reports the tracked path losslessly; the command uses the
  // fixed names and is run from the init cwd, where git resolves them.
  const cases = [
    { label: 'non-ascii', dir: '应用' },
    { label: 'whitespace', dir: 'my app' },
    { label: 'wildcard', dir: 'app[1]' },
    { label: 'option-looking', dir: '--force' },
  ];

  for (const { label, dir } of cases) {
    const repo = setupGitRepository(`driftseal-local-awkward-${label}-`);
    const nested = path.join(repo.cwd, 'packages', dir);
    fs.mkdirSync(path.join(nested, '.intent-log'), { recursive: true });
    fs.writeFileSync(path.join(nested, '.intent-log', 'events.jsonl'), '');
    repo.git(['add', '--', `:(literal)packages/${dir}/.intent-log`]);
    const pathspec = `:(literal)packages/${dir}/.intent-log`;
    assert.notEqual(repo.git(['ls-files', '--', pathspec]), '', `${label}: setup must track`);

    const warned = repo.run(['init', '--local-log'], { cwd: nested });
    assert.ok(
      warned.includes(`warning: local log mode is on, but packages/${dir}/.intent-log is still`),
      `${label}: the tracked path must be reported losslessly, got: ${warned}`
    );
    assert.equal(
      remediationCommand(warned),
      'git rm -r --cached -- .intent-log',
      `${label}: the remediation must be a paste-safe cwd-relative command`
    );

    runInShell(repo, remediationCommand(warned), nested);
    assert.equal(repo.git(['ls-files', '--', pathspec]), '', `${label}: log must become untracked`);
    assert.doesNotMatch(
      repo.run(['init', '--local-log'], { cwd: nested }),
      /warning: local log mode/,
      `${label}: the warning must clear once the log is untracked`
    );
  }
});

test('init --local-log does not confuse a wildcard path with its literal sibling', () => {
  const repo = setupGitRepository('driftseal-local-wildcard-sibling-');
  const wildcard = path.join(repo.cwd, 'packages', 'app[1]');
  const sibling = path.join(repo.cwd, 'packages', 'app1');
  for (const dir of [wildcard, sibling]) {
    fs.mkdirSync(path.join(dir, '.intent-log'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.intent-log', 'events.jsonl'), '');
  }
  repo.git(['add', '--', ':(literal)packages/app1/.intent-log']); // only the sibling is tracked

  const quiet = repo.run(['init', '--local-log'], { cwd: wildcard });
  assert.doesNotMatch(quiet, /warning: local log mode/); // app[1] must not match app1

  repo.git(['add', '--', ':(literal)packages/app[1]/.intent-log']);
  const warned = repo.run(['init', '--local-log'], { cwd: wildcard });
  runInShell(repo, remediationCommand(warned), wildcard);
  assert.equal(repo.git(['ls-files', '--', ':(literal)packages/app[1]/.intent-log']), '');
  assert.notEqual(
    repo.git(['ls-files', '--', ':(literal)packages/app1/.intent-log']),
    '',
    'the untouched sibling must stay tracked'
  );
});

test('skill install uses each platform project directory and is idempotent', () => {
  const { run } = setup();
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'use-driftseal', 'SKILL.md'),
    'utf8'
  );
  const cases = [
    { target: 'codex', label: 'Codex', relative: path.join('.agents', 'skills') },
    { target: 'kimi-code', label: 'Kimi Code', relative: path.join('.kimi-code', 'skills') },
    { target: 'opencode', label: 'OpenCode', relative: path.join('.opencode', 'skills') },
    { target: 'claude-code', label: 'Claude Code', relative: path.join('.claude', 'skills') },
    { target: 'cursor', label: 'Cursor', relative: path.join('.cursor', 'skills') },
  ];

  for (const testCase of cases) {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `driftseal-${testCase.target}-skill-project-`))
    );
    const output = run(['skill', 'install', '--target', testCase.target], { cwd: root });
    assert.match(
      output,
      new RegExp(`Installed use-driftseal skill for ${testCase.label} \\(project\\)`)
    );
    const skillFile = path.join(root, testCase.relative, 'use-driftseal', 'SKILL.md');
    assert.equal(fs.readFileSync(skillFile, 'utf8'), source, testCase.target);
    assert.match(
      run(['skill', 'install', `--target=${testCase.target}`], { cwd: root }),
      new RegExp(`already installed for ${testCase.label} \\(project\\)`)
    );
  }
});

test('skill install remains idempotent when directory permissions differ', {
  skip: process.platform === 'win32',
}, () => {
  const { run } = setup();
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-directory-mode-'))
  );
  const sourceDir = path.join(__dirname, '..', 'skills', 'use-driftseal');
  const skillDir = path.join(root, '.agents', 'skills', 'use-driftseal');
  run(['skill', 'install', '--target', 'codex'], { cwd: root });

  const sourceFileMode = fs.statSync(path.join(sourceDir, 'SKILL.md')).mode & 0o777;
  const installedFileMode = fs.statSync(path.join(skillDir, 'SKILL.md')).mode & 0o777;
  assert.equal(installedFileMode, sourceFileMode);

  const sourceMode = fs.statSync(sourceDir).mode & 0o777;
  fs.chmodSync(skillDir, sourceMode === 0o700 ? 0o755 : 0o700);
  assert.notEqual(fs.statSync(skillDir).mode & 0o777, sourceMode);
  assert.match(
    run(['skill', 'install', '--target', 'codex'], { cwd: root }),
    /already installed for Codex \(project\)/
  );
});

test('skill install uses each platform global directory', () => {
  const { dir, run } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-root-')));
  const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-home-')));
  const env = {
    ...process.env,
    HOME: userHome,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
  };
  const cases = [
    { target: 'codex', relative: path.join('.agents', 'skills') },
    { target: 'kimi-code', relative: path.join('.kimi-code', 'skills') },
    { target: 'opencode', relative: path.join('.config', 'opencode', 'skills') },
    { target: 'claude-code', relative: path.join('.claude', 'skills') },
    { target: 'cursor', relative: path.join('.cursor', 'skills') },
  ];

  for (const testCase of cases) {
    run(
      ['skill', 'install', '--target', testCase.target, '--scope', 'global', '--root', root],
      { cwd: os.tmpdir(), env }
    );
    assert.equal(
      fs.existsSync(path.join(userHome, testCase.relative, 'use-driftseal', 'SKILL.md')),
      true,
      testCase.target
    );
  }
});

test('skill install protects conflicts and --force replaces the complete skill directory', () => {
  const { run, runFail } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-conflict-')));
  const skillDir = path.join(root, '.agents', 'skills', 'use-driftseal');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), 'custom skill\n');
  fs.writeFileSync(path.join(skillDir, 'extra.txt'), 'keep until forced\n');

  assert.match(
    runFail(['skill', 'install', '--target', 'codex'], { cwd: root }).stderr,
    /already has a use-driftseal skill DriftSeal did not install.*--force/
  );
  assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), 'custom skill\n');
  assert.equal(fs.existsSync(path.join(skillDir, 'extra.txt')), true);

  assert.match(
    run(['skill', 'install', '--target', 'codex', '--force'], { cwd: root }),
    /Installed use-driftseal skill for Codex \(project\)/
  );
  assert.equal(
    fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'),
    fs.readFileSync(path.join(__dirname, '..', 'skills', 'use-driftseal', 'SKILL.md'), 'utf8')
  );
  assert.equal(fs.existsSync(path.join(skillDir, 'extra.txt')), false);
  assert.deepEqual(
    fs.readdirSync(path.dirname(skillDir)).filter((name) => name.startsWith('.use-driftseal.')),
    []
  );
});

/*
 * Stages a DriftSeal tree whose bundled skill differs from this checkout, so the
 * test can install with today's release and upgrade with tomorrow's. It passes
 * only while the bundled skill digest is listed in SKILL_RELEASE_DIGESTS, which
 * is what keeps an installed skill upgradable by the next release.
 */
function stageNextSkillRelease() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-next-')));
  const cli = path.join(home, 'bin', 'driftseal.js');
  const skillFile = path.join(home, 'skills', 'use-driftseal', 'SKILL.md');
  fs.mkdirSync(path.dirname(cli), { recursive: true });
  fs.mkdirSync(path.dirname(skillFile), { recursive: true });
  fs.copyFileSync(DRIFTSEAL, cli);
  fs.copyFileSync(path.join(__dirname, '..', 'package.json'), path.join(home, 'package.json'));
  const content =
    fs.readFileSync(path.join(__dirname, '..', 'skills', 'use-driftseal', 'SKILL.md'), 'utf8') +
    '\n<!-- next release -->\n';
  fs.writeFileSync(skillFile, content);
  return { cli, content };
}

test('skill install upgrades a skill shipped by an earlier DriftSeal without --force', () => {
  const { dir, run } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-upgrade-')));
  const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-home-')));
  const env = {
    ...process.env,
    HOME: userHome,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
  };
  const install = ['skill', 'install', '--target', 'claude-code', '--scope', 'global', '--root', root];
  const skillFile = path.join(userHome, '.claude', 'skills', 'use-driftseal', 'SKILL.md');
  run(install, { cwd: os.tmpdir(), env });

  const next = stageNextSkillRelease();
  const upgrade = execFileSync(process.execPath, [next.cli, ...install], {
    cwd: os.tmpdir(),
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  assert.match(upgrade, /Upgraded use-driftseal skill for Claude Code \(global\)/);
  assert.equal(fs.readFileSync(skillFile, 'utf8'), next.content);
  assert.deepEqual(
    fs.readdirSync(path.dirname(path.dirname(skillFile))).filter((name) => name.startsWith('.use-driftseal.')),
    []
  );
});

test('skill install still protects a locally edited skill from a newer release', () => {
  const { dir } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-skill-edited-')));
  const skillDir = path.join(root, '.agents', 'skills', 'use-driftseal');
  fs.mkdirSync(skillDir, { recursive: true });
  const edited =
    fs.readFileSync(path.join(__dirname, '..', 'skills', 'use-driftseal', 'SKILL.md'), 'utf8') +
    '\n<!-- local note -->\n';
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), edited);

  const next = stageNextSkillRelease();
  let failure;
  try {
    execFileSync(process.execPath, [next.cli, 'skill', 'install', '--target', 'codex'], {
      cwd: root,
      env: { ...process.env, DRIFTSEAL_HOME: dir, DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions') },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    failure = err;
  }

  assert.ok(failure, 'expected the newer release to refuse a locally edited skill');
  assert.match(failure.stderr, /already has a use-driftseal skill DriftSeal did not install.*--force/);
  assert.equal(fs.readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'), edited);
});

test('skill install validates its subcommand, target, scope, root, and arguments', () => {
  const { run, runFail } = setup();
  assert.match(run(['help']), /driftseal skill install --target TARGET/);
  assert.match(runFail(['skill']).stderr, /usage: driftseal skill install/);
  assert.match(runFail(['skill', 'remove', '--target', 'codex']).stderr, /usage: driftseal skill install/);
  assert.match(
    runFail(['skill', 'install', '--target', 'claude']).stderr,
    /unsupported skill target "claude"/
  );
  assert.match(
    runFail(['skill', 'install', '--target', 'codex', '--scope', 'workspace']).stderr,
    /invalid skill install scope "workspace"/
  );
  assert.match(
    runFail(['skill', 'install', '--target', 'codex', '--root', '/does/not/exist']).stderr,
    /repository root does not exist/
  );
  assert.match(
    runFail(['skill', 'install', '--target', 'codex', 'extra']).stderr,
    /usage: driftseal skill install/
  );
});

test('mcp install configures Codex for the current project by default and is idempotent', () => {
  const { run } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal mcp project-')));
  const configFile = path.join(root, '.codex', 'config.toml');

  const installed = run(['mcp', 'install', '--target', 'codex'], { cwd: root });
  assert.match(installed, /Installed DriftSeal MCP for Codex \(project\)/);
  assert.match(installed, new RegExp(`Repository root: ${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  const first = fs.readFileSync(configFile, 'utf8');
  assert.equal(
    first,
    `[mcp_servers.driftseal]\ncommand = "driftseal-mcp"\nargs = ["--root", ${JSON.stringify(root)}]\n`
  );

  assert.match(
    run(['mcp', 'install', '--target=codex'], { cwd: root }),
    /already installed for Codex \(project\)/
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), first);
});

test('mcp install supports global Codex config with an explicit repository root', () => {
  const { dir, run } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-root-')));
  const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-home-'));
  const env = {
    ...process.env,
    HOME: userHome,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
  };

  const output = run(
    ['mcp', 'install', '--target', 'codex', '--scope', 'global', '--root', root],
    { cwd: os.tmpdir(), env }
  );
  assert.match(output, /Installed DriftSeal MCP for Codex \(global\)/);
  const configFile = path.join(userHome, '.codex', 'config.toml');
  assert.match(fs.readFileSync(configFile, 'utf8'), new RegExp(JSON.stringify(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(fs.existsSync(path.join(root, '.codex', 'config.toml')), false);
});

test('mcp install supports Kimi Code, OpenCode, Claude Code, and Cursor project config', () => {
  const { run } = setup();
  const cases = [
    {
      target: 'kimi-code',
      label: 'Kimi Code',
      relative: path.join('.kimi-code', 'mcp.json'),
      container: 'mcpServers',
    },
    {
      target: 'opencode',
      label: 'OpenCode',
      relative: 'opencode.json',
      container: 'mcp',
    },
    {
      target: 'claude-code',
      label: 'Claude Code',
      relative: '.mcp.json',
      container: 'mcpServers',
    },
    {
      target: 'cursor',
      label: 'Cursor',
      relative: path.join('.cursor', 'mcp.json'),
      container: 'mcpServers',
    },
  ];

  for (const testCase of cases) {
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `driftseal-${testCase.target}-project-`))
    );
    const output = run(['mcp', 'install', '--target', testCase.target], { cwd: root });
    assert.match(output, new RegExp(`Installed DriftSeal MCP for ${testCase.label}`));
    const configFile = path.join(root, testCase.relative);
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const expected =
      testCase.target === 'opencode'
        ? { type: 'local', command: ['driftseal-mcp', '--root', root] }
        : { command: 'driftseal-mcp', args: ['--root', root] };
    assert.deepEqual(config[testCase.container].driftseal, expected, testCase.target);
    if (testCase.target === 'opencode') {
      assert.equal(config.$schema, 'https://opencode.ai/config.json');
    }
    assert.match(
      run(['mcp', 'install', '--target', testCase.target], { cwd: root }),
      new RegExp(`already installed for ${testCase.label}`)
    );
  }
});

test('mcp install uses each agent global config location', () => {
  const { dir, run } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-agents-root-')));
  const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-agents-home-')));
  const kimiHome = path.join(userHome, 'custom-kimi-home');
  const env = {
    ...process.env,
    HOME: userHome,
    KIMI_CODE_HOME: kimiHome,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
  };
  const cases = [
    { target: 'kimi-code', file: path.join(kimiHome, 'mcp.json'), container: 'mcpServers' },
    {
      target: 'opencode',
      file: path.join(userHome, '.config', 'opencode', 'opencode.json'),
      container: 'mcp',
    },
    { target: 'claude-code', file: path.join(userHome, '.claude.json'), container: 'mcpServers' },
    { target: 'cursor', file: path.join(userHome, '.cursor', 'mcp.json'), container: 'mcpServers' },
  ];

  fs.writeFileSync(path.join(userHome, '.claude.json'), JSON.stringify({ theme: 'dark' }));
  for (const testCase of cases) {
    run(
      ['mcp', 'install', '--target', testCase.target, '--scope', 'global', '--root', root],
      { cwd: os.tmpdir(), env }
    );
    const config = JSON.parse(fs.readFileSync(testCase.file, 'utf8'));
    assert.ok(config[testCase.container].driftseal, testCase.target);
    if (testCase.target === 'claude-code') assert.equal(config.theme, 'dark');
  }
});

test('JSON MCP targets preserve sibling config and require --force for conflicts', () => {
  const { run, runFail } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-cursor-conflict-')));
  const configDir = path.join(root, '.cursor');
  const configFile = path.join(configDir, 'mcp.json');
  fs.mkdirSync(configDir);
  const existing = {
    editorSetting: true,
    mcpServers: {
      other: { url: 'https://example.test/mcp' },
      driftseal: { command: 'custom-driftseal', args: [] },
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(existing, null, 2) + '\n');

  assert.match(
    runFail(['mcp', 'install', '--target', 'cursor'], { cwd: root }).stderr,
    /already defines the driftseal MCP server.*--force/
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(configFile, 'utf8')), existing);

  run(['mcp', 'install', '--target', 'cursor', '--force'], { cwd: root });
  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(updated.editorSetting, true);
  assert.deepEqual(updated.mcpServers.other, existing.mcpServers.other);
  assert.deepEqual(updated.mcpServers.driftseal, {
    command: 'driftseal-mcp',
    args: ['--root', root],
  });
});

test('JSON MCP targets reject malformed config without replacing it', () => {
  const { runFail } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-kimi-invalid-')));
  const configDir = path.join(root, '.kimi-code');
  const configFile = path.join(configDir, 'mcp.json');
  fs.mkdirSync(configDir);
  fs.writeFileSync(configFile, '{ invalid json\n');

  assert.match(
    runFail(['mcp', 'install', '--target', 'kimi-code', '--force'], { cwd: root }).stderr,
    /Kimi Code config is not valid JSON/
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{ invalid json\n');
});

test('mcp install preserves Codex config and requires --force for a conflicting server', () => {
  const { run, runFail } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-mcp-conflict-')));
  const configDir = path.join(root, '.codex');
  const configFile = path.join(configDir, 'config.toml');
  fs.mkdirSync(configDir);
  const existing =
    'model = "gpt-test"\n\n' +
    '[mcp_servers.driftseal]\n' +
    'command = "custom-driftseal"\n' +
    'args = []\n\n' +
    '[mcp_servers.other]\n' +
    'url = "https://example.test/mcp"\n';
  fs.writeFileSync(configFile, existing);

  assert.match(
    runFail(['mcp', 'install', '--target', 'codex'], { cwd: root }).stderr,
    /already defines mcp_servers\.driftseal.*--force/
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), existing);

  run(['mcp', 'install', '--target', 'codex', '--force'], { cwd: root });
  const updated = fs.readFileSync(configFile, 'utf8');
  assert.match(updated, /^model = "gpt-test"/);
  assert.match(updated, /command = "driftseal-mcp"/);
  assert.match(updated, new RegExp(JSON.stringify(root).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(updated, /\[mcp_servers\.other\]\nurl = "https:\/\/example\.test\/mcp"/);
  assert.doesNotMatch(updated, /custom-driftseal/);
});

test('mcp install validates its target, scope, root, and arguments', () => {
  const { run, runFail } = setup();
  assert.match(run(['help']), /targets: codex, kimi-code, opencode, claude-code, cursor/);
  assert.match(runFail(['mcp', 'install']).stderr, /usage: driftseal mcp install/);
  assert.match(
    runFail(['mcp', 'install', '--target', 'claude']).stderr,
    /unsupported MCP target "claude"/
  );
  assert.match(
    runFail(['mcp', 'install', '--target', 'codex', '--scope', 'workspace']).stderr,
    /invalid MCP install scope "workspace"/
  );
  assert.match(
    runFail(['mcp', 'install', '--target', 'codex', '--root', '/does/not/exist']).stderr,
    /repository root does not exist/
  );
  assert.match(runFail(['mcp', 'remove', '--target', 'codex']).stderr, /usage: driftseal mcp install/);
  assert.match(runFail(['mcp', 'install', '--target', 'codex', 'extra']).stderr, /usage: driftseal mcp install/);
});

test('decision add writes a numbered MADR document', () => {
  const { dir, run } = setup();
  const output = run([
    'decision',
    'add',
    'Use SQLite\nfor local state',
    '--context',
    'The CLI needs durable local storage.',
    '--outcome',
    'Choose SQLite because writes must be transactional.',
    '--driver',
    'No external service',
    '--driver',
    'Atomic writes',
    '--option',
    'SQLite',
    '--option',
    'JSON files',
    '--consequence',
    'Good: state updates are atomic.',
  ]).trim();

  assert.match(output, /0001-use-sqlite-for-local-state\.md$/);
  const content = fs.readFileSync(output, 'utf8');
  assert.match(content, /^# 1\. Use SQLite for local state/m);
  assert.match(content, /^Date: \d{4}-\d{2}-\d{2}$/m);
  assert.match(content, /## Status\n\nAccepted/);
  assert.match(content, /## Context and Problem Statement/);
  assert.match(content, /\* No external service\n\* Atomic writes/);
  assert.match(content, /\* SQLite\n\* JSON files/);
  assert.match(content, /## Decision Outcome/);
  assert.match(content, /\* Good: state updates are atomic\./);
  assert.equal(path.dirname(output), path.join(dir, 'decisions'));
});

test('decision filenames bound long title slugs', () => {
  const { run } = setup();
  const title = 'A'.repeat(1000);
  const output = run(['decision', 'add', title, '-c', 'context', '-o', 'outcome']).trim();

  assert.equal(path.basename(output), `0001-${'a'.repeat(180)}.md`);
  assert.match(fs.readFileSync(output, 'utf8'), new RegExp(`^# 1\\. ${title}`));
});

test('decision add validates required fields and status', () => {
  const { runFail } = setup();
  assert.match(runFail(['decision', 'add', 'Missing details']).stderr, /usage/);
  assert.match(
    runFail(['decision', 'add', 'Blank context', '-c', '   ', '-o', 'outcome']).stderr,
    /usage/
  );
  assert.match(
    runFail(['decision', 'add', 'Missing outcome value', '-c', 'context', '-o', '--driver', 'x'])
      .stderr,
    /flag -o requires a value/
  );
  assert.match(
    runFail(['decision', 'add', 'Empty status', '-c', 'context', '-o', 'outcome', '--status='])
      .stderr,
    /requires a value/
  );
  assert.match(
    runFail([
      'decision',
      'add',
      'Invalid status',
      '-c',
      'context',
      '-o',
      'outcome',
      '-s',
      'done',
    ]).stderr,
    /invalid decision status/
  );
});

test('decision add supports a distinct deferred status', () => {
  const { run } = setup();
  const output = run([
    'decision',
    'add',
    'Defer remote storage',
    '-c',
    'The local format must stabilize first.',
    '-o',
    'Revisit after the local schema reaches version 2.',
    '-s',
    'deferred',
  ]).trim();

  assert.match(fs.readFileSync(output, 'utf8'), /## Status\n\nDeferred/);
  assert.match(run(['decision', 'list']), /\[0001\] Deferred — Defer remote storage/);
  assert.match(run(['help']), /proposed\|accepted\|rejected\|deferred\|deprecated\|superseded/);
});

test('decision free text can contain Markdown headings without breaking round trips', () => {
  const { run } = setup();
  const file = run([
    'decision',
    'add',
    'Heading-safe content',
    '-c',
    'Context before quoted headings.\n\n## Status\n\nAccepted as quoted input.\n\n## Decision History\n\nNot the managed history.',
    '-o',
    'Outcome with another title.\n\n# 99. Not the document title',
  ]).trim();
  assert.match(run(['decision', 'list']), /Heading-safe content/);
  const originalWithTrailingContent =
    fs.readFileSync(file, 'utf8') + 'Manual tail with a Markdown hard break.  \n\n\n';
  fs.writeFileSync(file, originalWithTrailingContent);
  const intentId = run(['begin', 'confirm heading-safe content', '--decision', '1']).trim();
  run([
    'decision',
    'update',
    '1',
    '--note',
    'Confirmation note.\n\n## Status\n\nThis heading is note content.',
  ]);
  assert.equal(run(['end']).trim(), `${intentId} completed`);
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.startsWith(originalWithTrailingContent));
  assert.match(updated, /This heading is note content\./);
  assert.equal((updated.match(/^## Decision History$/gm) || []).length, 2);
  assert.ok(updated.lastIndexOf('## Decision History') < updated.indexOf('<!-- driftseal-reconciliation:'));
  assert.match(run(['decision', 'show', '1']), /# 99\. Not the document title/);
});

test('decision reconciliation recognizes history markers from an earlier brand', () => {
  const { run } = setup();
  const file = run(['decision', 'add', 'Migrated history', '-c', 'context', '-o', 'outcome']).trim();
  fs.appendFileSync(
    file,
    '\n## Decision History\n\n<!-- legacy-reconciliation: prior -->\n### Prior entry\n'
  );
  const intentId = run(['begin', 'continue migrated history', '--decision', '1']).trim();
  run(['decision', 'update', '1', '--note', 'Confirmed under the current brand.']);
  assert.equal(run(['end']).trim(), `${intentId} completed`);

  const updated = fs.readFileSync(file, 'utf8');
  assert.equal((updated.match(/^## Decision History$/gm) || []).length, 1);
  assert.match(updated, /<!-- driftseal-reconciliation:/);
});

test('decision parsing supports CRLF and rejects malformed status sections', () => {
  const { dir, run, runFail } = setup();
  const decisions = path.join(dir, 'decisions');
  fs.mkdirSync(decisions);
  const file = path.join(decisions, '0001-crlf.md');
  fs.writeFileSync(
    file,
    '# 1. CRLF decision\r\n\r\n## Status\r\n\r\nDeferred\r\n\r\n## Decision Outcome\r\n\r\nWait.\r\n'
  );
  assert.equal(run(['decision', 'list', '--status', 'deferred', '--count']), '1\n');
  assert.match(run(['decision', 'show', '00001']), /^# 1\. CRLF decision/);
  run(['begin', 'confirm CRLF decision', '--decision', '00001']);
  run(['decision', 'update', '1', '--note', 'Still deferred.']);
  run(['end']);
  const updatedCrLf = fs.readFileSync(file, 'utf8');
  assert.equal(updatedCrLf.replace(/\r\n/g, '').includes('\n'), false);

  const malformed = '# 1. Broken\n\n## Status\n\n## Context and Problem Statement\n\nMissing.\n';
  fs.writeFileSync(file, malformed);
  assert.match(runFail(['decision', 'list']).stderr, /no valid status value/);
  assert.equal(fs.readFileSync(file, 'utf8'), malformed);
});

test('decision catalog rejects canonical duplicates, title mismatches, and symlinks', () => {
  const { dir, runFail } = setup();
  const decisions = path.join(dir, 'decisions');
  fs.mkdirSync(decisions);
  const record = (id, title) => `# ${id}. ${title}\n\n## Status\n\nAccepted\n`;

  fs.writeFileSync(path.join(decisions, '0001-first.md'), record(1, 'First'));
  fs.writeFileSync(path.join(decisions, '00001-duplicate.md'), record(1, 'Duplicate'));
  assert.match(runFail(['decision', 'list']).stderr, /duplicate decision id 0001/);

  fs.unlinkSync(path.join(decisions, '00001-duplicate.md'));
  fs.writeFileSync(path.join(decisions, '0002-mismatch.md'), record(3, 'Mismatch'));
  assert.match(runFail(['decision', 'list']).stderr, /decision id mismatch/);

  fs.unlinkSync(path.join(decisions, '0002-mismatch.md'));
  if (process.platform !== 'win32') {
    const outside = path.join(dir, 'outside.md');
    fs.writeFileSync(outside, record(2, 'Outside'));
    fs.symlinkSync(outside, path.join(decisions, '0002-link.md'));
    assert.match(runFail(['decision', 'list']).stderr, /must not be a symbolic link/);
  }
});

test('decision list and show read MADR records', () => {
  const { run, runFail } = setup();
  run(['decision', 'add', 'First decision', '-c', 'context', '-o', 'outcome']);
  run([
    'decision',
    'add',
    'Second decision',
    '-c',
    'context',
    '-o',
    'outcome',
    '-s',
    'proposed',
  ]);
  run([
    'decision',
    'add',
    'Deferred decision',
    '-c',
    'context',
    '-o',
    'outcome',
    '-s',
    'deferred',
  ]);

  const listed = run(['decision', 'list']);
  assert.match(listed, /\[0001\] Accepted — First decision/);
  assert.match(listed, /\[0002\] Proposed — Second decision/);
  assert.match(listed, /\[0003\] Deferred — Deferred decision/);
  const last = run(['decision', 'list', '--last', '1']);
  assert.doesNotMatch(last, /First decision/);
  assert.match(last, /Deferred decision/);
  const deferred = run(['decision', 'list', '--status', 'deferred']);
  assert.doesNotMatch(deferred, /First decision|Second decision/);
  assert.match(deferred, /Deferred decision/);
  assert.equal(run(['decision', 'list', '--status', 'deferred', '--count']), '1\n');
  assert.equal(run(['decision', 'list', '--status', 'rejected', '--count']), '0\n');
  assert.match(run(['decision', 'list', '-s', 'rejected']), /no decision records with status rejected/);
  assert.match(run(['decision', 'show', '1']), /^# 1\. First decision/);
  assert.match(runFail(['decision', 'list', '--status', 'unknown']).stderr, /invalid decision status/);
  assert.match(
    runFail(['decision', 'list', '--last', '1', '--count']).stderr,
    /cannot be combined/
  );
  assert.match(runFail(['decision', 'list', '--last', '1junk']).stderr, /positive integer/);
  assert.match(runFail(['decision', 'list', '--last=']).stderr, /requires a value/);
  assert.match(runFail(['decision', 'list', '--last', '9'.repeat(400)]).stderr, /positive integer/);
});

test('decision list handles an empty log and show rejects unknown ids', () => {
  const { run, runFail } = setup();
  assert.match(run(['decision', 'list']), /decision log is empty/);
  assert.equal(run(['decision', 'list', '--count']), '0\n');
  assert.match(runFail(['decision', 'show', '1']).stderr, /unknown decision id/);
});

test('targeted decision reads and unfiltered counts do not parse unrelated records', () => {
  const { dir, run, runFail } = setup();
  run(['decision', 'add', 'Valid decision', '-c', 'context', '-o', 'outcome']);
  const decisions = path.join(dir, 'decisions');
  fs.writeFileSync(path.join(decisions, '0002-malformed.md'), 'not a MADR record\n');
  fs.writeFileSync(
    path.join(decisions, '0003-newest.md'),
    '# 3. Newest decision\n\n## Status\n\nAccepted\n'
  );

  assert.match(run(['decision', 'show', '1']), /^# 1\. Valid decision/);
  assert.equal(run(['decision', 'list', '--count']), '3\n');
  assert.match(run(['decision', 'list', '--last', '1']), /\[0003\] Accepted — Newest decision/);
  assert.match(runFail(['decision', 'list', '--status', 'accepted']).stderr, /must begin with a decision title/);
});

test('decision ids remain usable beyond 9999 and duplicate ids are rejected by show', () => {
  const { dir, run, runFail } = setup();
  const decisions = path.join(dir, 'decisions');
  fs.mkdirSync(decisions);
  fs.writeFileSync(path.join(decisions, '9999-placeholder.md'), '# 9999. Placeholder\n\n## Status\n\nAccepted\n');

  const created = run(['decision', 'add', 'Beyond four digits', '-c', 'context', '-o', 'outcome']).trim();
  assert.match(created, /10000-beyond-four-digits\.md$/);
  assert.match(run(['decision', 'list', '--last', '1']), /\[10000\] Accepted — Beyond four digits/);
  assert.match(run(['decision', 'show', '10000']), /^# 10000\. Beyond four digits/);

  fs.writeFileSync(path.join(decisions, '10000-duplicate.md'), '# 10000. Duplicate\n\n## Status\n\nAccepted\n');
  assert.match(runFail(['decision', 'show', '10000']).stderr, /duplicate decision id/);
});

test('ids increment within the same day', () => {
  const { run } = setup();
  const a = run(['begin', 'a']).trim();
  run(['end']);
  const b = run(['begin', 'b']).trim();
  assert.match(a, /-001$/);
  assert.match(b, /-002$/);
});

test('hook prompt and stop emit advisory reminders once an intent log exists', () => {
  const { dir, run } = setup();

  // No intent log yet: hooks stay silent and still exit 0.
  assert.equal(run(['hook', 'prompt']), '');
  assert.equal(run(['hook', 'stop']), '');

  run(['begin', 'create the log']);
  run(['end']);

  const prompt = run(['hook', 'prompt']);
  assert.match(prompt, /DriftSeal reminder: if this round will modify files/);
  assert.match(prompt, /need no intent/);

  const stopped = run(['hook', 'stop']);
  assert.match(stopped, /no intent is open/);

  const intentId = run(['begin', 'keep an intent open', '--verify', 'npm test']).trim();
  const openStop = run(['hook', 'stop']);
  assert.match(openStop, new RegExp(`intent ${intentId} is still in_progress`));
  assert.match(openStop, /driftseal end/);
  assert.equal(fs.existsSync(path.join(dir, 'events.jsonl')), true);
});

test('hook output uses Claude Code context for prompt and a non-continuing Stop warning', () => {
  const { run } = setup();
  run(['begin', 'format check']);

  const prompt = JSON.parse(run(['hook', 'prompt', '--format', 'claude-code']));
  assert.equal(prompt.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(prompt.hookSpecificOutput.additionalContext, /DriftSeal reminder/);

  const stop = JSON.parse(run(['hook', 'stop', '--format=claude-code']));
  assert.match(stop.systemMessage, /still in_progress/);
  assert.equal(stop.hookSpecificOutput, undefined);
});

test('hook install configures global Kimi Code hooks and preserves following TOML tables', () => {
  const { run, runFail } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-hook-kimi-')));
  const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-hook-kimi-home-')));
  const configFile = path.join(configDir, 'config.toml');
  const env = { ...process.env, KIMI_CODE_HOME: configDir };
  fs.writeFileSync(configFile, 'model = "kimi-test"\n\n[[hooks]]\nevent = "PreToolUse"\ncommand = "other-hook"\n');

  assert.match(
    runFail(['hook', 'install', '--target', 'kimi-code'], { cwd: root, env }).stderr,
    /Kimi Code hooks support only global scope/
  );

  const installed = run(['hook', 'install', '--target', 'kimi-code', '--scope', 'global'], {
    cwd: root,
    env,
  });
  assert.match(installed, /Installed DriftSeal hooks for Kimi Code \(global\)/);
  const first = fs.readFileSync(configFile, 'utf8');
  assert.match(first, /^model = "kimi-test"/);
  assert.match(first, /\[\[hooks\]\]\nevent = "PreToolUse"\ncommand = "other-hook"/);
  assert.match(
    first,
    /\[\[hooks\]\]\nevent = "UserPromptSubmit"\ncommand = "driftseal hook prompt"\ntimeout = 5\n\n\[\[hooks\]\]\nevent = "Stop"\ncommand = "driftseal hook stop"\ntimeout = 5\n$/
  );

  assert.match(
    run(['hook', 'install', '--target=kimi-code', '--scope=global'], { cwd: root, env }),
    /already installed for Kimi Code \(global\)/
  );
  assert.equal(fs.readFileSync(configFile, 'utf8'), first);

  fs.writeFileSync(configFile, first.replace('timeout = 5\n\n[[hooks]]', 'timeout = 9\n\n[[hooks]]'));
  assert.match(
    runFail(['hook', 'install', '--target', 'kimi-code', '--scope', 'global'], { cwd: root, env })
      .stderr,
    /already defines driftseal hooks.*--force/
  );
  fs.appendFileSync(configFile, '\n[workspace]\nadditional_dir = ["/tmp/shared"]\n');
  run(['hook', 'install', '--target', 'kimi-code', '--scope', 'global', '--force'], {
    cwd: root,
    env,
  });
  const forced = fs.readFileSync(configFile, 'utf8');
  assert.match(forced, /\[workspace\]\nadditional_dir = \["\/tmp\/shared"\]/);
  assert.doesNotMatch(forced, /timeout = 9/);
  assert.match(
    forced,
    /\[\[hooks\]\]\nevent = "UserPromptSubmit"\ncommand = "driftseal hook prompt"\ntimeout = 5/
  );
});

test('hook reminders find an initialized repository from a nested working directory', () => {
  const { run } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-hook-ancestor-')));
  const nested = path.join(root, 'packages', 'app');
  fs.mkdirSync(nested, { recursive: true });
  const env = { ...process.env };
  delete env.DRIFTSEAL_HOME;
  delete env.DRIFTSEAL_DECISION_HOME;

  run(['begin', 'test ancestor discovery'], { cwd: root, env });
  assert.match(run(['hook', 'prompt'], { cwd: nested, env }), /DriftSeal reminder/);
  assert.match(run(['hook', 'stop'], { cwd: nested, env }), /still in_progress/);
  run(['end', '--status', 'abandoned'], { cwd: root, env });
});

test('hook install configures Claude Code settings hooks and keeps sibling entries', () => {
  const { run, runFail } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-hook-claude-')));
  const configDir = path.join(root, '.claude');
  const configFile = path.join(configDir, 'settings.json');
  fs.mkdirSync(configDir);
  const existing = {
    theme: 'dark',
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'driftseal hook prompt --format old' }] }],
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(existing, null, 2) + '\n');

  assert.match(
    runFail(['hook', 'install', '--target', 'claude-code'], { cwd: root }).stderr,
    /already defines driftseal hooks.*--force/
  );

  run(['hook', 'install', '--target', 'claude-code', '--force'], { cwd: root });
  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.equal(updated.theme, 'dark');
  assert.deepEqual(updated.hooks.PreToolUse, existing.hooks.PreToolUse);
  assert.deepEqual(updated.hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: 'driftseal hook prompt --format claude-code' }] },
  ]);
  assert.deepEqual(updated.hooks.Stop, [
    { hooks: [{ type: 'command', command: 'driftseal hook stop --format claude-code' }] },
  ]);

  assert.match(
    run(['hook', 'install', '--target', 'claude-code'], { cwd: root }),
    /already installed for Claude Code \(project\)/
  );
});

test('hook install configures Codex hooks.json with only the prompt hook', () => {
  const { run, runFail } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-hook-codex-')));
  const configDir = path.join(root, '.codex');
  const configFile = path.join(configDir, 'hooks.json');
  fs.mkdirSync(configDir);
  const existing = {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'driftseal hook prompt --format old' }] }],
    },
  };
  fs.writeFileSync(configFile, JSON.stringify(existing, null, 2) + '\n');

  // A stale driftseal entry conflicts until --force replaces it.
  assert.match(
    runFail(['hook', 'install', '--target', 'codex'], { cwd: root }).stderr,
    /already defines driftseal hooks.*--force/
  );

  const installed = run(['hook', 'install', '--target', 'codex', '--force'], { cwd: root });
  assert.match(installed, /Installed DriftSeal hooks for Codex \(project\)/);
  const updated = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  assert.deepEqual(updated.hooks.PreToolUse, existing.hooks.PreToolUse);
  // Codex Stop accepts no advisory context, so only the prompt hook is installed.
  assert.deepEqual(updated.hooks, {
    PreToolUse: existing.hooks.PreToolUse,
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'driftseal hook prompt' }] }],
  });

  assert.match(
    run(['hook', 'install', '--target', 'codex'], { cwd: root }),
    /already installed for Codex \(project\)/
  );
});

test('hook install supports global scope locations', () => {
  const { dir, run } = setup();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-hook-root-')));
  const userHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-hook-home-')));
  const kimiHome = path.join(userHome, 'custom-kimi-home');
  const env = {
    ...process.env,
    HOME: userHome,
    KIMI_CODE_HOME: kimiHome,
    DRIFTSEAL_HOME: dir,
    DRIFTSEAL_DECISION_HOME: path.join(dir, 'decisions'),
  };

  run(['hook', 'install', '--target', 'kimi-code', '--scope', 'global', '--root', root], {
    cwd: os.tmpdir(),
    env,
  });
  assert.match(
    fs.readFileSync(path.join(kimiHome, 'config.toml'), 'utf8'),
    /command = "driftseal hook stop"/
  );
  assert.equal(fs.existsSync(path.join(root, '.kimi-code', 'config.toml')), false);

  run(['hook', 'install', '--target', 'claude-code', '--scope', 'global', '--root', root], {
    cwd: os.tmpdir(),
    env,
  });
  const settings = JSON.parse(
    fs.readFileSync(path.join(userHome, '.claude', 'settings.json'), 'utf8')
  );
  assert.deepEqual(settings.hooks.Stop, [
    { hooks: [{ type: 'command', command: 'driftseal hook stop --format claude-code' }] },
  ]);

  run(['hook', 'install', '--target', 'codex', '--scope', 'global', '--root', root], {
    cwd: os.tmpdir(),
    env,
  });
  const codexHooks = JSON.parse(
    fs.readFileSync(path.join(userHome, '.codex', 'hooks.json'), 'utf8')
  );
  assert.deepEqual(codexHooks.hooks.UserPromptSubmit, [
    { hooks: [{ type: 'command', command: 'driftseal hook prompt' }] },
  ]);
  assert.equal(fs.existsSync(path.join(root, '.codex', 'hooks.json')), false);
});

test('hook command validates its subcommands, targets, and formats', () => {
  const { run, runFail } = setup();
  assert.match(run(['help']), /driftseal hook install --target TARGET/);
  assert.match(runFail(['hook']).stderr, /usage: driftseal hook install/);
  assert.match(runFail(['hook', 'remove']).stderr, /usage: driftseal hook install/);
  assert.match(
    runFail(['hook', 'install', '--target', 'cursor']).stderr,
    /unsupported hook target "cursor"/
  );
  assert.match(
    runFail(['hook', 'install', '--target', 'kimi-code', '--scope', 'workspace']).stderr,
    /invalid hook install scope "workspace"/
  );
  assert.match(runFail(['hook', 'prompt', 'extra']).stderr, /usage: driftseal hook/);
  assert.match(
    runFail(['hook', 'prompt', '--format', 'json']).stderr,
    /unsupported hook output format "json"/
  );
});

test('absorb remaps colliding intent ids from another log', () => {
  const ours = setup();
  const theirs = setup();
  const oursId = ours.run(['begin', 'ours work']).trim();
  ours.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  const theirsId = theirs.run(['begin', 'theirs work']).trim();
  theirs.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  assert.equal(oursId, theirsId);

  const dry = ours.run(['absorb', path.join(theirs.dir, 'events.jsonl'), '--dry-run']);
  assert.match(dry, /remapped 1 intent id/);
  assert.match(dry, new RegExp(`${theirsId} \\(theirs\\) -> ${theirsId.replace(/001$/, '002')}`));
  assert.equal(ours.events().length, 2);

  const out = ours.run(['absorb', path.join(theirs.dir, 'events.jsonl')]);
  assert.match(out, /absorbed 1 intent/);
  assert.match(out, /remapped 1 intent id/);
  const events = ours.events();
  assert.equal(events.filter((event) => event.type === 'begin').length, 2);
  assert.equal(events[0].id, oursId);
  assert.equal(events[2].id, oursId.replace(/001$/, '002'));
  assert.equal(events[2].intent, 'theirs work');
  assert.equal(ours.run(['begin', 'after absorb']).trim(), oursId.replace(/001$/, '003'));
});

test('absorb keeps a shared prefix and remaps only the incoming tip', () => {
  const ours = setup();
  ours.run(['begin', 'shared']);
  ours.run(['end', '--status', 'completed', '--note', 'shared', '--verify-result', 'ok']);
  const theirs = setup();
  fs.copyFileSync(path.join(ours.dir, 'events.jsonl'), path.join(theirs.dir, 'events.jsonl'));

  ours.run(['begin', 'ours tip']);
  ours.run(['end', '--status', 'completed', '--note', 'ours', '--verify-result', 'ok']);
  theirs.run(['begin', 'theirs tip']);
  theirs.run(['end', '--status', 'completed', '--note', 'theirs', '--verify-result', 'ok']);

  ours.run(['absorb', path.join(theirs.dir, 'events.jsonl')]);
  const begins = ours.events().filter((event) => event.type === 'begin');
  assert.equal(begins.length, 3);
  assert.equal(begins[0].intent, 'shared');
  assert.equal(begins[1].intent, 'ours tip');
  assert.equal(begins[2].intent, 'theirs tip');
  assert.match(begins[2].id, /-003$/);
});

test('absorb refuses two in_progress intents unless an abandon flag is given', () => {
  const ours = setup();
  const theirs = setup();
  const oursId = ours.run(['begin', 'ours open']).trim();
  theirs.run(['begin', 'theirs open']);
  assert.match(
    ours.runFail(['absorb', path.join(theirs.dir, 'events.jsonl')]).stderr,
    /multiple intents in progress/
  );
  assert.equal(ours.events().length, 1);

  const out = ours.run(['absorb', path.join(theirs.dir, 'events.jsonl'), '--abandon-theirs']);
  assert.match(out, /abandoned /);
  const events = ours.events();
  assert.equal(events[0].id, oursId);
  assert.equal(events.at(-1).type, 'end');
  assert.equal(events.at(-1).status, 'abandoned');
  assert.match(ours.run(['status']), /ours open/);
});

test('absorb remaps colliding decision ids and their event references', () => {
  const ours = setup();
  const theirs = setup();
  ours.run(['decision', 'add', 'Ours choice', '-c', 'context', '-o', 'outcome']);
  theirs.run(['decision', 'add', 'Theirs choice', '-c', 'context', '-o', 'outcome']);
  ours.run(['begin', 'use ours', '--decision', '1']);
  ours.run(['decision', 'update', '1', '--note', 'Confirmed ours.']);
  ours.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  theirs.run(['begin', 'use theirs', '--decision', '1']);
  theirs.run(['decision', 'update', '1', '--note', 'Confirmed theirs.']);
  theirs.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);

  const out = ours.run([
    'absorb',
    path.join(theirs.dir, 'events.jsonl'),
    '--decisions',
    path.join(theirs.dir, 'decisions'),
  ]);
  assert.match(out, /decision 0001 \(theirs\) -> 0002/);
  const begins = ours.events().filter((event) => event.type === 'begin');
  assert.deepEqual(begins[0].decisions, ['0001']);
  assert.deepEqual(begins[1].decisions, ['0002']);
  assert.match(ours.run(['decision', 'list']), /0001/);
  assert.match(ours.run(['decision', 'list']), /0002/);
  assert.match(ours.run(['decision', 'show', '2']), /Theirs choice/);
});

test('absorb remapping of a colliding decision keeps a still-open incoming intent closable', () => {
  const ours = setup();
  const theirs = setup();
  ours.run(['decision', 'add', 'Ours choice', '-c', 'context', '-o', 'outcome']);
  theirs.run(['decision', 'add', 'Theirs choice', '-c', 'context', '-o', 'outcome']);
  ours.run(['begin', 'use ours', '--decision', '1']);
  ours.run(['decision', 'update', '1', '--note', 'Confirmed ours.']);
  ours.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  theirs.run(['begin', 'use theirs', '--decision', '1']);
  theirs.run(['decision', 'update', '1', '--note', 'Confirmed theirs.']);

  const out = ours.run([
    'absorb',
    path.join(theirs.dir, 'events.jsonl'),
    '--decisions',
    path.join(theirs.dir, 'decisions'),
  ]);
  assert.match(out, /decision 0001 \(theirs\) -> 0002/);
  assert.match(ours.run(['status']), /use theirs/);

  const closed = ours.run([
    'end',
    '--status',
    'completed',
    '--note',
    'done',
    '--verify-result',
    'ok',
  ]);
  assert.match(closed, /completed/);
  assert.equal(ours.events().at(-1).type, 'end');
  assert.equal(ours.events().at(-1).status, 'completed');
});

test('absorb remapping recovers a pending incoming reconciliation after a colliding rewrite', () => {
  const ours = setup();
  const theirs = setup();
  ours.run(['decision', 'add', 'Ours choice', '-c', 'context', '-o', 'outcome']);
  theirs.run(['decision', 'add', 'Theirs choice', '-c', 'context', '-o', 'outcome']);
  ours.run(['begin', 'use ours', '--decision', '1']);
  ours.run(['decision', 'update', '1', '--note', 'Confirmed ours.']);
  ours.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  theirs.run(['begin', 'use theirs', '--decision', '1']);
  const interrupted = theirs.runFail(
    ['decision', 'update', '1', '--note', 'Confirmed theirs.'],
    {
      env: {
        ...process.env,
        DRIFTSEAL_HOME: theirs.dir,
        DRIFTSEAL_DECISION_HOME: path.join(theirs.dir, 'decisions'),
        _DRIFTSEAL_TEST_CRASH_AFTER_DECISION_WRITE: '1',
      },
    }
  );
  assert.match(interrupted.stderr, /simulated interruption/);
  assert.equal(theirs.events().at(-1).type, 'decision_reconcile_prepare');

  const out = ours.run([
    'absorb',
    path.join(theirs.dir, 'events.jsonl'),
    '--decisions',
    path.join(theirs.dir, 'decisions'),
  ]);
  assert.match(out, /decision 0001 \(theirs\) -> 0002/);
  assert.match(
    ours.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']),
    /completed/
  );
  const remapped = ours.events().filter((event) => event.decisionId === '0002');
  assert.ok(remapped.some((event) => event.type === 'decision_reconcile_prepare'));
  assert.ok(remapped.some((event) => event.type === 'decision_reconcile_commit'));
});

test('absorb rejects concurrent edits of a shared decision', () => {
  const ours = setup();
  ours.run(['decision', 'add', 'Shared choice', '-c', 'context', '-o', 'outcome']);
  ours.run(['begin', 'link shared', '--decision', '1']);
  ours.run(['decision', 'update', '1', '--note', 'Linked.']);
  ours.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  const theirs = setup();
  fs.copyFileSync(path.join(ours.dir, 'events.jsonl'), path.join(theirs.dir, 'events.jsonl'));
  fs.cpSync(path.join(ours.dir, 'decisions'), path.join(theirs.dir, 'decisions'), { recursive: true });

  ours.run(['begin', 'edit ours', '--decision', '1']);
  ours.run(['decision', 'update', '1', '--status', 'deprecated', '--note', 'Ours edit.']);
  ours.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  theirs.run(['begin', 'edit theirs', '--decision', '1']);
  theirs.run(['decision', 'update', '1', '--status', 'superseded', '--note', 'Theirs edit.']);
  theirs.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);

  assert.match(
    ours.runFail([
      'absorb',
      path.join(theirs.dir, 'events.jsonl'),
      '--decisions',
      path.join(theirs.dir, 'decisions'),
    ]).stderr,
    /decision 0001 was edited on both sides/
  );
});

test('absorb repairs conflict markers and concatenated duplicate ids', () => {
  const { dir, run, events } = setup();
  run(['begin', 'ours side']);
  run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  const oursLog = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8');
  const theirs = setup();
  theirs.run(['begin', 'theirs side']);
  theirs.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  const theirsLog = fs.readFileSync(path.join(theirs.dir, 'events.jsonl'), 'utf8');

  fs.writeFileSync(
    path.join(dir, 'events.jsonl'),
    `<<<<<<< HEAD\n${oursLog}=======\n${theirsLog}>>>>>>> feature\n`
  );
  const repaired = run(['absorb']);
  assert.match(repaired, /remapped 1 intent id/);
  assert.equal(events().filter((event) => event.type === 'begin').length, 2);
  assert.equal(events()[2].intent, 'theirs side');

  const duplicate = setup();
  duplicate.run(['begin', 'first']);
  duplicate.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  const first = fs.readFileSync(path.join(duplicate.dir, 'events.jsonl'), 'utf8');
  const extra = setup();
  extra.run(['begin', 'second']);
  extra.run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  fs.writeFileSync(
    path.join(duplicate.dir, 'events.jsonl'),
    first + fs.readFileSync(path.join(extra.dir, 'events.jsonl'), 'utf8')
  );
  assert.match(duplicate.run(['absorb']), /remapped 1 intent id/);
  assert.equal(duplicate.events().filter((event) => event.type === 'begin').map((event) => event.intent).join(','), 'first,second');
});

test('absorb --git performs a 3-way merge and init installs the driver', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-git-absorb-'));
  const env = { ...process.env };
  delete env.DRIFTSEAL_HOME;
  delete env.DRIFTSEAL_DECISION_HOME;
  const git = (args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      env: { ...env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const runIn = (args) =>
    execFileSync(process.execPath, [DRIFTSEAL, ...args], {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  assert.match(runIn(['help']), /driftseal absorb/);
  runIn(['init']);
  assert.match(fs.readFileSync(path.join(cwd, '.gitattributes'), 'utf8'), /merge=driftseal/);
  assert.equal(git(['config', '--local', '--get', 'merge.driftseal.driver']).trim(), 'driftseal absorb --git %O %A %B');
  git([
    'config',
    '--local',
    'merge.driftseal.driver',
    `${process.execPath} ${DRIFTSEAL} absorb --git %O %A %B`,
  ]);

  runIn(['begin', 'shared']);
  runIn(['end', '--status', 'completed', '--note', 'shared', '--verify-result', 'ok']);
  git(['add', '.intent-log/events.jsonl', '.gitattributes', 'AGENTS.md']);
  git(['commit', '-m', 'base']);

  git(['checkout', '-b', 'feature']);
  runIn(['begin', 'feature work']);
  runIn(['end', '--status', 'completed', '--note', 'feature', '--verify-result', 'ok']);
  git(['add', '.intent-log/events.jsonl']);
  git(['commit', '-m', 'feature']);

  git(['checkout', 'main']);
  runIn(['begin', 'main work']);
  runIn(['end', '--status', 'completed', '--note', 'main', '--verify-result', 'ok']);
  git(['add', '.intent-log/events.jsonl']);
  git(['commit', '-m', 'main']);

  git(['merge', 'feature', '--no-edit']);
  const merged = fs
    .readFileSync(path.join(cwd, '.intent-log', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const begins = merged.filter((event) => event.type === 'begin');
  assert.equal(begins.length, 3);
  assert.equal(begins[1].intent, 'main work');
  assert.equal(begins[2].intent, 'feature work');
  assert.match(begins[2].id, /-003$/);
  assert.equal(runIn(['log', '--last', '1']).includes('feature work'), true);
});

test('begin parks an open intent so git merge does not need a log-only commit', () => {
  const { cwd, git, run } = setupGitRepository('driftseal-git-park-begin-');
  git(['add', '.gitattributes', 'AGENTS.md']);
  git(['commit', '-m', 'base protocol']);

  run(['begin', 'shared']);
  run(['end', '--status', 'completed', '--note', 'shared', '--verify-result', 'ok']);
  git(['add', '.intent-log/events.jsonl']);
  git(['commit', '-m', 'shared']);

  git(['checkout', '-b', 'feature']);
  run(['begin', 'feature work']);
  run(['end', '--status', 'completed', '--note', 'feature', '--verify-result', 'ok']);
  git(['add', '.intent-log/events.jsonl']);
  git(['commit', '-m', 'feature']);

  git(['checkout', 'main']);
  const before = fs.readFileSync(path.join(cwd, '.intent-log', 'events.jsonl'), 'utf8');
  const opened = run(['begin', 'merge the feature']).trim();
  assert.match(opened, /-002$/);
  assert.equal(fs.readFileSync(path.join(cwd, '.intent-log', 'events.jsonl'), 'utf8'), before);
  assert.equal(git(['status', '--porcelain']), '');
  assert.match(run(['status']), /merge the feature/);
  assert.match(run(['status']), /in_progress/);

  git(['merge', 'feature', '--no-edit']);
  const mergedLog = fs
    .readFileSync(path.join(cwd, '.intent-log', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(
    mergedLog.some((event) => event.type === 'begin' && event.intent === 'merge the feature'),
    false
  );
  const status = run(['status']);
  assert.match(status, /merge the feature/);
  assert.match(status, /in_progress/);
  assert.match(status, /-003/);
  assert.equal(git(['status', '--porcelain']), '');

  run(['end', '--status', 'completed', '--note', 'merged', '--verify-result', 'ok']);
  const closed = fs
    .readFileSync(path.join(cwd, '.intent-log', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const begins = closed.filter((event) => event.type === 'begin');
  assert.equal(begins.map((event) => event.intent).join(','), 'shared,feature work,merge the feature');
  assert.match(begins[2].id, /-003$/);
  assert.match(git(['status', '--porcelain']), /\.intent-log\/events\.jsonl/);
});

test('a different committed open intent with the same id does not discard the parked intent', () => {
  const { cwd, env, git, run } = setupGitRepository('driftseal-git-park-same-id-');
  git(['add', '.gitattributes', 'AGENTS.md']);
  git(['commit', '-m', 'base protocol']);

  git(['checkout', '-b', 'incoming']);
  run(['begin', 'incoming open intent'], {
    env: { ...env, DRIFTSEAL_HOME: path.join(cwd, '.intent-log') },
  });
  git(['add', '.intent-log/events.jsonl']);
  git(['commit', '-m', 'legacy incoming open intent']);

  git(['checkout', 'main']);
  assert.match(run(['begin', 'local parked intent']).trim(), /-001$/);
  git(['merge', 'incoming', '--no-ff', '--no-edit']);

  assert.throws(() => run(['status']), (err) => {
    assert.match(String(err.stderr), /multiple intents in progress/);
    return true;
  });

  const park = path.resolve(
    cwd,
    git(['rev-parse', '--git-path', 'driftseal-in-progress.jsonl']).trim()
  );
  const parked = fs
    .readFileSync(park, 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(parked.length, 1);
  assert.equal(parked[0].intent, 'local parked intent');
  assert.match(parked[0].id, /-002$/);
});

test('an interrupted end leaves the intent open in the tracked log and can be retried', () => {
  const { cwd, env, git, run, park, log } = setupParkedRepository('driftseal-git-park-end-crash-');
  const id = run(['begin', 'parked work']).trim();
  assert.equal(fs.existsSync(park), true);

  assert.throws(
    () =>
      run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok'], {
        env: { ...env, _DRIFTSEAL_TEST_CRASH_AFTER_IN_PROGRESS_FLUSH: '1' },
      }),
    (err) => {
      assert.match(String(err.stderr), /simulated interruption after the in-progress flush/);
      return true;
    }
  );

  // The close never lands in Git metadata, so the retry still has an open intent to close.
  assert.equal(fs.existsSync(park), false);
  assert.deepEqual(log().map((event) => event.type), ['begin']);
  assert.match(run(['status']), /in_progress/);

  run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  const closed = log();
  assert.deepEqual(closed.map((event) => event.type), ['begin', 'end']);
  assert.equal(closed[1].id, id);
  assert.equal(closed[1].status, 'completed');
  assert.match(run(['status']), /no intent in progress/);
  assert.equal(fs.existsSync(park), false);
});

test('a park left holding a closed intent is flushed by the next write', () => {
  const { cwd, git, run, park, log, parkedRecords } = setupParkedRepository('driftseal-git-park-stale-close-');
  const id = run(['begin', 'interrupted work']).trim();
  fs.appendFileSync(
    park,
    JSON.stringify({
      schemaVersion: 3,
      type: 'end',
      id,
      ts: new Date().toISOString(),
      status: 'completed',
      note: 'done',
      verifyResult: 'ok',
    }) + '\n'
  );
  assert.match(run(['status']), /no intent in progress/);
  assert.equal(fs.existsSync(path.join(cwd, '.intent-log', 'events.jsonl')), false);

  const next = run(['begin', 'next work']).trim();
  const flushed = log();
  assert.deepEqual(flushed.map((event) => event.type), ['begin', 'end']);
  assert.equal(flushed[0].intent, 'interrupted work');
  assert.equal(flushed[1].id, id);
  assert.deepEqual(parkedRecords().map((event) => event.intent), ['next work']);
  assert.notEqual(next, id);
});

test('absorb flushes a park that no longer holds an open intent', () => {
  const { run, park, log } = setupParkedRepository('driftseal-git-park-absorb-stale-');
  const id = run(['begin', 'interrupted work']).trim();
  fs.appendFileSync(
    park,
    JSON.stringify({
      schemaVersion: 3,
      type: 'end',
      id,
      ts: new Date().toISOString(),
      status: 'completed',
      note: 'done',
      verifyResult: 'ok',
    }) + '\n'
  );

  run(['absorb']);
  assert.equal(fs.existsSync(park), false);
  const flushed = log();
  assert.deepEqual(flushed.map((event) => event.type), ['begin', 'end']);
  assert.equal(flushed[0].intent, 'interrupted work');
  assert.equal(flushed[1].id, id);
});

test('a parked overlay already merged into the log is dropped instead of re-added', () => {
  const { cwd, git, run, park, log } = setupParkedRepository('driftseal-git-park-flushed-overlay-');
  const id = run(['begin', 'parked work']).trim();
  const parkedLine = fs.readFileSync(park, 'utf8');
  const other = `${id.slice(0, -3)}009`;
  const ts = new Date().toISOString();
  // A flush that wrote the log but could not unlink the park, then a merge appending after it.
  fs.mkdirSync(path.join(cwd, '.intent-log'), { recursive: true });
  fs.writeFileSync(
    path.join(cwd, '.intent-log', 'events.jsonl'),
    parkedLine +
      JSON.stringify({ schemaVersion: 3, type: 'begin', id: other, ts, intent: 'merged in' }) + '\n' +
      JSON.stringify({ schemaVersion: 3, type: 'end', id: other, ts, status: 'completed' }) + '\n'
  );

  const status = run(['status']);
  assert.match(status, /parked work/);
  assert.match(status, new RegExp(id));
  assert.equal(fs.existsSync(park), false);
  assert.deepEqual(
    log().filter((event) => event.type === 'begin').map((event) => event.intent),
    ['parked work', 'merged in']
  );
});

test('a linked decision reconciliation stays parked until end', () => {
  const { cwd, git, run, park, log, parkedRecords } = setupParkedRepository('driftseal-git-park-decision-');
  run(['decision', 'add', 'Parked choice', '-c', 'context', '-o', 'outcome']);
  git(['add', '.decision-log']);
  git(['commit', '-m', 'decision']);

  run(['begin', 'linked work', '--decision', '1']);
  run(['decision', 'update', '1', '--note', 'Confirm parked choice.']);
  assert.deepEqual(parkedRecords().map((event) => event.type), [
    'begin',
    'decision_reconcile_prepare',
    'decision_reconcile_commit',
  ]);
  assert.equal(fs.existsSync(path.join(cwd, '.intent-log', 'events.jsonl')), false);
  assert.equal(git(['status', '--porcelain']).includes('.intent-log/'), false);

  run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  assert.equal(fs.existsSync(park), false);
  assert.deepEqual(log().map((event) => event.type), [
    'begin',
    'decision_reconcile_prepare',
    'decision_reconcile_commit',
    'end',
  ]);
});

test('hook reminders see an intent that only exists in Git metadata', () => {
  const { cwd, run } = setupParkedRepository('driftseal-git-park-hook-');
  const id = run(['begin', 'parked work']).trim();
  assert.equal(fs.existsSync(path.join(cwd, '.intent-log', 'events.jsonl')), false);
  assert.match(run(['hook', 'stop']), new RegExp(`intent ${id} is still in_progress`));
  assert.match(run(['hook', 'prompt']), /begin an intent first/);
});

test('absorb --abandon-theirs closes the merged-in intent and leaves ours parked', () => {
  const { run, park, log, parkedRecords } = setupParkedMergeConflict('driftseal-git-park-absorb-theirs-');
  assert.throws(() => run(['status']), (err) => {
    assert.match(String(err.stderr), /multiple intents in progress/);
    return true;
  });
  assert.throws(() => run(['absorb']), (err) => {
    assert.match(String(err.stderr), /re-run with --abandon-theirs or --abandon-ours/);
    return true;
  });
  assert.deepEqual(log().map((event) => event.type), ['begin']);

  assert.match(run(['absorb', '--abandon-theirs']), /abandoned .+ during absorb/);
  const absorbed = log();
  assert.deepEqual(absorbed.map((event) => event.type), ['begin', 'end']);
  assert.equal(absorbed[0].intent, 'incoming open intent');
  assert.equal(absorbed[1].status, 'abandoned');
  assert.deepEqual(parkedRecords().map((event) => event.intent), ['local parked intent']);

  const status = run(['status']);
  assert.match(status, /local parked intent/);
  assert.match(status, /in_progress/);

  run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  assert.equal(fs.existsSync(park), false);
  const closed = log();
  assert.deepEqual(closed.map((event) => event.type), ['begin', 'end', 'begin', 'end']);
  assert.equal(closed[2].intent, 'local parked intent');
  assert.equal(closed[3].status, 'completed');
});

test('absorb --abandon-ours closes the parked intent into the tracked log', () => {
  const { run, park, log } = setupParkedMergeConflict('driftseal-git-park-absorb-ours-');
  assert.match(run(['absorb', '--abandon-ours']), /abandoned .+ during absorb/);
  assert.equal(fs.existsSync(park), false);
  const absorbed = log();
  assert.deepEqual(absorbed.map((event) => event.type), ['begin', 'begin', 'end']);
  assert.equal(absorbed[1].intent, 'local parked intent');
  assert.equal(absorbed[2].id, absorbed[1].id);
  assert.equal(absorbed[2].status, 'abandoned');

  const status = run(['status']);
  assert.match(status, /incoming open intent/);
  assert.match(status, /in_progress/);
});

test('end by id closes a merged-in intent without disturbing the parked one', () => {
  const { run, park, log, parkedRecords } = setupParkedMergeConflict('driftseal-git-park-end-by-id-');
  const incoming = log()[0].id;
  assert.throws(() => run(['end', '--status', 'completed', '--note', 'x', '--verify-result', 'ok']), (err) => {
    assert.match(String(err.stderr), /multiple intents in progress/);
    return true;
  });

  run(['end', incoming, '--status', 'partial', '--note', 'closing incoming', '--verify-result', 'ok']);
  const closed = log();
  assert.deepEqual(closed.map((event) => event.type), ['begin', 'end']);
  assert.equal(closed[1].id, incoming);
  assert.deepEqual(parkedRecords().map((event) => event.intent), ['local parked intent']);
  assert.match(run(['status']), /local parked intent/);

  run(['end', '--status', 'completed', '--note', 'done', '--verify-result', 'ok']);
  assert.equal(fs.existsSync(park), false);
  assert.deepEqual(log().map((event) => event.type), ['begin', 'end', 'begin', 'end']);
});

test('begin --force abandons a parked intent and a merged-in one together', () => {
  const { run, park, log, parkedRecords } = setupParkedMergeConflict('driftseal-git-park-force-');
  assert.throws(() => run(['begin', 'next work']), (err) => {
    assert.match(String(err.stderr), /multiple intents in progress/);
    assert.match(String(err.stderr), /--force to abandon all of them/);
    return true;
  });

  const next = run(['begin', 'next work', '--force']).trim();
  const forced = log();
  assert.deepEqual(forced.map((event) => event.type), ['begin', 'end', 'begin', 'end']);
  assert.equal(forced.filter((event) => event.type === 'end').every((event) => event.status === 'abandoned'), true);
  assert.deepEqual(parkedRecords().map((event) => event.intent), ['next work']);
  assert.match(run(['status']), /next work/);
  assert.equal(next, parkedRecords()[0].id);
});

test('git merge stops on colliding decision ids and absorb preserves each side ownership', () => {
  const { cwd, git, gitFail, run } = setupGitRepository('driftseal-git-decision-collision-');
  git(['add', '.gitattributes', 'AGENTS.md']);
  git(['commit', '-m', 'base']);

  git(['checkout', '-b', 'feature']);
  run(['decision', 'add', 'Feature choice', '-c', 'context', '-o', 'outcome']);
  run(['begin', 'feature work', '--decision', '1']);
  run(['decision', 'update', '1', '--note', 'Confirm feature choice.']);
  run(['end', '--status', 'completed', '--note', 'feature', '--verify-result', 'ok']);
  git(['add', '.']);
  git(['commit', '-m', 'feature']);

  git(['checkout', 'main']);
  run(['decision', 'add', 'Main choice', '-c', 'context', '-o', 'outcome']);
  run(['begin', 'main work', '--decision', '1']);
  run(['decision', 'update', '1', '--note', 'Confirm main choice.']);
  run(['end', '--status', 'completed', '--note', 'main', '--verify-result', 'ok']);
  git(['add', '.']);
  git(['commit', '-m', 'main']);

  const mergeError = gitFail(['merge', 'feature', '--no-edit']);
  assert.match(
    `${mergeError.stdout || ''}${mergeError.stderr || ''}`,
    /decision ids require worktree repair/
  );
  assert.match(git(['rev-parse', '--verify', 'MERGE_HEAD']), /^[a-f0-9]{40}\n$/);

  const repaired = run(['absorb']);
  assert.match(repaired, /decision 0001 \(theirs\) -> 0002/);
  git(['add', '-A']);
  git(['commit', '--no-edit']);

  const decisions = run(['decision', 'list']);
  assert.match(decisions, /0001.*Main choice/);
  assert.match(decisions, /0002.*Feature choice/);
  const events = fs
    .readFileSync(path.join(cwd, '.intent-log', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const begins = events.filter((event) => event.type === 'begin');
  assert.deepEqual(begins.find((event) => event.intent === 'main work').decisions, ['0001']);
  assert.deepEqual(begins.find((event) => event.intent === 'feature work').decisions, ['0002']);
});

test('absorb accepts an incoming-only edit to a decision from the shared Git base', () => {
  const { cwd, env, git, run } = setupGitRepository('driftseal-git-one-sided-decision-');
  run(['decision', 'add', 'Shared choice', '-c', 'context', '-o', 'outcome']);
  run(['begin', 'record shared choice', '--decision', '1']);
  run(['decision', 'update', '1', '--note', 'Confirm shared choice.']);
  run(['end', '--status', 'completed', '--note', 'base', '--verify-result', 'ok']);
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  git(['branch', 'feature']);

  const featureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'driftseal-feature-worktree-'));
  fs.rmdirSync(featureRoot);
  git(['worktree', 'add', featureRoot, 'feature']);
  const runFeature = (args) =>
    execFileSync(process.execPath, [DRIFTSEAL, ...args], {
      cwd: featureRoot,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const gitFeature = (args) =>
    execFileSync('git', args, {
      cwd: featureRoot,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

  run(['begin', 'main unrelated work']);
  run(['end', '--status', 'completed', '--note', 'main', '--verify-result', 'ok']);
  git(['add', '.intent-log/events.jsonl']);
  git(['commit', '-m', 'main']);

  runFeature(['begin', 'deprecate shared choice', '--decision', '1']);
  runFeature(['decision', 'update', '1', '--status', 'deprecated', '--note', 'Feature edit.']);
  runFeature(['end', '--status', 'completed', '--note', 'feature', '--verify-result', 'ok']);
  gitFeature(['add', '.']);
  gitFeature(['commit', '-m', 'feature']);

  const output = run([
    'absorb',
    path.join(featureRoot, '.intent-log', 'events.jsonl'),
    '--decisions',
    path.join(featureRoot, '.decision-log'),
  ]);
  assert.match(output, /absorbed 1 intent/);
  assert.doesNotMatch(output, /decision 0001 \(theirs\) ->/);
  assert.match(run(['decision', 'show', '1']), /## Status\n\nDeprecated/);
  assert.equal(fs.existsSync(path.join(cwd, '.decision-log', '0001-shared-choice.md')), true);
});

test('no-arg absorb uses merge parents to repair a previously successful corrupt merge', () => {
  const { cwd, git, run } = setupGitRepository('driftseal-git-repair-merge-');
  git(['add', '.gitattributes', 'AGENTS.md']);
  git(['commit', '-m', 'base']);

  git(['checkout', '-b', 'feature']);
  run(['decision', 'add', 'Feature choice', '-c', 'context', '-o', 'outcome']);
  run(['begin', 'feature work', '--decision', '1']);
  run(['decision', 'update', '1', '--note', 'Confirm feature choice.']);
  run(['end', '--status', 'completed', '--note', 'feature', '--verify-result', 'ok']);
  git(['add', '.']);
  git(['commit', '-m', 'feature']);

  git(['checkout', 'main']);
  run(['decision', 'add', 'Main choice', '-c', 'context', '-o', 'outcome']);
  run(['begin', 'main work', '--decision', '1']);
  run(['decision', 'update', '1', '--note', 'Confirm main choice.']);
  run(['end', '--status', 'completed', '--note', 'main', '--verify-result', 'ok']);
  git(['add', '.']);
  git(['commit', '-m', 'main']);
  git(['merge', 'feature', '--strategy', 'ours', '--no-edit']);

  const oursText = git(['show', 'HEAD^1:.intent-log/events.jsonl']);
  const theirsEvents = git(['show', 'HEAD^2:.intent-log/events.jsonl'])
    .trim()
    .split('\n')
    .map(JSON.parse);
  const collidedId = theirsEvents.find((event) => event.type === 'begin').id;
  const remappedId = collidedId.replace(/001$/, '002');
  const remappedTheirs = theirsEvents.map((event) =>
    event.id === collidedId ? { ...event, id: remappedId } : event
  );
  fs.writeFileSync(
    path.join(cwd, '.intent-log', 'events.jsonl'),
    `${oursText}${remappedTheirs.map(JSON.stringify).join('\n')}\n`
  );
  const featureDecision = git(['ls-tree', '-r', '--name-only', 'HEAD^2', '.decision-log']).trim();
  fs.writeFileSync(
    path.join(cwd, featureDecision),
    git(['show', `HEAD^2:${featureDecision}`])
  );

  const repaired = run(['absorb']);
  assert.match(repaired, /decision 0001 \(theirs\) -> 0002/);
  const events = fs
    .readFileSync(path.join(cwd, '.intent-log', 'events.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  const begins = events.filter((event) => event.type === 'begin');
  assert.deepEqual(begins.find((event) => event.intent === 'main work').decisions, ['0001']);
  assert.deepEqual(begins.find((event) => event.intent === 'feature work').decisions, ['0002']);
  assert.match(run(['decision', 'list']), /0001.*Main choice/);
  assert.match(run(['decision', 'list']), /0002.*Feature choice/);
});

test('absorb rejects incompatible flags', () => {
  const { runFail } = setup();
  assert.match(
    runFail(['absorb', '--abandon-theirs', '--abandon-ours']).stderr,
    /cannot combine --abandon-theirs and --abandon-ours/
  );
  assert.match(runFail(['absorb', '--git', 'a']).stderr, /usage: driftseal absorb/);
});
