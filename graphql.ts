// graphql.ts — a small GraphQL v4 executor for the documents gh and
// github-mcp-server actually send: viewer/repository/issue/pull-request reads,
// __type introspection, the five mutations, node(id:) and operation batching.
// No GraphQL library: a hand-rolled tokenizer, parser and resolver.

import type { ServerResponse } from 'node:http';
import { FIXED_TIME, VIEWER_LOGIN, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { sendJson } from './rest.ts';

// -------------------------------------------------------------------------------------------
// tokenizer + parser
// -------------------------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'eof' };

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const next = input[i + 1];
          value += next === 'n' ? '\n' : next === 't' ? '\t' : next;
          i += 2;
        } else {
          value += input[i];
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@&|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let value = '';
      while (i < input.length && /[0-9]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'int', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = '';
      while (i < input.length && /[A-Za-z0-9_]/.test(input[i])) {
        value += input[i];
        i += 1;
      }
      tokens.push({ kind: 'name', value });
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof' });
  return tokens;
}

interface ValueNode {
  kind: 'variable' | 'string' | 'int' | 'boolean' | 'null' | 'enum' | 'list' | 'object';
  name?: string;
  value?: string | number | boolean;
  items?: ValueNode[];
  fields?: Array<{ name: string; value: ValueNode }>;
}

interface FieldNode {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selection: SelectionNode[] | null;
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

type SelectionNode = { kind: 'field'; field: FieldNode } | { kind: 'fragment'; fragment: FragmentNode };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value}, got ${JSON.stringify(token)}`);
  }

  private skipVariableDefinitions(): void {
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      let depth = 0;
      while (this.pos < this.tokens.length) {
        const token = this.next();
        if (token.kind === 'punct' && token.value === '(') depth += 1;
        if (token.kind === 'punct' && token.value === ')') {
          depth -= 1;
          if (depth === 0) return;
        }
      }
    }
  }

  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek().kind !== 'eof') {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
      const next = this.peek();
      if (next.kind === 'name') name = this.next().value;
    }
    this.skipVariableDefinitions();
    const selection = this.parseSelectionSet();
    return { operation, name, selection };
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
      if (this.peek().kind === 'punct' && this.peek().value === '...') {
        this.next();
        const typeToken = this.next();
        if (typeToken.kind !== 'name' || typeToken.value !== 'on') throw new Error('expected "on" in fragment spread');
        const condition = this.next();
        if (condition.kind !== 'name') throw new Error('expected a type name in fragment spread');
        selections.push({ kind: 'fragment', fragment: { typeCondition: condition.value, selection: this.parseSelectionSet() } });
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    this.expectPunct('}');
    return selections;
  }

  private parseField(): FieldNode {
    const first = this.next();
    if (first.kind !== 'name') throw new Error('expected a field name');
    let alias: string | null = null;
    let name = first.value;
    if (this.peek().kind === 'punct' && this.peek().value === ':') {
      this.next();
      const actual = this.next();
      if (actual.kind !== 'name') throw new Error('expected a field name after alias');
      alias = name;
      name = actual.value;
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!(this.peek().kind === 'punct' && this.peek().value === ')')) {
        const argName = this.next();
        if (argName.kind !== 'name') throw new Error('expected an argument name');
        this.expectPunct(':');
        args.push({ name: argName.value, value: this.parseValue() });
      }
      this.next();
    }
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      const name = this.next();
      if (name.kind !== 'name') throw new Error('expected a variable name');
      return { kind: 'variable', name: name.value };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === ']')) items.push(this.parseValue());
      this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!(this.peek().kind === 'punct' && this.peek().value === '}')) {
        const fieldName = this.next();
        if (fieldName.kind !== 'name') throw new Error('expected an object field name');
        this.expectPunct(':');
        fields.push({ name: fieldName.value, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    throw new Error(`unexpected value token ${JSON.stringify(token)}`);
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name ?? ''];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return (node.items ?? []).map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields ?? []) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// schema: the fields each type exposes, for validation and introspection
// -------------------------------------------------------------------------------------------

const SCHEMA_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  User: ['login', 'id', 'name', 'email'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
    'url', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable',
    'files', 'createdAt', 'updatedAt', 'headRef', 'baseRef', 'author',
  ],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'filename', 'additions', 'deletions', 'changes'],
  Ref: ['name'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  AddCommentEdge: ['node'],
  IssueComment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description'],
  __EnumValue: ['name', 'description'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'WIKI'];

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface ExecContext {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

type GqlValue = Record<string, unknown> | unknown[] | string | number | boolean | null;

function argMap(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, ctx.variables);
  return out;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const index = Number(text.slice('cursor:'.length));
    return Number.isInteger(index) ? index : -1;
  } catch {
    return -1;
  }
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(store: Store, repo: Repo, issue: Issue): GqlValue {
  return {
    __typename: 'Issue',
    id: store.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

function pullNode(store: Store, repo: Repo, pull: Pull): GqlValue {
  const mergeable = pull.state === 'open' ? (store.mergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING') : 'UNKNOWN';
  return {
    __typename: 'PullRequest',
    __repo: repo,
    id: store.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
}

function repoNode(store: Store, repo: Repo): GqlValue {
  const defaultRef = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    __typename: 'Repository',
    id: store.repoGlobalId(repo),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __typename: 'User', login: repo.owner, id: 1000 },
    defaultBranchRef: defaultRef !== undefined ? { __typename: 'Ref', name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    __repo: repo,
  };
}

/** The child type a field's sub-selection belongs to, for recursive validation. */
const CHILD_TYPE: Record<string, Record<string, string>> = {
  Query: { viewer: 'User', repository: 'Repository' },
  Repository: {
    owner: 'User',
    defaultBranchRef: 'Ref',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  IssueConnection: { nodes: 'Issue', pageInfo: 'PageInfo' },
  PullRequestConnection: { nodes: 'PullRequest', pageInfo: 'PageInfo' },
  PullRequest: { files: 'PullRequestChangedFileConnection' },
  PullRequestChangedFileConnection: { nodes: 'PullRequestChangedFile' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  CreateIssuePayload: { issue: 'Issue' },
  CloseIssuePayload: { issue: 'Issue' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest' },
  MergePullRequestPayload: { pullRequest: 'PullRequest' },
  AddCommentPayload: { commentEdge: 'AddCommentEdge' },
  AddCommentEdge: { node: 'IssueComment' },
  __Type: { fields: '__Field', enumValues: '__EnumValue' },
};

/** Recursively validate a selection set against the schema; unknown fields become errors. */
function validateSelection(typeName: string, selections: SelectionNode[], ctx: ExecContext): void {
  const fields = SCHEMA_FIELDS[typeName];
  if (fields === undefined) return;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      validateSelection(selection.fragment.typeCondition, selection.fragment.selection, ctx);
      continue;
    }
    const field = selection.field;
    if (field.name.startsWith('__')) {
      if (field.selection !== null) validateSelection('__Type', field.selection, ctx);
      continue;
    }
    if (!fields.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      continue;
    }
    if (field.selection !== null) {
      const child = CHILD_TYPE[typeName]?.[field.name];
      if (child !== undefined) validateSelection(child, field.selection, ctx);
    }
  }
}

function executeSelection(
  typeName: string,
  value: Record<string, unknown> | null,
  selections: SelectionNode[],
  ctx: ExecContext,
): Record<string, unknown> | null {
  if (value === null) return null;
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      const typename = (value.__typename as string | undefined) ?? typeName;
      if (selection.fragment.typeCondition !== typename) continue;
      const nested = executeSelection(selection.fragment.typeCondition, value, selection.fragment.selection, ctx);
      if (nested !== null) Object.assign(out, nested);
      continue;
    }
    const field = selection.field;
    // Execution-time validation: the pre-pass cannot see inside node(id:)
    // fragments, so an unknown field there is caught here instead of
    // silently reading back as null.
    if (!field.name.startsWith('__')) {
      const known = SCHEMA_FIELDS[typeName];
      if (known !== undefined && !known.includes(field.name)) {
        ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
        out[field.alias ?? field.name] = null;
        continue;
      }
    }
    const key = field.alias ?? field.name;
    out[key] = resolveField(typeName, value, field, ctx);
  }
  return out;
}

function connectionOf<T>(nodes: T[], first: number | undefined, after: unknown): { nodes: T[]; pageInfo: Record<string, unknown>; totalCount: number } {
  const start = decodeCursor(after) + 1;
  const sliced = first === undefined ? nodes.slice(start) : nodes.slice(start, start + first);
  const endIndex = sliced.length === 0 ? start - 1 : start + sliced.length - 1;
  return {
    nodes: sliced,
    pageInfo: {
      hasNextPage: endIndex + 1 < nodes.length,
      hasPreviousPage: start > 0,
      startCursor: sliced.length === 0 ? null : encodeCursor(start),
      endCursor: sliced.length === 0 ? null : encodeCursor(endIndex),
    },
    totalCount: nodes.length,
  };
}

function resolveField(typeName: string, parent: Record<string, unknown>, field: FieldNode, ctx: ExecContext): GqlValue {
  const store = ctx.store;
  const args = argMap(field, ctx);
  const sub = field.selection;

  if (typeName === 'Query') {
    if (field.name === 'viewer') {
      const value = { __typename: 'User', login: VIEWER_LOGIN, id: 1000, name: 'ada iversen', email: 'adaiversen@example.invalid' };
      return sub === null ? (value as GqlValue) : (executeSelection('User', value, sub, ctx) as GqlValue);
    }
    if (field.name === 'repository') {
      const owner = args.owner as string;
      const name = args.name as string;
      const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
      if (repo === undefined) return null;
      const value = repoNode(store, repo);
      return sub === null ? value : (executeSelection('Repository', value as Record<string, unknown>, sub, ctx) as GqlValue);
    }
    if (field.name === 'node') {
      const id = args.id as string;
      const decoded = store.decodeGlobalId(id);
      if (decoded === null) return null;
      if (decoded.kind === 'Repository') {
        const repo = store.findRepoByGlobalId(id);
        if (repo === undefined) return null;
        const value = repoNode(store, repo);
        return sub === null ? value : (executeSelection('Repository', value as Record<string, unknown>, sub, ctx) as GqlValue);
      }
      return null;
    }
    if (field.name === '__type') {
      const name = args.name as string;
      if (name === 'SearchType') {
        const value: Record<string, unknown> = { __typename: '__Type', name: 'SearchType', kind: 'ENUM' };
        if (sub !== null) {
          const out: Record<string, unknown> = {};
          for (const selection of sub) {
            if (selection.kind !== 'field') continue;
            if (selection.field.name === 'enumValues') out[selection.field.alias ?? 'enumValues'] = SEARCH_TYPE_VALUES.map((entry) => ({ name: entry }));
            else if (selection.field.name === 'name') out[selection.field.alias ?? 'name'] = 'SearchType';
            else if (selection.field.name === 'kind') out[selection.field.alias ?? 'kind'] = 'ENUM';
            else if (selection.field.name === 'fields') out[selection.field.alias ?? 'fields'] = null;
          }
          return out as GqlValue;
        }
        return value as GqlValue;
      }
      const fields = SCHEMA_FIELDS[name];
      if (fields === undefined) return null;
      const value: Record<string, unknown> = { __typename: '__Type', name, kind: 'OBJECT' };
      if (sub !== null) {
        const out: Record<string, unknown> = {};
        for (const selection of sub) {
          if (selection.kind !== 'field') continue;
          const key = selection.field.alias ?? selection.field.name;
          if (selection.field.name === 'fields') out[key] = fields.map((entry) => ({ name: entry }));
          else if (selection.field.name === 'enumValues') out[key] = null;
          else if (selection.field.name === 'name') out[key] = name;
          else if (selection.field.name === 'kind') out[key] = 'OBJECT';
        }
        return out as GqlValue;
      }
      return value as GqlValue;
    }
    return null;
  }

  if (typeName === 'Repository') {
    const repo = parent.__repo as Repo;
    if (field.name === 'issue') {
      const number = args.number as number;
      const issue = repo.issues.find((candidate) => candidate.number === number);
      if (issue === undefined) return null;
      const value = issueNode(store, repo, issue);
      return sub === null ? value : (executeSelection('Issue', value as Record<string, unknown>, sub, ctx) as GqlValue);
    }
    if (field.name === 'issues') {
      let list = [...repo.issues];
      const states = args.states as string[] | undefined;
      if (states !== undefined && states.length > 0) {
        list = list.filter((issue) => states.includes(issueState(issue)));
      }
      const orderBy = args.orderBy as { field?: string; direction?: string } | undefined;
      if (orderBy?.field === 'CREATED_AT') {
        list.sort((a, b) => (orderBy.direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
      }
      const nodes = list.map((issue) => {
        const value = issueNode(store, repo, issue);
        const nodeSelection = findFieldSelection(sub, 'nodes');
        return nodeSelection === null ? value : executeSelection('Issue', value as Record<string, unknown>, nodeSelection, ctx);
      });
      const connection = connectionOf(nodes, args.first as number | undefined, args.after);
      return sub === null ? (connection as unknown as GqlValue) : executeConnection(sub, connection, ctx);
    }
    if (field.name === 'pullRequests') {
      const list = [...repo.pulls].sort((a, b) => b.seq - a.seq);
      const nodes = list.map((pull) => {
        const value = pullNode(store, repo, pull);
        const nodeSelection = findFieldSelection(sub, 'nodes');
        return nodeSelection === null ? value : executeSelection('PullRequest', value as Record<string, unknown>, nodeSelection, ctx);
      });
      const connection = connectionOf(nodes, args.first as number | undefined, args.after);
      return sub === null ? (connection as unknown as GqlValue) : executeConnection(sub, connection, ctx);
    }
    if (field.name === 'pullRequest') {
      const number = args.number as number;
      const pull = repo.pulls.find((candidate) => candidate.number === number);
      if (pull === undefined) return null;
      const value = pullNode(store, repo, pull);
      return sub === null ? value : (executeSelection('PullRequest', value as Record<string, unknown>, sub, ctx) as GqlValue);
    }
    if (field.name === 'owner') {
      const value = parent.owner as Record<string, unknown>;
      return sub === null ? (value as GqlValue) : (executeSelection('User', value, sub, ctx) as GqlValue);
    }
    if (field.name === 'defaultBranchRef') {
      const value = parent.defaultBranchRef as Record<string, unknown> | null;
      if (value === null) return null;
      return sub === null ? (value as GqlValue) : (executeSelection('Ref', value, sub, ctx) as GqlValue);
    }
    return (parent[field.name] as GqlValue) ?? null;
  }

  if (typeName === 'PullRequest') {
    if (field.name === 'files') {
      const repo = (parent as Record<string, unknown>).__repo as Repo | undefined;
      const pull = repo?.pulls.find((candidate) => candidate.number === (parent.number as number));
      const files = pull !== undefined && repo !== undefined ? ctx.store.liveDiff(repo, pull).files : (pull?.files ?? []);
      const nodes = files.map((file) => ({ path: file.filename, filename: file.filename, additions: file.additions, deletions: file.deletions, changes: file.changes }));
      const nodeSelection = findFieldSelection(sub, 'nodes');
      const resolved = nodeSelection === null ? nodes : nodes.map((node) => executeSelection('PullRequestChangedFile', node as unknown as Record<string, unknown>, nodeSelection, ctx));
      const connection = connectionOf(resolved as unknown[], args.first as number | undefined, undefined);
      return sub === null ? (connection as unknown as GqlValue) : executeConnection(sub, connection, ctx);
    }
    return (parent[field.name] as GqlValue) ?? null;
  }

  if (typeName === 'Mutation') {
    return resolveMutation(field, ctx);
  }

  return (parent[field.name] as GqlValue) ?? null;
}

function findFieldSelection(sub: SelectionNode[] | null, name: string): SelectionNode[] | null {
  if (sub === null) return null;
  for (const selection of sub) {
    if (selection.kind === 'field' && selection.field.name === name) return selection.field.selection;
  }
  return null;
}

function executeConnection(sub: SelectionNode[], connection: { nodes: unknown[]; pageInfo: Record<string, unknown>; totalCount: number }, _ctx: ExecContext): GqlValue {
  const out: Record<string, unknown> = {};
  for (const selection of sub) {
    if (selection.kind !== 'field') continue;
    const key = selection.field.alias ?? selection.field.name;
    if (selection.field.name === 'nodes') out[key] = connection.nodes;
    else if (selection.field.name === 'pageInfo') {
      const pageInfo = connection.pageInfo;
      if (selection.field.selection === null) out[key] = pageInfo;
      else {
        const pageOut: Record<string, unknown> = {};
        for (const pageSelection of selection.field.selection) {
          if (pageSelection.kind !== 'field') continue;
          pageOut[pageSelection.field.alias ?? pageSelection.field.name] = pageInfo[pageSelection.field.name] ?? null;
        }
        out[key] = pageOut;
      }
    } else if (selection.field.name === 'totalCount') out[key] = connection.totalCount;
  }
  return out as GqlValue;
}

function resolveMutation(field: FieldNode, ctx: ExecContext): GqlValue {
  const store = ctx.store;
  const args = argMap(field, ctx);
  const input = (args.input ?? {}) as Record<string, unknown>;
  const sub = field.selection;

  if (field.name === 'createIssue') {
    const repo = store.findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const issue = store.createIssue(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', []);
    const value = { issue: issueNode(store, repo, issue) };
    return sub === null ? (value as unknown as GqlValue) : selectMutationResult(sub, 'createIssue', value, ctx);
  }
  if (field.name === 'closeIssue') {
    const found = store.findIssueByGlobalId(String(input.issueId ?? ''));
    if (found === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    found.issue.state = 'closed';
    const value = { issue: issueNode(store, found.repo, found.issue) };
    return sub === null ? (value as unknown as GqlValue) : selectMutationResult(sub, 'closeIssue', value, ctx);
  }
  if (field.name === 'createPullRequest') {
    const repo = store.findRepoByGlobalId(String(input.repositoryId ?? ''));
    if (repo === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the id provided.' });
      return null;
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const pull = store.createPull(repo, String(input.title ?? ''), typeof input.body === 'string' ? input.body : '', head, base);
    if (pull === null) {
      ctx.errors.push({ message: 'Head or base branch does not exist.' });
      return null;
    }
    const value = { pullRequest: pullNode(store, repo, pull) };
    return sub === null ? (value as unknown as GqlValue) : selectMutationResult(sub, 'createPullRequest', value, ctx);
  }
  if (field.name === 'mergePullRequest') {
    const found = store.findPullByGlobalId(String(input.pullRequestId ?? ''));
    if (found === undefined) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the id provided.' });
      return null;
    }
    if (found.pull.state === 'closed') {
      ctx.errors.push({ message: 'Pull request is already closed.' });
      return null;
    }
    const sha = store.squashMerge(found.repo, found.pull);
    if (sha === null) {
      ctx.errors.push({ message: 'This branch has conflicts that must be resolved.' });
      return null;
    }
    const value = { pullRequest: pullNode(store, found.repo, found.pull) };
    return sub === null ? (value as unknown as GqlValue) : selectMutationResult(sub, 'mergePullRequest', value, ctx);
  }
  if (field.name === 'addComment') {
    const found = store.findIssueByGlobalId(String(input.subjectId ?? ''));
    if (found === undefined) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the id provided.' });
      return null;
    }
    const comment = { id: found.repo.nextCommentId++, body: String(input.body ?? ''), seq: store.nextSeq() };
    found.issue.comments.push(comment);
    const value = { commentEdge: { node: { id: store.commentGlobalId(comment), body: comment.body } } };
    return sub === null ? (value as unknown as GqlValue) : selectMutationResult(sub, 'addComment', value, ctx);
  }
  ctx.errors.push({ message: `Cannot query field "${field.name}" on type "Mutation".` });
  return null;
}

function selectMutationResult(
  sub: SelectionNode[],
  _fieldName: string,
  value: Record<string, unknown>,
  ctx: ExecContext,
): GqlValue {
  const out: Record<string, unknown> = {};
  for (const selection of sub) {
    if (selection.kind !== 'field') continue;
    const key = selection.field.alias ?? selection.field.name;
    const nested = value[selection.field.name];
    if (nested === null || nested === undefined) {
      out[key] = null;
      continue;
    }
    if (selection.field.selection === null || typeof nested !== 'object') {
      out[key] = nested;
      continue;
    }
    if (selection.field.name === 'commentEdge') {
      const node = (nested as Record<string, unknown>).node as Record<string, unknown>;
      const nodeSelection = findFieldSelection(selection.field.selection, 'node');
      out[key] = { node: nodeSelection === null ? node : executeSelection('IssueComment', node, nodeSelection, ctx) };
      continue;
    }
    const typename =
      selection.field.name === 'issue' ? 'Issue' : selection.field.name === 'pullRequest' ? 'PullRequest' : 'Issue';
    out[key] = executeSelection(typename, nested as Record<string, unknown>, selection.field.selection, ctx);
  }
  return out as GqlValue;
}

// -------------------------------------------------------------------------------------------
// HTTP entry point
// -------------------------------------------------------------------------------------------

export function handleGraphQL(body: unknown, store: Store, res: ServerResponse): void {
  if (Array.isArray(body)) {
    const results = body.map((operation) => executeOperation(operation, store));
    sendJson(res, 200, results);
    return;
  }
  sendJson(res, 200, executeOperation(body, store));
}

function executeOperation(operation: unknown, store: Store): Record<string, unknown> {
  const ctx: ExecContext = { store, variables: {}, errors: [] };
  if (typeof operation !== 'object' || operation === null || Array.isArray(operation)) {
    return { data: null, errors: [{ message: 'Invalid GraphQL operation.' }] };
  }
  const query = (operation as Record<string, unknown>).query;
  const variables = (operation as Record<string, unknown>).variables;
  if (typeof query !== 'string') {
    return { data: null, errors: [{ message: 'The query must be a string.' }] };
  }
  ctx.variables = (variables !== null && typeof variables === 'object' && !Array.isArray(variables) ? variables : {}) as Record<string, unknown>;
  let parsed: OperationNode[];
  try {
    parsed = new Parser(tokenize(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Failed to parse the query.' }] };
  }
  if (parsed.length === 0) {
    return { data: null, errors: [{ message: 'The query is empty.' }] };
  }
  const operationName = (operation as Record<string, unknown>).operationName as string | undefined;
  const selected = operationName !== undefined ? parsed.find((entry) => entry.name === operationName) ?? parsed[0]! : parsed[0]!;
  const typeName = selected.operation === 'mutation' ? 'Mutation' : 'Query';
  validateSelection(typeName, selected.selection, ctx);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  const data = executeSelection(typeName, typeName === 'Query' ? { __typename: 'Query' } : { __typename: 'Mutation' }, selected.selection, ctx);
  if (ctx.errors.length > 0) {
    return { data, errors: ctx.errors };
  }
  return { data };
}
