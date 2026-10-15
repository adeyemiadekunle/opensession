import { execFile } from "node:child_process";
import type { GitInfo, Project } from "@opensession/api-client";

/** Runs git in a folder and returns trimmed stdout; throws with git's message on failure. */
export type Git = (args: string[], cwd: string) => Promise<string>;

export const systemGit: Git = (args, cwd) =>
  new Promise((res, rej) =>
    execFile("git", args, { cwd, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? rej(new Error(`git ${args[0]}: ${(stderr || err.message).trim()}`)) : res(stdout.trim()),
    ),
  );

/** The parts of CloudClient a handoff needs (CloudClient satisfies both). */
export interface ProjectGit {
  gitInfo(): Promise<GitInfo>;
  gitPull(branch: string): Promise<{ head: string }>;
  gitCommit(message: string): Promise<{ committed: boolean; head: string | null }>;
  gitPush(branch?: string): Promise<{ repo: string; branch: string }>;
}
export interface CloudProjects {
  listProjects(): Promise<Project[]>;
  createProject(o: { name: string; repo?: string; branch?: string }): Promise<Project>;
  withWorkspace(id: string): ProjectGit;
}

/** "owner/name" for a GitHub remote URL (https, ssh or scp-style), else null. */
export function parseGithubRepo(url: string): string | null {
  const m = url.trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

const sameRepo = (a?: string | null, b?: string | null) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

interface LocalRepo {
  root: string;
  repo: string;
  branch: string;
  dirty: boolean;
}

async function localRepo(git: Git, dir: string): Promise<LocalRepo> {
  let root: string;
  try {
    root = await git(["rev-parse", "--show-toplevel"], dir);
  } catch {
    throw new Error(`${dir} is not a git repository`);
  }
  // The configured URL, not `remote get-url`, which applies the user's url.*.insteadOf rewrites.
  const remote = await git(["config", "--get", "remote.origin.url"], root).catch(() => "");
  const repo = parseGithubRepo(remote);
  if (!repo) throw new Error(`this folder's "origin" remote is not a GitHub repository${remote ? ` (${remote})` : ""}`);
  const branch = await git(["rev-parse", "--abbrev-ref", "HEAD"], root);
  if (!branch || branch === "HEAD") throw new Error("not on a branch: check out a branch first");
  const dirty = (await git(["status", "--porcelain"], root)) !== "";
  return { root, repo, branch, dirty };
}

/** The cloud project for a repository: the one given, else one linked to the repo. */
async function findProject(cloud: CloudProjects, repo: string, id?: string): Promise<Project | undefined> {
  const all = await cloud.listProjects();
  if (id) {
    const p = all.find((x) => x.id === id);
    if (!p) throw new Error(`no cloud project ${id}`);
    if (!sameRepo(p.repo, repo)) throw new Error(`project ${id} is linked to ${p.repo ?? "no repository"}, not ${repo}`);
    return p;
  }
  return all.find((x) => sameRepo(x.repo, repo));
}

export interface HandoffResult {
  project: string;
  repo: string;
  branch: string;
  head: string;
  created?: boolean;
}

/**
 * Continue in the cloud: push this folder's branch to GitHub (with your own git
 * credentials), then bring it into the cloud project for the same repository,
 * creating the project if there is none.
 */
export async function handoffToCloud(
  cloud: CloudProjects,
  git: Git,
  dir: string,
  o: { project?: string; commit?: string; log?: (s: string) => void } = {},
): Promise<HandoffResult> {
  const log = o.log ?? (() => undefined);
  const here = await localRepo(git, dir);
  if (here.dirty) {
    if (!o.commit) throw new Error("this folder has uncommitted changes: commit them, or pass --commit <message>");
    await git(["add", "-A"], here.root);
    await git(["commit", "-q", "-m", o.commit], here.root);
    log(`committed local changes on ${here.branch}`);
  }
  log(`pushing ${here.branch} to ${here.repo}`);
  await git(["push", "-q", "-u", "origin", here.branch], here.root);

  let project = await findProject(cloud, here.repo, o.project);
  let created = false;
  if (!project) {
    const name = here.repo.split("/")[1]!;
    project = await cloud.createProject({ name, repo: here.repo, branch: here.branch });
    created = true;
    log(`created cloud project ${project.id}`);
  }
  const r = await cloud.withWorkspace(project.id).gitPull(here.branch);
  return { project: project.id, repo: here.repo, branch: here.branch, head: r.head, created };
}

/**
 * Continue on this computer: commit the cloud project's work (if asked), push its
 * branch to GitHub, then check that branch out here. Fast-forward only, and refused
 * while this folder has uncommitted changes.
 */
export async function handoffToLocal(
  cloud: CloudProjects,
  git: Git,
  dir: string,
  o: { project?: string; commit?: string; log?: (s: string) => void } = {},
): Promise<HandoffResult> {
  const log = o.log ?? (() => undefined);
  const here = await localRepo(git, dir);
  if (here.dirty) throw new Error("this folder has uncommitted changes: commit or stash them first");
  const project = await findProject(cloud, here.repo, o.project);
  if (!project) throw new Error(`no cloud project is linked to ${here.repo} (pass -p <project>)`);
  const pc = cloud.withWorkspace(project.id);
  const info = await pc.gitInfo();
  const branch = info.branch;
  if (!branch) throw new Error(`the cloud project ${project.id} is not on a branch`);
  if (info.status.length) {
    if (!o.commit) throw new Error(`the cloud project has ${info.status.length} uncommitted change(s): pass --commit <message> to commit them`);
    await pc.gitCommit(o.commit);
    log(`committed the cloud project's changes on ${branch}`);
  }
  log(`pushing ${branch} from the cloud to ${here.repo}`);
  await pc.gitPush(branch);

  await git(["fetch", "-q", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], here.root);
  const exists = await git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], here.root).then(
    () => true,
    () => false,
  );
  if (exists) {
    await git(["checkout", "-q", branch], here.root);
    await git(["merge", "-q", "--ff-only", `origin/${branch}`], here.root);
  } else {
    await git(["checkout", "-q", "-b", branch, "--track", `origin/${branch}`], here.root);
  }
  const head = await git(["rev-parse", "--short", "HEAD"], here.root);
  return { project: project.id, repo: here.repo, branch, head };
}
