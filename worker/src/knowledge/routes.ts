// /k/ routes (docs/KNOWLEDGE.md, "Routes"), spread into ROUTES in
// src/index.ts. Each body has an explicit size limit, so JSON.parse never
// sees more than the route needs.

import type { Scope } from "../auth";
import type { Env } from "../check";
import { json, readJson } from "../http";
import { commitBlob, getBlob, hasBlobs, putBlob } from "./blobs";
import { getBundle, registerBundle } from "./bundles";
import { claimJobs, completeJob, createJob, heartbeatJob, listJobs } from "./jobs";
import { listCapabilities, runModel } from "./models";
import { getDomainPolicy, lookupDerivations, lookupFetches, lookupVerdicts, postDerivations, postVerdicts, putDomainPolicy, upsertFetches } from "./records";

type Handler = (req: Request, env: Env, url: URL, params: string[], ctx: ExecutionContext, scope: Scope) => Promise<Response>;

interface KnowledgeRoute {
  method: "GET" | "POST" | "PUT";
  path: RegExp;
  scopes: Scope[];
  handler: Handler;
}

const KB = 1024;
const body = (req: Request, kib: number) => readJson<Record<string, unknown>>(req, kib * KB);
const ok = (p: Promise<unknown>) => p.then((data) => json(data));
const K: Scope[] = ["kworker"];

export const KNOWLEDGE_ROUTES: KnowledgeRoute[] = [
  { method: "PUT", path: /^\/k\/blobs\/([^/]+)$/, scopes: K, handler: (req, env, _u, [sha]) => putBlob(env, req, sha) },
  { method: "GET", path: /^\/k\/blobs\/([^/]+)$/, scopes: K, handler: (req, env, _u, [sha]) => getBlob(env, req, sha) },
  { method: "POST", path: /^\/k\/blobs\/commit$/, scopes: K, handler: async (req, env) => commitBlob(env, await body(req, 4)) },
  { method: "POST", path: /^\/k\/blobs\/has$/, scopes: K, handler: async (req, env) => ok(hasBlobs(env, await body(req, 16))) },
  { method: "POST", path: /^\/k\/fetches\/lookup$/, scopes: K, handler: async (req, env) => ok(lookupFetches(env, await body(req, 16))) },
  { method: "POST", path: /^\/k\/fetches$/, scopes: K, handler: async (req, env) => ok(upsertFetches(env, await body(req, 512))) },
  { method: "POST", path: /^\/k\/derivations\/lookup$/, scopes: K, handler: async (req, env) => ok(lookupDerivations(env, await body(req, 32))) },
  { method: "POST", path: /^\/k\/derivations$/, scopes: K, handler: async (req, env) => ok(postDerivations(env, await body(req, 64))) },
  { method: "POST", path: /^\/k\/verdicts\/lookup$/, scopes: K, handler: async (req, env) => ok(lookupVerdicts(env, await body(req, 128))) },
  { method: "POST", path: /^\/k\/verdicts$/, scopes: K, handler: async (req, env) => ok(postVerdicts(env, await body(req, 512))) },
  { method: "POST", path: /^\/k\/jobs$/, scopes: K, handler: async (req, env) => createJob(env, await body(req, 48)) },
  { method: "GET", path: /^\/k\/jobs$/, scopes: K, handler: (_r, env, url) => ok(listJobs(env, url)) },
  { method: "POST", path: /^\/k\/jobs\/claim$/, scopes: K, handler: async (req, env) => ok(claimJobs(env, await body(req, 4))) },
  { method: "POST", path: /^\/k\/jobs\/([^/]+)\/heartbeat$/, scopes: K, handler: async (req, env, _u, [id]) => ok(heartbeatJob(env, id, await body(req, 4))) },
  { method: "POST", path: /^\/k\/jobs\/([^/]+)\/complete$/, scopes: K, handler: async (req, env, _u, [id]) => ok(completeJob(env, id, await body(req, 48))) },
  { method: "POST", path: /^\/k\/bundles$/, scopes: K, handler: async (req, env) => registerBundle(env, await body(req, 160)) },
  { method: "GET", path: /^\/k\/bundles\/([^/]+)$/, scopes: K, handler: (_r, env, _u, [id]) => ok(getBundle(env, id)) },
  { method: "GET", path: /^\/k\/capabilities$/, scopes: K, handler: (_r, env, url) => ok(listCapabilities(env, url)) },
  { method: "POST", path: /^\/k\/model\/run$/, scopes: K, handler: async (req, env) => ok(runModel(env, await body(req, 128))) },
  { method: "GET", path: /^\/k\/domain-policy$/, scopes: K, handler: (_r, env, url) => ok(getDomainPolicy(env, url)) },
  { method: "POST", path: /^\/k\/domain-policy$/, scopes: K, handler: async (req, env) => ok(putDomainPolicy(env, await body(req, 4))) },
];
