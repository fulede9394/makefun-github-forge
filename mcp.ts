// mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over
// Streamable HTTP, revision 2026-07-28 via server/discover (with the legacy
// initialize handshake as a fallback). Six tools share the store with REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_TIME, VIEWER_ID, VIEWER_LOGIN, type Repo, type Store } from './store.ts';

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description?: string }>;
    required: string[];
  };
}

/** The tool list: a constant, so two tools/list calls answer byte for byte alike. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by its owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function issueJson(repo: Repo, issue: Repo['issues'][number]): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
  };
}

function pullJson(repo: Repo, pull: Repo['pulls'][number]): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha },
    base: { ref: pull.baseRef, sha: pull.baseSha },
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(res: ServerResponse, id: unknown, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(res: ServerResponse, status: number, id: unknown, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolResult(res: ServerResponse, id: unknown, value: unknown, isError = false): void {
  rpcResult(res, id, {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
    isError,
  });
}

function toolError(res: ServerResponse, id: unknown, message: string): void {
  toolResult(res, id, message, true);
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

function findRepo(store: Store, args: Record<string, unknown>): Repo | undefined {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? args.repository ?? '');
  if (owner !== VIEWER_LOGIN) return undefined;
  return store.getRepo(owner, repo);
}

export function handleMcp(req: IncomingMessage, res: ServerResponse, store: Store, token: string, body: Buffer): void {
  const auth = req.headers.authorization ?? '';
  if (token !== '' && auth !== `Bearer ${token}`) {
    rpcError(res, 401, null, -32000, 'Unauthorized');
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    rpcError(res, 400, null, -32700, 'Parse error');
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    rpcError(res, 400, null, -32600, 'Invalid Request');
    return;
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is answered with 202 and no body.
  if (request.id === undefined) {
    res.writeHead(202, { 'content-type': 'application/json; charset=utf-8', 'content-length': 0 });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    rpcResult(res, id, {
      supportedVersions: [PROTOCOL_VERSION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
    return;
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    rpcResult(res, id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }

  if (method === 'tools/list') {
    rpcResult(res, id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    // Some clients send the arguments already stringified; accept both shapes.
    let args = params.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args) as Record<string, unknown>;
      } catch {
        toolError(res, id, 'arguments is not valid JSON');
        return;
      }
    }
    const argsObject = (args ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((candidate) => candidate.name === name) ?? TOOLS.find((candidate) => candidate.name.toLowerCase() === name.toLowerCase());
    if (tool === undefined) {
      rpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
      return;
    }
    const missing = missingArgs(tool, argsObject);
    if (missing.length > 0) {
      toolError(res, id, `Missing required argument(s): ${missing.join(', ')}`);
      return;
    }
    callTool(res, id, store, tool.name, argsObject);
    return;
  }

  rpcError(res, 200, id, -32601, `Method not found: ${method}`);
}

function callTool(res: ServerResponse, id: unknown, store: Store, name: string, args: Record<string, unknown>): void {
  if (name === 'create_repo') {
    const repoName = String(args.name ?? '');
    if (store.getRepo(VIEWER_LOGIN, repoName) !== undefined) {
      toolError(res, id, `Repository ${repoName} already exists`);
      return;
    }
    const repo = store.createRepo(repoName, {
      description: typeof args.description === 'string' ? args.description : '',
      private: args.private === true,
    });
    toolResult(res, id, repoJson(repo));
    return;
  }

  if (name === 'get_repo') {
    const repo = findRepo(store, args);
    if (repo === undefined) {
      toolError(res, id, 'Repository not found');
      return;
    }
    toolResult(res, id, repoJson(repo));
    return;
  }

  if (name === 'create_issue') {
    const repo = findRepo(store, args);
    if (repo === undefined) {
      toolError(res, id, 'Repository not found');
      return;
    }
    const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
    toolResult(res, id, issueJson(repo, issue));
    return;
  }

  if (name === 'list_issues') {
    const repo = findRepo(store, args);
    if (repo === undefined) {
      toolError(res, id, 'Repository not found');
      return;
    }
    const state = typeof args.state === 'string' ? args.state : 'open';
    const issues = store.listIssues(repo, state, 'created', 'desc').map((issue) => issueJson(repo, issue));
    toolResult(res, id, issues);
    return;
  }

  if (name === 'create_pull_request') {
    const repo = findRepo(store, args);
    if (repo === undefined) {
      toolError(res, id, 'Repository not found');
      return;
    }
    const head = String(args.head ?? '');
    const base = String(args.base ?? repo.defaultBranch);
    if (repo.refs.get(`refs/heads/${head}`) === undefined || repo.refs.get(`refs/heads/${base}`) === undefined) {
      toolError(res, id, 'Head or base branch does not exist');
      return;
    }
    const pull = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
    if (pull === null) {
      toolError(res, id, 'Could not create the pull request');
      return;
    }
    toolResult(res, id, pullJson(repo, pull));
    return;
  }

  if (name === 'merge_pull_request') {
    const repo = findRepo(store, args);
    if (repo === undefined) {
      toolError(res, id, 'Repository not found');
      return;
    }
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((candidate) => candidate.number === number);
    if (pull === undefined) {
      toolError(res, id, 'Pull request not found');
      return;
    }
    if (pull.merged || pull.state === 'closed') {
      toolError(res, id, 'Pull request is already merged or closed');
      return;
    }
    const sha = store.squashMerge(repo, pull);
    if (sha === null) {
      toolError(res, id, 'This branch has conflicts that must be resolved');
      return;
    }
    toolResult(res, id, { sha, merged: true, number: pull.number, state: pull.state });
    return;
  }

  rpcError(res, 200, id, -32602, `Unknown tool: ${name}`);
}
