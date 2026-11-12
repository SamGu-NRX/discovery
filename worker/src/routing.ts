// Routing a thought Sam speaks or types to an agent, model and effort
// (docs/APPROVALS.md, "Wire details" 10 to 12; the Nod app's README,
// "Routing"). The Worker picks a routing when the item is filed; the app
// shows it as chips, Sam corrects it with POST /inbox/:id/route, and POST
// /inbox/:id/dispatch files it in the mailbox for that agent.
//
// Deterministic, from D1 and the text, no model call: "Opus high, refactor
// the reel exporter" names the model and effort at the start (source
// spoken); otherwise the routing table's rule for the item's kind and
// project decides (source table).

import type { Env } from "./check";
import { fail, isoUtc, readJson } from "./http";
import { MailRefusal, send } from "./mailbox";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];
// The kinds a routing can name: what a device may post.
export const ROUTED_KINDS = ["thought", "direction", "task", "reply"] as const;
type Kind = (typeof ROUTED_KINDS)[number];
const SETTING = "routing_table";

export interface Routing {
  agent: string;
  model: string;
  effort: Effort;
  project: string | null;
  kind: Kind;
}

interface Model {
  id: string;
  label: string;
  // Words that name this model at the start of a spoken thought.
  aliases: string[];
  efforts: Effort[];
}

export interface RoutingTable {
  // Each agent is a mailbox agent that sam may send to; dispatch files the
  // task there. Models are what the agent's host can run; the Worker passes
  // the choice on in the task, it can't switch a host's model itself.
  agents: { id: string; label: string; models: Model[] }[];
  projects: { name: string; keywords: string[] }[];
  // First match wins; the last rule must match everything.
  rules: { when: { kind?: Kind; project?: string }; agent: string; model: string; effort: Effort }[];
}

// First guesses with no traffic behind them: model ids are the short names
// the Nod app shows (NodKit RoutingChips, ModelName.known), the lineup in
// Sam's model-selection policy. Replace with POST /admin/routing.
const ALL: Effort[] = [...EFFORTS];
export const DEFAULT_TABLE: RoutingTable = {
  agents: [
    {
      id: "t3",
      label: "T3 Code",
      models: [
        { id: "opus", label: "Claude Opus 5.5", aliases: ["opus"], efforts: ALL },
        { id: "sonnet", label: "Claude Sonnet 5.5", aliases: ["sonnet"], efforts: ALL },
        { id: "haiku", label: "Claude Haiku 5.5", aliases: ["haiku"], efforts: ALL },
        { id: "fable", label: "Claude Fable 5.2", aliases: ["fable"], efforts: ALL },
        { id: "sol", label: "GPT-6.1 Sol", aliases: ["sol"], efforts: ALL },
        { id: "astra", label: "GPT-6 Astra", aliases: ["astra"], efforts: ALL },
        { id: "luna", label: "GPT-6 Luna", aliases: ["luna"], efforts: ALL },
      ],
    },
    // The dot runs whatever ChatGPT selects; effort is a hint in the task.
    { id: "dot", label: "The dot", models: [{ id: "chatgpt", label: "ChatGPT", aliases: ["chatgpt", "dot"], efforts: ALL }] },
  ],
  projects: [
    { name: "discovery", keywords: ["discovery", "worker", "mailbox", "approvals"] },
    { name: "nod", keywords: ["nod"] },
  ],
  rules: [
    { when: { kind: "task" }, agent: "t3", model: "opus", effort: "high" },
    { when: { kind: "direction" }, agent: "t3", model: "opus", effort: "high" },
    { when: {}, agent: "dot", model: "chatgpt", effort: "medium" },
  ],
};

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

// Strict, because a bad table would route every thought wrong. Errors name
// the field.
export function validateTable(v: unknown): RoutingTable {
  if (typeof v !== "object" || v === null || Array.isArray(v)) fail("the routing table must be an object");
  const t = v as Record<string, unknown>;
  for (const k of Object.keys(t)) if (!["agents", "projects", "rules"].includes(k)) fail(`${k} is not a routing table field (allowed: agents, projects, rules)`);
  if (!Array.isArray(t.agents) || t.agents.length === 0 || t.agents.length > 10) fail("agents must be an array of 1 to 10 agents");
  const aliases = new Set<string>();
  const agents = t.agents.map((a, i) => {
    const at = `agents[${i}]`;
    if (typeof a !== "object" || a === null) fail(`${at} must be an object`);
    const x = a as Record<string, unknown>;
    if (x.id !== "t3" && x.id !== "dot") fail(`${at}.id must be a mailbox agent Sam may send to: t3 or dot`);
    if (typeof x.label !== "string" || !x.label || x.label.length > 40) fail(`${at}.label must be 1 to 40 characters`);
    if (!Array.isArray(x.models) || x.models.length === 0 || x.models.length > 20) fail(`${at}.models must be an array of 1 to 20 models`);
    const models = x.models.map((m, j) => {
      const mat = `${at}.models[${j}]`;
      if (typeof m !== "object" || m === null) fail(`${mat} must be an object`);
      const y = m as Record<string, unknown>;
      if (typeof y.id !== "string" || !NAME.test(y.id)) fail(`${mat}.id must be a lowercase name`);
      if (typeof y.label !== "string" || !y.label || y.label.length > 40) fail(`${mat}.label must be 1 to 40 characters`);
      if (!Array.isArray(y.aliases) || !y.aliases.every((w) => typeof w === "string" && /^[a-z0-9]{2,20}$/.test(w))) fail(`${mat}.aliases must be lowercase single words`);
      for (const w of y.aliases as string[]) {
        if (aliases.has(w)) fail(`${mat}.aliases repeats ${w}, which already names another model`);
        aliases.add(w);
      }
      if (!Array.isArray(y.efforts) || y.efforts.length === 0 || !y.efforts.every((e) => EFFORTS.includes(e as Effort))) fail(`${mat}.efforts must list some of ${EFFORTS.join("|")}`);
      return { id: y.id, label: y.label, aliases: y.aliases as string[], efforts: y.efforts as Effort[] };
    });
    return { id: x.id as string, label: x.label, models };
  });
  if (!Array.isArray(t.projects) || t.projects.length > 50) fail("projects must be an array of at most 50");
  const projects = t.projects.map((p, i) => {
    const x = p as Record<string, unknown>;
    if (typeof x?.name !== "string" || !NAME.test(x.name)) fail(`projects[${i}].name must be a lowercase name`);
    if (!Array.isArray(x.keywords) || !x.keywords.every((w) => typeof w === "string" && /^[a-z0-9-]{2,40}$/.test(w))) fail(`projects[${i}].keywords must be lowercase words`);
    return { name: x.name, keywords: x.keywords as string[] };
  });
  if (!Array.isArray(t.rules) || t.rules.length === 0 || t.rules.length > 50) fail("rules must be an array of 1 to 50 rules");
  const rules = t.rules.map((r, i) => {
    const at = `rules[${i}]`;
    const x = r as Record<string, unknown>;
    const when = (x?.when ?? {}) as Record<string, unknown>;
    if (when.kind !== undefined && !ROUTED_KINDS.includes(when.kind as Kind)) fail(`${at}.when.kind must be one of ${ROUTED_KINDS.join("|")}`);
    if (when.project !== undefined && !projects.some((p) => p.name === when.project)) fail(`${at}.when.project must name a project in projects`);
    const model = agents.find((a) => a.id === x.agent)?.models.find((m) => m.id === x.model);
    if (!model) fail(`${at} must name an agent and one of its models`);
    if (!model.efforts.includes(x.effort as Effort)) fail(`${at}.effort must be one ${x.model} offers`);
    return { when: { ...(when.kind ? { kind: when.kind as Kind } : {}), ...(when.project ? { project: when.project as string } : {}) }, agent: x.agent as string, model: x.model as string, effort: x.effort as Effort };
  });
  const last = rules[rules.length - 1];
  if (last.when.kind || last.when.project) fail("the last rule must match everything (an empty when)");
  return { agents, projects, rules };
}

export async function loadTable(env: Env): Promise<RoutingTable> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(SETTING).first<{ value: string }>();
  return row ? (JSON.parse(row.value) as RoutingTable) : DEFAULT_TABLE;
}

export async function setTable(env: Env, req: Request) {
  const table = validateTable(await readJson(req, 32 * 1024));
  await env.DB.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (key) DO UPDATE SET value = ?2, updated_at = ?3`)
    .bind(SETTING, JSON.stringify(table), Date.now())
    .run();
  return table;
}

// GET /routing/models: what the app may offer in its chips.
export async function publishTable(env: Env) {
  const t = await loadTable(env);
  return { efforts: EFFORTS, kinds: ROUTED_KINDS, agents: t.agents, projects: t.projects, rules: t.rules };
}

// Words between a spoken model and effort that change nothing ("Opus at high
// effort", "use Sol on max").
const FILLER = new Set(["use", "using", "on", "at", "with", "and", "effort", "thinking", "claude", "gpt", "model", "please"]);
const EFFORT_WORDS: Record<string, Effort> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", maximum: "max" };

// The model and effort named at the very start of the text, segment by
// segment ("Opus high, refactor…", "Opus, high. Refactor…"). Every word of a
// segment must be a model alias, an effort, "extra high" or filler, so
// "High time we fixed it" names nothing.
export function spokenRouting(text: string, table: RoutingTable): { agent?: string; model?: Model; effort?: Effort } | null {
  let model: { agent: string; model: Model } | null = null;
  let effort: Effort | undefined;
  const segments = text.slice(0, 120).split(/[,.:;!?\n—–]/);
  for (const segment of segments.slice(0, 3)) {
    const words = segment.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (words.length === 0 || words.length > 6) break;
    // Kept only if every word of the segment is recognized.
    let segModel: { agent: string; model: Model } | null = null;
    let segEffort: Effort | undefined;
    let ok = true;
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[^a-z0-9]/g, "");
      if (w === "extra" && words[i + 1]?.replace(/[^a-z]/g, "") === "high") {
        segEffort = "xhigh";
        i++;
        continue;
      }
      if (EFFORT_WORDS[w]) {
        segEffort = EFFORT_WORDS[w];
        continue;
      }
      const found = table.agents.flatMap((a) => a.models.map((m) => ({ agent: a.id, model: m }))).find((x) => x.model.aliases.includes(w));
      if (found) {
        segModel = found;
        continue;
      }
      if (FILLER.has(w)) continue;
      ok = false;
      break;
    }
    if (!ok || (!segModel && !segEffort)) break;
    model = segModel ?? model;
    effort = segEffort ?? effort;
  }
  if (!model && !effort) return null;
  return { ...(model ?? {}), effort };
}

function projectOf(text: string, table: RoutingTable): string | null {
  const words = new Set(text.toLowerCase().split(/[^a-z0-9-]+/).filter(Boolean));
  return table.projects.find((p) => p.keywords.some((k) => words.has(k)))?.name ?? null;
}

export function chooseRouting(text: string, kind: Kind, table: RoutingTable): { routing: Routing; source: "spoken" | "table" } {
  const project = projectOf(text, table);
  const rule = table.rules.find((r) => (!r.when.kind || r.when.kind === kind) && (!r.when.project || r.when.project === project))!;
  const spoken = spokenRouting(text, table);
  if (!spoken) return { routing: { agent: rule.agent, model: rule.model, effort: rule.effort, project, kind }, source: "table" };
  // A spoken model brings its agent; a spoken effort alone keeps the rule's
  // model, and is kept only if that model offers it.
  if (spoken.model && spoken.agent) {
    const effort = spoken.effort && spoken.model.efforts.includes(spoken.effort) ? spoken.effort : spoken.model.efforts.includes(rule.effort) ? rule.effort : spoken.model.efforts[0];
    return { routing: { agent: spoken.agent, model: spoken.model.id, effort, project, kind }, source: "spoken" };
  }
  const ruleModel = table.agents.find((a) => a.id === rule.agent)!.models.find((m) => m.id === rule.model)!;
  const effort = spoken.effort && ruleModel.efforts.includes(spoken.effort) ? spoken.effort : rule.effort;
  return { routing: { agent: rule.agent, model: rule.model, effort, project, kind }, source: "spoken" };
}

// The app's Routing.source has two values. A correction Sam made is his
// choice as much as a spoken one, so it reads as spoken.
export const wireRouting = (json: string | null, source: string | null) =>
  json ? { ...(JSON.parse(json) as Routing), source: source === "table" ? "table" : "spoken" } : null;

// ---- POST /inbox/:id/route and /dispatch ----

interface InboxRow {
  id: string;
  kind: string;
  text: string;
  source: string;
  routing_json: string | null;
  routing_source: string | null;
  dispatched_at: number | null;
  dispatch_task_id: string | null;
}

// Coded refusals: the app reads { error: <code>, message } (NodKit
// WorkerClient.check).
const refuse = (status: number, code: string, message: string) => new MailRefusal(status, code, message);

async function routableItem(env: Env, id: string): Promise<InboxRow> {
  const row = await env.DB.prepare("SELECT * FROM inbox_items WHERE id = ?").bind(id).first<InboxRow>();
  if (!row) throw refuse(404, "inbox_item_not_found", `Inbox item ${id} does not exist.`);
  if (!row.source.startsWith("device:")) throw refuse(409, "not_routable", `Inbox item ${id} came from ${row.source}; only what Sam posts from his phone is routed.`);
  if (row.dispatched_at !== null) throw refuse(409, "already_dispatched", `Inbox item ${id} was sent to its agent at ${isoUtc(row.dispatched_at)}.`);
  return row;
}

export async function correctRouting(env: Env, id: string, req: Request) {
  const b = await readJson<Record<string, unknown>>(req, 4096);
  for (const k of Object.keys(b)) if (!["agent", "model", "effort", "project", "kind"].includes(k)) fail(`${k} is not a routing field (allowed: agent, model, effort, project, kind)`);
  await routableItem(env, id);
  const table = await loadTable(env);
  const agent = table.agents.find((a) => a.id === b.agent);
  if (!agent) fail(`agent must be one of ${table.agents.map((a) => a.id).join("|")}`);
  const model = agent.models.find((m) => m.id === b.model);
  if (!model) fail(`model must be one of ${agent.id}'s models: ${agent.models.map((m) => m.id).join("|")}`);
  if (!model.efforts.includes(b.effort as Effort)) fail(`effort must be one of ${model.efforts.join("|")} for ${model.id}`);
  if (b.project !== null && (typeof b.project !== "string" || !NAME.test(b.project))) fail("project must be a lowercase project name or null");
  if (!ROUTED_KINDS.includes(b.kind as Kind)) fail(`kind must be one of ${ROUTED_KINDS.join("|")}`);
  const routing: Routing = { agent: agent.id, model: model.id, effort: b.effort as Effort, project: b.project as string | null, kind: b.kind as Kind };
  // Only while not dispatched, checked in the write itself.
  const row = await env.DB.prepare(
    `UPDATE inbox_items SET routing_json = ?2, routing_source = 'person', routed_at = ?3 WHERE id = ?1 AND dispatched_at IS NULL RETURNING routing_json, routing_source`,
  )
    .bind(id, JSON.stringify(routing), Date.now())
    .first<{ routing_json: string; routing_source: string }>();
  if (!row) throw refuse(409, "already_dispatched", `Inbox item ${id} was sent to its agent while this correction was made.`);
  return { routing: wireRouting(row.routing_json, row.routing_source) };
}

// Files the item in the mailbox from sam to its routing's agent. The
// mailbox key is the item id, so two dispatches can't make two tasks; the
// conditional UPDATE then lets one of them succeed and the other gets 409.
export async function dispatch(env: Env, ctx: ExecutionContext, id: string) {
  const item = await routableItem(env, id);
  const routing = wireRouting(item.routing_json, item.routing_source);
  if (!routing) throw refuse(409, "not_routed", `Inbox item ${id} has no routing; set one with POST /inbox/${id}/route first.`);
  const header = `From Sam's iPhone (inbox item ${id}, ${routing.kind}${routing.project ? `, project ${routing.project}` : ""}). Sam's routing: model ${routing.model}, effort ${routing.effort}.`;
  const sent = await send(env, ctx, "sam", { to: routing.agent, body: `${header}\n\n${item.text}`, idempotency_key: `inbox-${id}` });
  const now = Date.now();
  const row = await env.DB.prepare("UPDATE inbox_items SET dispatched_at = ?2, dispatch_task_id = ?3 WHERE id = ?1 AND dispatched_at IS NULL RETURNING dispatched_at")
    .bind(id, now, sent.body.task_id)
    .first<{ dispatched_at: number }>();
  if (!row) throw refuse(409, "already_dispatched", `Inbox item ${id} was sent to its agent by another call.`);
  console.log(`[routing] dispatched ${id} to ${routing.agent} as ${sent.body.task_id}`);
  return { inbox_id: id, task_id: sent.body.task_id, agent: routing.agent, dispatched_at: isoUtc(row.dispatched_at) };
}

