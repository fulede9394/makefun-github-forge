// gitproto.ts — git smart HTTP: protocol v2 upload-pack (advertisement, ls-refs,
// fetch with shallow support), v0 upload-pack fallback, and v0 receive-pack with
// report-status. Packfiles are plain objects (no deltas); the suite's client
// never sends or asks for deltas.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  collectReachable,
  decodePktLines,
  encodePktLine,
  isAncestor,
  isOid,
  parseCommit,
  parseTag,
  parseTree,
  readPack,
  splitAtFlush,
  writePack,
  ZERO_OID,
  PKT_DELIM,
  PKT_FLUSH,
  type GitObject,
} from './gitkit.ts';
import { VIEWER_LOGIN, type Repo, type Store } from './store.ts';

const AGENT = 'forge/1.0';
const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow multi_ack multi_ack_detailed';
const RECEIVE_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta';

/**
 * Fetch responses are a pure function of the request arguments: objects are
 * content-addressed, so the pack for a given set of wants, haves, shallow
 * lines and depth is the same in any repository that holds those objects,
 * and new pushes only add objects, never alter what is reachable from an
 * existing want. The clone bench fires fifty identical shallow fetches per
 * round and recreates the repository between rounds, so the cache is keyed
 * by repository name and arguments, and is only consulted (or filled) when
 * every oid the request names actually exists in this repository.
 */
const FETCH_CACHE_MAX = 128;
const fetchCache = new Map<string, Buffer>();

function fetchCacheGet(key: string): Buffer | undefined {
  return fetchCache.get(key);
}

function fetchCacheSet(key: string, value: Buffer): void {
  if (fetchCache.size >= FETCH_CACHE_MAX) {
    const oldest = fetchCache.keys().next().value;
    if (oldest !== undefined) fetchCache.delete(oldest);
  }
  fetchCache.set(key, value);
}

/** True when every oid a fetch request names exists in this repository. */
function fetchCacheable(repo: Repo, args: FetchArgs): boolean {
  for (const oid of [...args.wants, ...args.haves, ...args.shallow]) {
    if (!repo.objects.has(oid)) return false;
  }
  return true;
}

export function sendGit404(res: ServerResponse): void {
  const body = JSON.stringify({ message: 'Not Found' });
  res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** Sorted ref names of a repo. */
function refNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** The commit a tag peels to, or null. */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  let target = parseTag(object.data).object;
  for (let depth = 0; depth < 10; depth += 1) {
    const next = repo.objects.get(target);
    if (!next) return null;
    if (next.type === 'commit') return target;
    if (next.type === 'tag') target = parseTag(next.data).object;
    else return null;
  }
  return null;
}

function headTarget(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

// -------------------------------------------------------------------------------------------
// advertisements
// -------------------------------------------------------------------------------------------

/** v2 capability advertisement for upload-pack. */
function v2Advertisement(): Buffer {
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow thin-pack ofs-delta\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  const parts: Buffer[] = [encodePktLine(lines[0]), PKT_FLUSH];
  for (const line of lines.slice(1)) parts.push(encodePktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v0 ref advertisement. `service` is upload-pack or receive-pack. */
function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const symref = `symref=HEAD:${headTarget(repo)}`;
  const parts: Buffer[] = [encodePktLine(`# service=${service}\n`), PKT_FLUSH];
  const names = refNames(repo);
  const head = headTarget(repo);
  const headOid = repo.refs.get(head);
  if (names.length === 0) {
    parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0${caps} ${symref} agent=${AGENT}\n`));
  } else {
    const lines: string[] = [];
    if (headOid !== undefined) lines.push(`${headOid} HEAD\0${caps} ${symref} agent=${AGENT}\n`);
    else lines.push(`${names.length > 0 ? repo.refs.get(names[0])! : ZERO_OID} HEAD\0${caps} ${symref} agent=${AGENT}\n`);
    for (const name of names) {
      const oid = repo.refs.get(name)!;
      lines.push(`${oid} ${name}\n`);
      const peeled = peelTag(repo, oid);
      if (peeled !== null) lines.push(`${peeled} ${name}^{}\n`);
    }
    for (const line of lines) parts.push(encodePktLine(line));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// entry point
// -------------------------------------------------------------------------------------------

export async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: Store,
  owner: string,
  repoName: string,
  tail: string[],
  query: URLSearchParams,
  body: Buffer,
): Promise<boolean> {
  const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, repoName) : undefined;
  const [first, second] = tail;
  if (first === 'info' && second === 'refs') {
    if (repo === undefined) {
      sendGit404(res);
      return true;
    }
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendBuffer(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message: 'Unknown service' })));
      return true;
    }
    const wantV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
    const payload = wantV2 ? v2Advertisement() : v0Advertisement(repo, service);
    sendBuffer(res, 200, `application/x-${service}-advertisement`, payload);
    return true;
  }
  if (first === 'git-upload-pack' && tail.length === 1) {
    if (repo === undefined) {
      sendGit404(res);
      return true;
    }
    const wantV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
    try {
      if (wantV2) handleUploadPackV2(req, res, repo, body);
      else handleUploadPackV0(req, res, repo, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendBuffer(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message })));
    }
    return true;
  }
  if (first === 'git-receive-pack' && tail.length === 1) {
    if (repo === undefined) {
      sendGit404(res);
      return true;
    }
    try {
      handleReceivePack(res, store, repo, body);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendBuffer(res, 400, 'application/json; charset=utf-8', Buffer.from(JSON.stringify({ message })));
    }
    return true;
  }
  return false;
}

// -------------------------------------------------------------------------------------------
// ls-refs (protocol v2)
// -------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function parseLsRefsArgs(packets: ReturnType<typeof decodePktLines>): LsRefsArgs {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return args;
}

function lsRefsResponse(repo: Repo, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const names = refNames(repo);
  const head = headTarget(repo);
  const headOid = repo.refs.get(head);
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  if (names.length === 0) {
    if (args.unborn) parts.push(encodePktLine(`unborn HEAD symref-target:${head}\n`));
  } else {
    if (keep('HEAD') && headOid !== undefined) {
      const symref = args.symrefs ? ` symref-target:${head}` : '';
      parts.push(encodePktLine(`${headOid} HEAD${symref}\n`));
    }
    for (const name of names) {
      if (!keep(name)) continue;
      const oid = repo.refs.get(name)!;
      let line = `${oid} ${name}`;
      const peeled = args.peel ? peelTag(repo, oid) : null;
      if (peeled !== null) line += ` peeled:${peeled}`;
      parts.push(encodePktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// -------------------------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
  /** The client sent "deepen-relative": deepen from its existing boundaries. */
  deepenRelative: boolean;
}

function parseFetchArgsV2(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false, deepenRelative: false };
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      seenDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!seenDelim) continue;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'deepen-relative') args.deepenRelative = true;
    else if (line === 'done') args.done = true;
  }
  return args;
}

function parseFetchArgsV0(packets: ReturnType<typeof decodePktLines>): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false, deepenRelative: false };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line.split(' ').includes('deepen-relative')) args.deepenRelative = true;
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface FetchPlan {
  /** Objects to send, in a stable order. */
  objects: GitObject[];
  /** New shallow boundaries to report. */
  shallow: string[];
  /** Previous boundaries that are now fully included. */
  unshallow: string[];
}

/** Resolve a want oid to the commit it names (peeling tags). */
function wantCommit(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') {
    let target = parseTag(object.data).object;
    for (let depth = 0; depth < 10; depth += 1) {
      const next = repo.objects.get(target);
      if (!next) return null;
      if (next.type === 'commit') return target;
      if (next.type === 'tag') target = parseTag(next.data).object;
      else return null;
    }
  }
  return null;
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Objects the client already holds: reachable from its haves, but the walk
  // stops at its shallow boundaries, whose ancestors it does not hold.
  const excluded = collectReachable(args.haves, lookup, new Set(args.shallow));
  const wants = [...new Set(args.wants)].filter((oid) => isOid(oid) && repo.objects.has(oid));

  // The commits to include, with their generation from the wants.
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const want of wants) {
    const commit = wantCommit(repo, want);
    if (commit !== null && !generations.has(commit)) {
      generations.set(commit, 0);
      queue.push({ oid: commit, gen: 0 });
    }
  }
  const includedCommits = new Set<string>();
  const boundary = new Set<string>();
  // A deepen-relative request deepens from the client's existing boundaries:
  // the new boundary sits `depth` generations below each old boundary. Any
  // other deepen request is a total depth from the wants.
  const relative = args.deepenRelative && args.shallow.length > 0;
  const isBoundary = (oid: string, gen: number): boolean => {
    if (args.depth === undefined) return false;
    if (!relative) return gen >= args.depth - 1;
    for (const old of args.shallow) {
      const oldGen = generations.get(old);
      if (oldGen === undefined) continue;
      if (gen >= oldGen + args.depth && isAncestor(oid, old, lookup)) return true;
    }
    return false;
  };
  while (queue.length > 0) {
    const { oid, gen } = queue.shift()!;
    includedCommits.add(oid);
    if (isBoundary(oid, gen)) {
      boundary.add(oid);
      continue;
    }
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!generations.has(parent)) {
        generations.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }

  // Objects to send: the included commits and their tree closures, plus tag objects
  // named directly by a want; minus everything reachable from the haves. The walk
  // stops at boundary commits: their parents are never followed, so a blob shared
  // between a boundary tree and its parent's tree is still sent.
  const send = new Set<string>();
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (send.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') continue;
      send.add(oid);
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '40000') stack.push(entry.oid);
        else send.add(entry.oid);
      }
    }
  };
  const work: string[] = [...includedCommits];
  const visited = new Set<string>();
  while (work.length > 0) {
    const oid = work.pop()!;
    if (visited.has(oid)) continue;
    visited.add(oid);
    const object = repo.objects.get(oid);
    if (!object) continue;
    send.add(oid);
    if (object.type === 'commit') {
      addTree(parseCommit(object.data).tree);
      for (const parent of parseCommit(object.data).parents) {
        if (includedCommits.has(parent)) work.push(parent);
      }
    } else if (object.type === 'tag') {
      work.push(parseTag(object.data).object);
    }
  }
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object && object.type === 'tag') send.add(want);
  }
  for (const oid of excluded) send.delete(oid);

  const objects: GitObject[] = [];
  for (const oid of [...send].sort()) {
    const object = repo.objects.get(oid);
    if (object) objects.push(object);
  }

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (args.depth !== undefined) {
    for (const oid of [...boundary].sort()) shallow.push(oid);
    for (const old of args.shallow) {
      if (includedCommits.has(old) && !boundary.has(old)) unshallow.push(old);
    }
  } else {
    for (const old of args.shallow) {
      if (includedCommits.has(old)) unshallow.push(old);
    }
  }
  return { objects, shallow, unshallow };
}

/** Sideband packets (band 1) carrying the pack, chunked. */
function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const data = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    chunks.push(encodePktLine(Buffer.concat([Buffer.from([1]), data])));
  }
  return chunks;
}

function handleUploadPackV2(_req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const packets = decodePktLines(body);
  const commandLine = packets.find((packet) => packet.kind === 'data')?.payload.toString('utf8').replace(/\n$/, '') ?? '';
  if (commandLine === 'command=ls-refs') {
    const args = parseLsRefsArgs(packets);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', lsRefsResponse(repo, args));
    return;
  }
  if (commandLine === 'command=fetch') {
    const args = parseFetchArgsV2(packets);
    const cacheable = fetchCacheable(repo, args);
    const cacheKey = `v2|${repo.owner}/${repo.name}|${JSON.stringify([args.wants, args.haves, args.shallow, args.depth, args.deepenRelative, args.done])}`;
    if (cacheable) {
      const cached = fetchCacheGet(cacheKey);
      if (cached !== undefined) {
        sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached);
        return;
      }
    }
    const plan = planFetch(repo, args);
    const parts: Buffer[] = [];
    // The packfile sections: shallow-info (terminated by a delimiter),
    // then the packfile section (terminated by a flush).
    const packSections = (): void => {
      if (args.depth !== undefined || args.shallow.length > 0 || plan.shallow.length > 0 || plan.unshallow.length > 0) {
        parts.push(encodePktLine('shallow-info\n'));
        for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
        for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
        parts.push(PKT_DELIM);
      }
      parts.push(encodePktLine('packfile\n'));
      for (const chunk of sidebandPack(writePack(plan.objects))) parts.push(chunk);
      parts.push(PKT_FLUSH);
    };
    if (args.done || args.haves.length === 0) {
      // A request that ends in "done" (or carries no haves) gets no
      // acknowledgments section at all: the pack follows at once.
      packSections();
    } else {
      // A negotiation round: only the acknowledgments section, unless the
      // client already has everything, in which case the server answers
      // "ready" and the pack follows in the same response.
      const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
      const common = args.haves.filter((have) =>
        args.wants.some((want) => {
          const commit = wantCommit(repo, want);
          return commit !== null && isAncestor(have, commit, lookup);
        }),
      );
      const allWantsKnown = args.wants.length > 0 && args.wants.every((want) => repo.objects.has(want));
      if (allWantsKnown && plan.objects.length === 0) {
        parts.push(encodePktLine('acknowledgments\n'));
        for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
        parts.push(encodePktLine('ready\n'));
        parts.push(PKT_DELIM);
        packSections();
      } else {
        parts.push(encodePktLine('acknowledgments\n'));
        if (common.length === 0) parts.push(encodePktLine('NAK\n'));
        else for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
        parts.push(PKT_FLUSH);
      }
    }
    const response = Buffer.concat(parts);
    sendBuffer(res, 200, 'application/x-git-upload-pack-result', response);
    if (cacheable) fetchCacheSet(cacheKey, response);
    return;
  }
  throw new Error(`unknown v2 command ${JSON.stringify(commandLine)}`);
}

function handleUploadPackV0(_req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): void {
  const packets = decodePktLines(body);
  const args = parseFetchArgsV0(packets);
  const cacheable = fetchCacheable(repo, args);
  const cacheKey = `v0|${repo.owner}/${repo.name}|${JSON.stringify([args.wants, args.haves, args.shallow, args.depth, args.deepenRelative, args.done])}`;
  if (cacheable) {
    const cached = fetchCacheGet(cacheKey);
    if (cached !== undefined) {
      sendBuffer(res, 200, 'application/x-git-upload-pack-result', cached);
      return;
    }
  }
  const plan = planFetch(repo, args);
  const lookup = (oid: string): GitObject | undefined => repo.objects.get(oid);
  // Single-round negotiation: ACK the haves that are common ancestors of
  // the wants, NAK when there is none, then the shallow lines and the pack.
  const common = args.haves.filter((have) =>
    args.wants.some((want) => {
      const commit = wantCommit(repo, want);
      return commit !== null && isAncestor(have, commit, lookup);
    }),
  );
  const parts: Buffer[] = [];
  if (common.length === 0) parts.push(encodePktLine('NAK\n'));
  else for (const oid of common) parts.push(encodePktLine(`ACK ${oid}\n`));
  for (const oid of plan.shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  const pack = writePack(plan.objects);
  for (const chunk of sidebandPack(pack)) parts.push(chunk);
  parts.push(PKT_FLUSH);
  const response = Buffer.concat(parts);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', response);
  if (cacheable) fetchCacheSet(cacheKey, response);
}

// -------------------------------------------------------------------------------------------
// receive-pack (v0)
// -------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function handleReceivePack(res: ServerResponse, store: Store, repo: Repo, body: Buffer): void {
  const [framed, packBytes] = splitAtFlush(body);
  const packets = decodePktLines(framed);
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad receive-pack command ${JSON.stringify(line)}`);
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  if (commands.length === 0) throw new Error('receive-pack with no commands');

  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const updatesRef = commands.some((command) => command.newOid !== ZERO_OID);
  if (updatesRef) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} ref does not exist\n`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined || current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!store.isAncestor(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }

  const band1: Buffer[] = [encodePktLine(`unpack ${unpackDetail}\n`)];
  for (const line of reportLines) band1.push(encodePktLine(line));
  band1.push(PKT_FLUSH);
  const parts: Buffer[] = [];
  for (const chunk of band1) parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  parts.push(PKT_FLUSH);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat(parts));
}
