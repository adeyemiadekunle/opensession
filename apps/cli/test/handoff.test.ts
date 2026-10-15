import { describe, expect, it } from "vitest";
import type { GitInfo, Project } from "@opensession/api-client";
import { type CloudProjects, type Git, handoffToCloud, handoffToLocal, parseGithubRepo } from "../src/handoff";

/** A scripted git: answers by command prefix, records every call. */
function fakeGit(answers: Record<string, string | Error>) {
  const calls: string[] = [];
  const git: Git = async (args) => {
    const cmd = args.join(" ");
    calls.push(cmd);
    const key = Object.keys(answers)
      .filter((k) => cmd.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    const a = key === undefined ? "" : answers[key]!;
    if (a instanceof Error) throw a;
    return a;
  };
  return { git, calls };
}

const LOCAL = {
  "rev-parse --show-toplevel": "/src/app",
  "config --get remote.origin.url": "git@github.com:alice-gh/app.git",
  "rev-parse --abbrev-ref HEAD": "feature/login",
  "status --porcelain": "",
  "rev-parse --short HEAD": "abc1234",
};

function fakeCloud(projects: Project[], git: Partial<GitInfo> = {}) {
  const calls: string[] = [];
  const cloud: CloudProjects = {
    listProjects: async () => projects,
    createProject: async (o) => {
      calls.push(`create ${o.name} ${o.repo} ${o.branch}`);
      const p = { id: o.name, name: o.name, repo: o.repo ?? null, branch: o.branch ?? null, cloned: false } as Project;
      projects.push(p);
      return p;
    },
    withWorkspace: (id) => ({
      gitInfo: async () => ({ branch: "agent/fix", default_branch: "main", status: [], branches: [], repo: "alice-gh/app", can_push: true, ...git }) as GitInfo,
      gitPull: async (b) => (calls.push(`${id} pull ${b}`), { head: "abc1234" }),
      gitCommit: async (m) => (calls.push(`${id} commit ${m}`), { committed: true, head: "fff0000" }),
      gitPush: async (b) => (calls.push(`${id} push ${b}`), { repo: "alice-gh/app", branch: b ?? "" }),
    }),
  };
  return { cloud, calls };
}

const project = (id: string, repo: string | null): Project => ({ id, name: id, repo, branch: "main", cloned: true }) as Project;

describe("parseGithubRepo", () => {
  it("reads https, ssh and scp-style remotes", () => {
    expect(parseGithubRepo("https://github.com/alice-gh/app.git")).toBe("alice-gh/app");
    expect(parseGithubRepo("https://token@github.com/alice-gh/app")).toBe("alice-gh/app");
    expect(parseGithubRepo("git@github.com:alice-gh/my.app.git")).toBe("alice-gh/my.app");
    expect(parseGithubRepo("ssh://git@github.com/alice-gh/app.git")).toBe("alice-gh/app");
    expect(parseGithubRepo("https://gitlab.com/alice/app.git")).toBeNull();
  });
});

describe("handoffToCloud", () => {
  it("pushes the branch and pulls it into the project for the same repo", async () => {
    const { git, calls } = fakeGit(LOCAL);
    const c = fakeCloud([project("other", "alice-gh/other"), project("app", "Alice-GH/App")]);
    const r = await handoffToCloud(c.cloud, git, "/src/app/sub");
    expect(r).toEqual({ project: "app", repo: "alice-gh/app", branch: "feature/login", head: "abc1234", created: false });
    expect(calls).toContain("push -q -u origin feature/login");
    expect(c.calls).toEqual(["app pull feature/login"]);
  });

  it("creates the project when none is linked, and commits only when asked", async () => {
    const dirty = { ...LOCAL, "status --porcelain": " M a.ts" };
    await expect(handoffToCloud(fakeCloud([]).cloud, fakeGit(dirty).git, "/src/app")).rejects.toThrow(/uncommitted changes/);

    const { git, calls } = fakeGit(dirty);
    const c = fakeCloud([]);
    const r = await handoffToCloud(c.cloud, git, "/src/app", { commit: "wip: login" });
    expect(calls).toEqual(expect.arrayContaining(["add -A", "commit -q -m wip: login"]));
    expect(calls.indexOf("commit -q -m wip: login")).toBeLessThan(calls.indexOf("push -q -u origin feature/login"));
    expect(r.created).toBe(true);
    expect(c.calls).toEqual(["create app alice-gh/app feature/login", "app pull feature/login"]);
  });

  it("refuses a project linked to another repo, and non-GitHub folders", async () => {
    const c = fakeCloud([project("app", "alice-gh/other")]);
    await expect(handoffToCloud(c.cloud, fakeGit(LOCAL).git, "/src/app", { project: "app" })).rejects.toThrow(/linked to alice-gh\/other/);
    const gitlab = fakeGit({ ...LOCAL, "config --get remote.origin.url": "https://gitlab.com/a/b.git" });
    await expect(handoffToCloud(c.cloud, gitlab.git, "/src/app")).rejects.toThrow(/not a GitHub repository/);
    const detached = fakeGit({ ...LOCAL, "rev-parse --abbrev-ref HEAD": "HEAD" });
    await expect(handoffToCloud(c.cloud, detached.git, "/src/app")).rejects.toThrow(/not on a branch/);
  });
});

describe("handoffToLocal", () => {
  it("pushes the cloud branch and checks it out here", async () => {
    const { git, calls } = fakeGit({ ...LOCAL, "rev-parse --verify --quiet": new Error("no such branch") });
    const c = fakeCloud([project("app", "alice-gh/app")]);
    const r = await handoffToLocal(c.cloud, git, "/src/app");
    expect(r).toEqual({ project: "app", repo: "alice-gh/app", branch: "agent/fix", head: "abc1234" });
    expect(c.calls).toEqual(["app push agent/fix"]);
    expect(calls).toEqual(expect.arrayContaining([
      "fetch -q origin +refs/heads/agent/fix:refs/remotes/origin/agent/fix",
      "checkout -q -b agent/fix --track origin/agent/fix",
    ]));
  });

  it("fast-forwards an existing branch and commits cloud changes only when asked", async () => {
    const changed = { status: [{ file: "a.ts", additions: 1, deletions: 0, status: "modified" }] } as Partial<GitInfo>;
    const c = fakeCloud([project("app", "alice-gh/app")], changed);
    await expect(handoffToLocal(c.cloud, fakeGit(LOCAL).git, "/src/app")).rejects.toThrow(/1 uncommitted change/);

    const { git, calls } = fakeGit(LOCAL);
    await handoffToLocal(c.cloud, git, "/src/app", { commit: "agent: fix login" });
    expect(c.calls).toEqual(["app commit agent: fix login", "app push agent/fix"]);
    expect(calls).toEqual(expect.arrayContaining(["checkout -q agent/fix", "merge -q --ff-only origin/agent/fix"]));
  });

  it("never touches a folder with local changes", async () => {
    const { git, calls } = fakeGit({ ...LOCAL, "status --porcelain": "?? new.ts" });
    const c = fakeCloud([project("app", "alice-gh/app")]);
    await expect(handoffToLocal(c.cloud, git, "/src/app")).rejects.toThrow(/commit or stash/);
    expect(c.calls).toEqual([]);
    expect(calls.some((x) => x.startsWith("fetch") || x.startsWith("checkout"))).toBe(false);
  });
});
