// store.ts — the forge's whole in-memory state: repositories, git objects and refs,
// issues, comments, labels and pull requests. Everything is deterministic: no wall
// clock, no Math.random — timestamps come from a fixed epoch plus a sequence counter,
// so a live run and its replay build byte-identical state.

import {
  buildCommit,
  buildTree,
  collectReachable,
  flattenTree,
  hashObject,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitkit.ts';

/** The login the trial's bearer token names (the scenario's viewer, fixed by its seed). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const VIEWER_ID = 1000;

/** One fixed timestamp for every REST/GraphQL created_at; ordering uses sequence numbers. */
export const FIXED_TIME = '2026-11-14T06:30:00Z';
/** Base epoch for commit objects this forge writes (contents API, merges). */
const COMMIT_EPOCH = 1_700_000_000;

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeBaseSha: string;
  files: PullFile[];
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  seq: number;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssueNumber: number;
  nextIssueId: number;
  nextCommentId: number;
  pulls: Pull[];
  nextPullNumber: number;
  nextPullId: number;
  /** ref name -> tip oid (refs/heads/*, refs/tags/*). */
  refs: Map<string, string>;
  /** oid -> object. */
  objects: Map<string, GitObject>;
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextGlobalId = 1;
  seq = 0;
  /** Sequence for commit timestamps, so REST-made commits hash deterministically. */
  commitSeq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, options: { description?: string; private?: boolean }): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      description: options.description ?? '',
      private: options.private ?? false,
      defaultBranch: 'main',
      seq: this.nextSeq(),
      labels: new Map(),
      issues: [],
      nextIssueNumber: 1,
      nextIssueId: 1,
      nextCommentId: 1,
      pulls: [],
      nextPullNumber: 1,
      nextPullId: 1,
      refs: new Map(),
      objects: new Map(),
    };
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  listRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }

  // -----------------------------------------------------------------------------------------
  // git object store
  // -----------------------------------------------------------------------------------------

  lookup(repo: Repo): (oid: string) => GitObject | undefined {
    return (oid: string) => repo.objects.get(oid);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** The tip of a ref, resolving a short branch name or a full ref or a raw oid. */
  resolveRef(repo: Repo, ref: string | undefined): string | null {
    if (ref === undefined || ref === '') {
      return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
    }
    if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
    if (repo.refs.has(ref)) return repo.refs.get(ref)!;
    const headed = `refs/heads/${ref}`;
    if (repo.refs.has(headed)) return repo.refs.get(headed)!;
    const tagged = `refs/tags/${ref}`;
    if (repo.refs.has(tagged)) return repo.refs.get(tagged)!;
    return null;
  }

  /** The tree oid at a ref, or null. */
  treeAt(repo: Repo, ref: string | undefined): string | null {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return null;
    const object = repo.objects.get(tip);
    if (!object) return null;
    if (object.type === 'tree') return tip;
    if (object.type === 'commit') return parseCommit(object.data).tree;
    if (object.type === 'tag') {
      const targetOid = parseTag(object.data).object;
      const target = repo.objects.get(targetOid);
      if (target && target.type === 'commit') return parseCommit(target.data).tree;
      if (target && target.type === 'tree') return targetOid;
    }
    return null;
  }

  /** Build a new tree from an old one with one path set (or removed when data is null). */
  setPathInTree(repo: Repo, baseTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((segment) => segment !== '');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = new Map<string, TreeEntry>();
      if (treeOid !== null) {
        const object = repo.objects.get(treeOid);
        if (object && object.type === 'tree') {
          for (const entry of parseTree(object.data)) entries.set(entry.name, entry);
        }
      }
      const segment = segments[depth];
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(segment);
        else entries.set(segment, { mode: '100644', name: segment, oid: blobOid });
      } else {
        const child = entries.get(segment);
        const childTree = build(child && child.mode === '40000' ? child.oid : null, depth + 1);
        const childObject = repo.objects.get(childTree);
        const empty = childObject !== undefined && parseTree(childObject.data).length === 0;
        if (empty) entries.delete(segment);
        else entries.set(segment, { mode: '40000', name: segment, oid: childTree });
      }
      const data = buildTree([...entries.values()]);
      return this.putObject(repo, 'tree', data);
    };
    return build(baseTreeOid, 0);
  }

  /** Create a commit on a branch from a tree, with the branch tip as parent. Returns the commit oid. */
  commitTree(repo: Repo, branch: string, treeOid: string, message: string): string {
    const parent = repo.refs.get(`refs/heads/${branch}`);
    const parents = parent !== undefined && parent !== ZERO_OID ? [parent] : [];
    this.commitSeq += 1;
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({
      tree: treeOid,
      parents,
      message,
      author: who,
      committer: who,
      timestamp: COMMIT_EPOCH + this.commitSeq,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  /** The commit history of a ref, newest first. */
  history(repo: Repo, ref: string | undefined, limit = 100): string[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      out.push(oid);
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return out;
  }

  /** The blob oid at `path` in the tree of a ref, or null. */
  blobAtPath(repo: Repo, ref: string | undefined, path: string): { oid: string; data: Buffer } | null {
    const treeOid = this.treeAt(repo, ref);
    if (treeOid === null) return null;
    const flat = flattenTree(treeOid, this.lookup(repo));
    const entry = flat.get(path);
    if (!entry) return null;
    const object = repo.objects.get(entry.oid);
    if (!object || object.type !== 'blob') return null;
    return { oid: entry.oid, data: object.data };
  }

  /** List the direct entries of a directory path in the tree of a ref. */
  dirEntries(repo: Repo, ref: string | undefined, dirPath: string): TreeEntry[] | null {
    const treeOid = this.treeAt(repo, ref);
    if (treeOid === null) return null;
    let current = treeOid;
    if (dirPath !== '') {
      for (const segment of dirPath.split('/').filter((s) => s !== '')) {
        const object = repo.objects.get(current);
        if (!object || object.type !== 'tree') return null;
        const entry = parseTree(object.data).find((candidate) => candidate.name === segment);
        if (!entry || entry.mode !== '40000') return null;
        current = entry.oid;
      }
    }
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    return parseTree(object.data);
  }

  // -----------------------------------------------------------------------------------------
  // issues, labels, comments
  // -----------------------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const issue: Issue = {
      id: this.nextGlobalId++,
      number: repo.nextIssueNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.nextSeq(),
    };
    repo.issues.push(issue);
    return issue;
  }

  listIssues(repo: Repo, state: string, sort: string, direction: string): Issue[] {
    let list = [...repo.issues];
    if (state === 'open') list = list.filter((issue) => issue.state === 'open');
    else if (state === 'closed') list = list.filter((issue) => issue.state === 'closed');
    const ascending = direction === 'asc';
    if (sort === 'created') {
      list.sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq));
    } else {
      list.sort((a, b) => (ascending ? a.seq - b.seq : b.seq - a.seq));
    }
    return list;
  }

  // -----------------------------------------------------------------------------------------
  // pull requests
  // -----------------------------------------------------------------------------------------

  /** The files changed between the merge-base of head/base and the head tip. */
  diffFiles(repo: Repo, baseTip: string, headTip: string): { files: PullFile[]; mergeBaseSha: string } {
    const base = mergeBase(headTip, baseTip, this.lookup(repo)) ?? baseTip;
    const baseTree = this.treeOfCommit(repo, base);
    const headTree = this.treeOfCommit(repo, headTip);
    const baseFlat = baseTree === null ? new Map() : flattenTree(baseTree, this.lookup(repo));
    const headFlat = headTree === null ? new Map() : flattenTree(headTree, this.lookup(repo));
    const files: PullFile[] = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseFlat.get(path);
      const after = headFlat.get(path);
      if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
      let additions = 0;
      let deletions = 0;
      if (before === undefined && after !== undefined) {
        additions = countLines(repo.objects.get(after.oid)?.data);
      } else if (after === undefined && before !== undefined) {
        deletions = countLines(repo.objects.get(before.oid)?.data);
      } else if (before !== undefined && after !== undefined) {
        const diff = lineDiff(repo.objects.get(before.oid)?.data, repo.objects.get(after.oid)?.data);
        additions = diff.additions;
        deletions = diff.deletions;
      }
      files.push({
        filename: path,
        status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return { files, mergeBaseSha: base };
  }

  treeOfCommit(repo: Repo, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  /** The PR's files and merge-base against the base branch's *current* tip. */
  liveDiff(repo: Repo, pull: Pull): { files: PullFile[]; mergeBaseSha: string; baseSha: string; headSha: string } {
    const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
    const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
    const { files, mergeBaseSha } = this.diffFiles(repo, baseSha, headSha);
    return { files, mergeBaseSha, baseSha, headSha };
  }

  /** Whether the head's changes apply cleanly onto the base tip. */
  mergeable(repo: Repo, pull: Pull): boolean {
    const { files, mergeBaseSha, baseSha, headSha } = this.liveDiff(repo, pull);
    const baseTree = this.treeOfCommit(repo, baseSha);
    const headTree = this.treeOfCommit(repo, headSha);
    const mergeBaseTree = this.treeOfCommit(repo, mergeBaseSha);
    if (baseTree === null || headTree === null || mergeBaseTree === null) return false;
    const baseFlat = flattenTree(baseTree, this.lookup(repo));
    const mergeBaseFlat = flattenTree(mergeBaseTree, this.lookup(repo));
    // A file the head changed (against the merge-base) that the base also
    // changed (against the merge-base) is a conflict.
    for (const file of files) {
      const atBase = baseFlat.get(file.filename);
      const atMergeBase = mergeBaseFlat.get(file.filename);
      if (atBase?.oid !== atMergeBase?.oid) return false;
    }
    return true;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    if (!this.mergeable(repo, pull)) return null;
    const { files, baseSha, headSha } = this.liveDiff(repo, pull);
    const baseTree = this.treeOfCommit(repo, baseSha);
    const headTree = this.treeOfCommit(repo, headSha);
    if (baseTree === null || headTree === null) return null;
    const headFlat = flattenTree(headTree, this.lookup(repo));
    let tree = baseTree;
    for (const file of files) {
      const headEntry = headFlat.get(file.filename);
      tree = this.setPathInTree(repo, tree, file.filename, headEntry?.oid ?? null);
    }
    const message = `Merge pull request #${pull.number} from ${pull.headRef}\n\n${pull.title}\n`;
    this.commitSeq += 1;
    const who = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
    const data = buildCommit({
      tree,
      parents: [baseSha],
      message,
      author: who,
      committer: who,
      timestamp: COMMIT_EPOCH + this.commitSeq,
    });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.baseSha = baseSha;
    pull.headSha = headSha;
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = FIXED_TIME;
    pull.mergeCommitSha = oid;
    return oid;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): Pull | null {
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) return null;
    const { files, mergeBaseSha } = this.diffFiles(repo, baseSha, headSha);
    const pull: Pull = {
      id: this.nextGlobalId++,
      number: repo.nextPullNumber++,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeBaseSha,
      files,
      seq: this.nextSeq(),
    };
    repo.pulls.push(pull);
    return pull;
  }

  // -----------------------------------------------------------------------------------------
  // global ids (GraphQL Relay ids): opaque base64, stable across reads
  // -----------------------------------------------------------------------------------------

  globalId(kind: string, value: string): string {
    return Buffer.from(`${kind}:${value}`, 'utf8').toString('base64');
  }

  decodeGlobalId(id: string): { kind: string; value: string } | null {
    try {
      const text = Buffer.from(id, 'base64').toString('utf8');
      const colon = text.indexOf(':');
      if (colon < 0) return null;
      return { kind: text.slice(0, colon), value: text.slice(colon + 1) };
    } catch {
      return null;
    }
  }

  repoGlobalId(repo: Repo): string {
    return this.globalId('Repository', String(repo.id));
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return this.globalId('Issue', `${repo.id}:${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: Pull): string {
    return this.globalId('PullRequest', `${repo.id}:${pull.number}`);
  }

  commentGlobalId(comment: Comment): string {
    return this.globalId('IssueComment', String(comment.id));
  }

  findRepoByGlobalId(id: string): Repo | undefined {
    const decoded = this.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Repository') return undefined;
    const dbid = Number(decoded.value);
    if (!Number.isInteger(dbid)) return undefined;
    return [...this.repos.values()].find((repo) => repo.id === dbid);
  }

  findIssueByGlobalId(id: string): { repo: Repo; issue: Issue } | undefined {
    const decoded = this.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'Issue') return undefined;
    const [repoId, number] = decoded.value.split(':');
    const repo = [...this.repos.values()].find((candidate) => candidate.id === Number(repoId));
    if (!repo) return undefined;
    const issue = repo.issues.find((candidate) => candidate.number === Number(number));
    if (!issue) return undefined;
    return { repo, issue };
  }

  findPullByGlobalId(id: string): { repo: Repo; pull: Pull } | undefined {
    const decoded = this.decodeGlobalId(id);
    if (decoded === null || decoded.kind !== 'PullRequest') return undefined;
    const [repoId, number] = decoded.value.split(':');
    const repo = [...this.repos.values()].find((candidate) => candidate.id === Number(repoId));
    if (!repo) return undefined;
    const pull = repo.pulls.find((candidate) => candidate.number === Number(number));
    if (!pull) return undefined;
    return { repo, pull };
  }

  reachable(repo: Repo, roots: Iterable<string>): Set<string> {
    return collectReachable(roots, this.lookup(repo));
  }

  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    return isAncestor(ancestor, tip, this.lookup(repo));
  }
}

function countLines(data: Buffer | undefined): number {
  if (!data || data.length === 0) return 0;
  const text = data.toString('utf8');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/** A naive multiset line diff: lines only in new count as additions, only in old as deletions. */
function lineDiff(oldData: Buffer | undefined, newData: Buffer | undefined): { additions: number; deletions: number } {
  const oldLines = oldData ? oldData.toString('utf8').split('\n') : [];
  const newLines = newData ? newData.toString('utf8').split('\n') : [];
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const old = oldCounts.get(line) ?? 0;
    if (count > old) additions += count - old;
  }
  for (const [line, count] of oldCounts) {
    const next = newCounts.get(line) ?? 0;
    if (count > next) deletions += count - next;
  }
  return { additions, deletions };
}
