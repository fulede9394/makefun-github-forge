// rest.ts — the GitHub REST v3 surface under /api/v3: repositories, branches,
// commits, contents, labels, issues, comments and pull requests. Every reply is
// JSON with an X-GitHub-Request-Id (set by app.ts); errors are JSON {message}.

import type { ServerResponse } from 'node:http';
import { isOid, parseCommit } from './gitkit.ts';
import {
  FIXED_TIME,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  type Issue,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';

export interface RestContext {
  store: Store;
  query: URLSearchParams;
  body: unknown;
}

export type JsonRecord = Record<string, unknown>;

export function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8', ...extraHeaders };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  res.writeHead(status, headers);
  res.end(text);
}

function err(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function repoJson(repo: Repo): JsonRecord {
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function labelJson(label: { name: string; color: string; description: string }): JsonRecord {
  return { name: label.name, color: label.color, description: label.description };
}

function issueJson(repo: Repo, issue: Issue): JsonRecord {
  return {
    id: issue.id,
    node_id: `I_${repo.id}_${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return label ? labelJson(label) : { name, color: 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    comments: issue.comments.length,
  };
}

function pullJson(repo: Repo, pull: Pull): JsonRecord {
  return {
    id: pull.id,
    node_id: `P_${repo.id}_${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.state === 'open' ? true : null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${VIEWER_LOGIN}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${VIEWER_LOGIN}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function identityParts(identity: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(identity);
  if (!match) return { name: identity, email: '', date: FIXED_TIME };
  return {
    name: match[1],
    email: match[2],
    date: new Date(Number(match[3]) * 1000).toISOString(),
  };
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

/** Paginate a list; sets the Link header when another page exists. */
function paginate<T>(res: ServerResponse, reqUrl: string, host: string, items: T[], query: URLSearchParams): T[] {
  const { page, perPage } = pageParams(query);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const links: string[] = [];
  const base = `http://${host}${reqUrl.split('?')[0]}`;
  const other = new URLSearchParams(query);
  if (page < totalPages) {
    other.set('page', String(page + 1));
    other.set('per_page', String(perPage));
    links.push(`<${base}?${other.toString()}>; rel="next"`);
    other.set('page', String(totalPages));
    links.push(`<${base}?${other.toString()}>; rel="last"`);
  }
  if (page > 1) {
    other.set('page', '1');
    other.set('per_page', String(perPage));
    links.push(`<${base}?${other.toString()}>; rel="first"`);
    other.set('page', String(page - 1));
    links.push(`<${base}?${other.toString()}>; rel="prev"`);
  }
  if (links.length > 0) res.setHeader('Link', links.join(', '));
  return slice;
}

/** Resolve a repo from the URL, requiring the viewer as owner. */
function findRepo(ctx: RestContext, owner: string, name: string): Repo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return ctx.store.getRepo(owner, name);
}

export function handleRest(
  method: string,
  segments: string[],
  reqUrl: string,
  host: string,
  res: ServerResponse,
  ctx: RestContext,
): boolean {
  const [first] = segments;

  // API root.
  if (segments.length === 0) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  if (first === 'meta' && segments.length === 1) {
    if (method !== 'GET') return false;
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  if (first === 'user') {
    if (segments.length === 1 && method === 'GET') {
      sendJson(res, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
      return true;
    }
    if (segments.length === 2 && segments[1] === 'repos') {
      if (method === 'GET') {
        const repos = ctx.store.listRepos().map(repoJson);
        sendJson(res, 200, paginate(res, reqUrl, host, repos, ctx.query));
        return true;
      }
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') {
          err(res, 422, 'Repository name is required');
          return true;
        }
        if (ctx.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
          err(res, 422, 'Repository already exists');
          return true;
        }
        const repo = ctx.store.createRepo(name, {
          description: typeof body.description === 'string' ? body.description : '',
          private: body.private === true,
        });
        sendJson(res, 201, repoJson(repo));
        return true;
      }
      return false;
    }
    return false;
  }

  if (first === 'repos' && segments.length >= 3) {
    return handleRepoRoute(method, segments.slice(1), reqUrl, host, res, ctx);
  }

  return false;
}

function handleRepoRoute(
  method: string,
  segments: string[],
  reqUrl: string,
  host: string,
  res: ServerResponse,
  ctx: RestContext,
): boolean {
  const [owner, name, ...rest] = segments;
  const repo = findRepo(ctx, owner, name);
  if (repo === undefined) {
    err(res, 404, 'Not Found');
    return true;
  }
  const store = ctx.store;

  // /repos/{o}/{r} itself.
  if (rest.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'PATCH') {
      const body = isRecord(ctx.body) ? ctx.body : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.private = body.private;
      sendJson(res, 200, repoJson(repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, name);
      sendJson(res, 204, null);
      return true;
    }
    return false;
  }

  const [section, ...tail] = rest;

  if (section === 'branches') {
    if (tail.length === 0 && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((ref) => ref.startsWith('refs/heads/'))
        .sort()
        .map((ref) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) } }));
      sendJson(res, 200, branches);
      return true;
    }
    if (tail.length === 1 && method === 'GET') {
      const ref = `refs/heads/${tail[0]}`;
      const sha = repo.refs.get(ref);
      if (sha === undefined) {
        err(res, 404, 'Branch not found');
        return true;
      }
      sendJson(res, 200, { name: tail[0], commit: { sha } });
      return true;
    }
    return false;
  }

  if (section === 'commits') {
    if (method !== 'GET') return false;
    const ref = ctx.query.get('sha') ?? undefined;
    const history = store.history(repo, ref);
    const commits = history.map((sha) => {
      const object = repo.objects.get(sha)!;
      const commit = parseCommit(object.data);
      return {
        sha,
        commit: {
          message: commit.message,
          author: identityParts(commit.author),
          committer: identityParts(commit.committer),
        },
      };
    });
    sendJson(res, 200, commits);
    return true;
  }

  if (section === 'git') {
    if (tail[0] === 'refs') {
      if (method === 'POST' && tail.length === 1) {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || repo.objects.get(sha)?.type !== 'commit') {
          err(res, 422, 'Invalid ref or sha');
          return true;
        }
        if (repo.refs.has(ref)) {
          err(res, 422, 'Reference already exists');
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: 'commit' } });
        return true;
      }
      if (method === 'GET' && tail.length === 1) {
        const refs = [...repo.refs.entries()].sort().map(([ref, sha]) => ({ ref, object: { sha, type: 'commit' } }));
        sendJson(res, 200, refs);
        return true;
      }
      if (method === 'GET' && tail.length === 3 && tail[1] === 'heads') {
        const ref = `refs/heads/${tail[2]}`;
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          err(res, 404, 'Reference not found');
          return true;
        }
        sendJson(res, 200, { ref, object: { sha, type: 'commit' } });
        return true;
      }
    }
    return false;
  }

  if (section === 'contents') {
    const path = tail.join('/');
    if (method === 'PUT') return putContents(res, ctx, repo, path);
    if (method === 'GET') return getContents(res, ctx, repo, path);
    if (method === 'DELETE') return deleteContents(res, ctx, repo, path);
    return false;
  }

  if (section === 'labels') {
    if (method === 'POST' && tail.length === 0) {
      const body = isRecord(ctx.body) ? ctx.body : {};
      const labelName = typeof body.name === 'string' ? body.name : '';
      if (labelName === '') {
        err(res, 422, 'Label name is required');
        return true;
      }
      const existing = repo.labels.get(labelName);
      if (existing) {
        sendJson(res, 201, labelJson(existing));
        return true;
      }
      const label = {
        name: labelName,
        color: typeof body.color === 'string' ? body.color : 'ededed',
        description: typeof body.description === 'string' ? body.description : '',
      };
      repo.labels.set(labelName, label);
      sendJson(res, 201, labelJson(label));
      return true;
    }
    if (method === 'GET' && tail.length === 0) {
      sendJson(res, 200, [...repo.labels.values()].map(labelJson));
      return true;
    }
    return false;
  }

  if (section === 'issues') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        const issues = store.listIssues(repo, state, sort, direction).map((issue) => issueJson(repo, issue));
        sendJson(res, 200, paginate(res, reqUrl, host, issues, ctx.query));
        return true;
      }
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') {
          err(res, 422, 'Title is required');
          return true;
        }
        const labels = Array.isArray(body.labels) ? body.labels.filter((entry): entry is string => typeof entry === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) {
            err(res, 422, `Label '${label}' does not exist`);
            return true;
          }
        }
        const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
        sendJson(res, 201, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    const number = Number(tail[0]);
    if (!Number.isInteger(number)) return false;
    const issue = repo.issues.find((candidate) => candidate.number === number);
    if (tail.length === 1) {
      if (issue === undefined) {
        err(res, 404, 'Issue not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
        if (typeof body.title === 'string') issue.title = body.title;
        if (typeof body.body === 'string') issue.body = body.body;
        sendJson(res, 200, issueJson(repo, issue));
        return true;
      }
      return false;
    }
    if (tail.length === 2 && tail[1] === 'comments') {
      if (issue === undefined) {
        err(res, 404, 'Issue not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(
          res,
          200,
          issue.comments.map((comment) => ({ id: comment.id, body: comment.body, created_at: FIXED_TIME, updated_at: FIXED_TIME })),
        );
        return true;
      }
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const commentBody = typeof body.body === 'string' ? body.body : '';
        const comment = { id: repo.nextCommentId++, body: commentBody, seq: ctx.store.nextSeq() };
        issue.comments.push(comment);
        sendJson(res, 201, { id: comment.id, body: comment.body, created_at: FIXED_TIME, updated_at: FIXED_TIME });
        return true;
      }
      return false;
    }
    return false;
  }

  if (section === 'pulls') {
    if (tail.length === 0) {
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let pulls = [...repo.pulls];
        if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
        else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
        pulls.sort((a, b) => b.seq - a.seq);
        sendJson(res, 200, paginate(res, reqUrl, host, pulls.map((pull) => pullJson(repo, pull)), ctx.query));
        return true;
      }
      if (method === 'POST') {
        const body = isRecord(ctx.body) ? ctx.body : {};
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head.replace(/^refs\/heads\//, '') : '';
        const base = typeof body.base === 'string' ? body.base.replace(/^refs\/heads\//, '') : repo.defaultBranch;
        if (title === '' || head === '') {
          err(res, 422, 'A pull request needs a title and a head branch');
          return true;
        }
        if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
          err(res, 422, 'Head or base branch does not exist');
          return true;
        }
        const duplicate = repo.pulls.find((pull) => pull.headRef === head && pull.baseRef === base && pull.state === 'open');
        if (duplicate) {
          err(res, 422, 'A pull request already exists for this head branch');
          return true;
        }
        const pull = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
        if (pull === null) {
          err(res, 422, 'Could not create the pull request');
          return true;
        }
        sendJson(res, 201, pullJson(repo, pull));
        return true;
      }
      return false;
    }
    const number = Number(tail[0]);
    if (!Number.isInteger(number)) return false;
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (tail.length === 1) {
      if (pull === undefined) {
        err(res, 404, 'Pull request not found');
        return true;
      }
      if (method === 'GET') {
        sendJson(res, 200, pullJson(repo, pull));
        return true;
      }
      return false;
    }
    if (tail.length === 2 && tail[1] === 'files' && method === 'GET') {
      if (pull === undefined) {
        err(res, 404, 'Pull request not found');
        return true;
      }
      sendJson(res, 200, store.liveDiff(repo, pull).files);
      return true;
    }
    if (tail.length === 2 && tail[1] === 'merge' && method === 'PUT') {
      if (pull === undefined) {
        err(res, 404, 'Pull request not found');
        return true;
      }
      if (pull.merged || pull.state === 'closed') {
        err(res, 405, 'Pull request is already merged or closed');
        return true;
      }
      const sha = store.squashMerge(repo, pull);
      if (sha === null) {
        err(res, 405, 'This branch has conflicts that must be resolved');
        return true;
      }
      sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
      return true;
    }
    return false;
  }

  return false;
}

function putContents(res: ServerResponse, ctx: RestContext, repo: Repo, path: string): boolean {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const message = typeof body.message === 'string' ? body.message : 'Update file';
  const content = typeof body.content === 'string' ? body.content : '';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  if (path === '') {
    err(res, 422, 'A file path is required');
    return true;
  }
  const branchRef = `refs/heads/${branch}`;
  let branchTip = repo.refs.get(branchRef);
  if (branchTip === undefined) {
    const defaultTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (defaultTip !== undefined) {
      repo.refs.set(branchRef, defaultTip);
      branchTip = defaultTip;
    }
  }
  const current = branchTip !== undefined ? ctx.store.blobAtPath(repo, branch, path) : null;
  if (sha !== undefined) {
    if (current === null || current.oid !== sha) {
      err(res, 409, 'The file sha does not match the current version');
      return true;
    }
  } else if (current !== null) {
    err(res, 422, 'File already exists');
    return true;
  }
  const data = Buffer.from(content, 'base64');
  const blobOid = ctx.store.putObject(repo, 'blob', data);
  const baseTree = branchTip !== undefined ? ctx.store.treeAt(repo, branch) : null;
  const newTree = ctx.store.setPathInTree(repo, baseTree, path, blobOid);
  const commitSha = ctx.store.commitTree(repo, branch, newTree, message);
  const created = current === null;
  sendJson(res, created ? 201 : 200, {
    content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64' },
    commit: { sha: commitSha },
  });
  return true;
}

function getContents(res: ServerResponse, ctx: RestContext, repo: Repo, path: string): boolean {
  const ref = ctx.query.get('ref') ?? undefined;
  if (path === '') {
    const entries = ctx.store.dirEntries(repo, ref, '');
    if (entries === null) {
      err(res, 404, 'Not Found');
      return true;
    }
    sendJson(
      res,
      200,
      entries.map((entry) => ({ type: entry.mode === '40000' ? 'dir' : 'file', name: entry.name, path: entry.name, sha: entry.oid })),
    );
    return true;
  }
  const treeOid = ctx.store.treeAt(repo, ref);
  if (treeOid === null) {
    err(res, 404, 'Not Found');
    return true;
  }
  const blob = ctx.store.blobAtPath(repo, ref, path);
  if (blob !== null) {
    sendJson(res, 200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop(),
      path,
      content: blob.data.toString('base64'),
      sha: blob.oid,
    });
    return true;
  }
  const entries = ctx.store.dirEntries(repo, ref, path);
  if (entries === null) {
    err(res, 404, 'Not Found');
    return true;
  }
  sendJson(
    res,
    200,
    entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${path}/${entry.name}`,
      sha: entry.oid,
    })),
  );
  return true;
}

function deleteContents(res: ServerResponse, ctx: RestContext, repo: Repo, path: string): boolean {
  const body = isRecord(ctx.body) ? ctx.body : {};
  const message = typeof body.message === 'string' ? body.message : 'Delete file';
  const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const current = ctx.store.blobAtPath(repo, branch, path);
  if (current === null) {
    err(res, 404, 'Not Found');
    return true;
  }
  if (sha === undefined) {
    err(res, 422, 'sha is required to delete a file');
    return true;
  }
  if (current.oid !== sha) {
    err(res, 409, 'The file sha does not match the current version');
    return true;
  }
  const baseTree = ctx.store.treeAt(repo, branch);
  const newTree = ctx.store.setPathInTree(repo, baseTree, path, null);
  const commitSha = ctx.store.commitTree(repo, branch, newTree, message);
  sendJson(res, 200, { commit: { sha: commitSha } });
  return true;
}
