import { REVIEW_MARKER } from "../review/report.js";

function normalizeDirPath(path: string): string {
  return path.replace(/^\/+/, "").replace(/\/+$/, "");
}

export interface ReviewCommentDetail {
  id: number;
  body: string;
  path: string | null;
  line: number | null;
  user: { login: string; type?: string };
  inReplyToId?: number;
}

function toReviewCommentDetail(c: any): ReviewCommentDetail {
  return {
    id: Number(c?.id ?? 0),
    body: String(c?.body ?? ""),
    path: c?.path ?? null,
    line: typeof c?.line === "number" ? c.line : null,
    user: { login: String(c?.user?.login ?? ""), ...(c?.user?.type ? { type: c.user.type } : {}) },
    ...(typeof c?.in_reply_to_id === "number" ? { inReplyToId: c.in_reply_to_id } : {}),
  };
}

/** Loose octokit shape the client needs; real and fake octokits both satisfy it. */
export interface OctokitLike {
  rest: {
    pulls: {
      listFiles: (params: any) => Promise<any>;
      listReviews: (params: any) => Promise<any>;
      createReview: (params: any) => Promise<any>;
      get: (params: any) => Promise<any>;
      listReviewComments: (params: any) => Promise<any>;
      getReviewComment: (params: any) => Promise<any>;
      createReplyForReviewComment: (params: any) => Promise<any>;
    };
    repos: {
      getContent: (params: any) => Promise<any>;
      listCommits: (params: any) => Promise<any>;
    };
    search: { code: (params: any) => Promise<any> };
    issues: { createComment: (params: any) => Promise<any> };
    checks: { create: (params: any) => Promise<any> };
  };
}

/**
 * GitHub API access for review runs. All calls are installation-scoped
 * (no user PATs); the installation octokit comes from an injectable
 * factory so tests never touch the network.
 */
export class GitHubClient {
  constructor(private readonly getOctokit: (installationId: number) => Promise<OctokitLike>) {}

  static fromApp(app: { getInstallationOctokit: (id: number) => Promise<OctokitLike> }): GitHubClient {
    return new GitHubClient((installationId) => app.getInstallationOctokit(installationId));
  }

  async listPRFiles(installationId: number, owner: string, repo: string, pullNumber: number) {
    const octokit = await this.getOctokit(installationId);
    const files: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page,
      });
      files.push(...data);
      if (data.length < 100) break;
    }
    return files;
  }

  /** Read a text file at a ref; null when it does not exist. */
  async getFileContent(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<string | null> {
    const octokit = await this.getOctokit(installationId);
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
      if (typeof data?.content === "string" && data.encoding === "base64") {
        return Buffer.from(data.content, "base64").toString("utf8");
      }
      return null;
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
  }

  /** True when a review containing our marker was already submitted for this head SHA. */
  async hasReviewedHead(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
  ): Promise<boolean> {
    const octokit = await this.getOctokit(installationId);
    const { data } = await octokit.rest.pulls.listReviews({
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    return data.some(
      (r: any) => r.commit_id === headSha && String(r.body ?? "").includes(REVIEW_MARKER),
    );
  }

  /** Fetch PR title/body/head SHA for `/review` re-requests. */
  async getPullRequest(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ number: number; title: string; body: string | null; draft: boolean; headSha: string }> {
    const octokit = await this.getOctokit(installationId);
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber });
    return {
      number: data.number,
      title: data.title,
      body: data.body ?? null,
      draft: Boolean(data.draft),
      headSha: data.head.sha,
    };
  }

  async submitReview(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    comments: { path: string; line: number; body: string }[],
  ): Promise<void> {
    const octokit = await this.getOctokit(installationId);
    await octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      event: "COMMENT",
      body,
      comments: comments.map((c) => ({ path: c.path, line: c.line, side: "RIGHT", body: c.body })),
    });
  }

  async commentOnPR(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
  ): Promise<void> {
    const octokit = await this.getOctokit(installationId);
    await octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: pullNumber,
      body,
    });
  }

  /** Directory listing (or a single-entry listing when `path` is a file). */
  async listDirectory(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
  ): Promise<{ name: string; path: string; type: string; size?: number }[]> {
    const octokit = await this.getOctokit(installationId);
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner,
        repo,
        path: normalizeDirPath(path),
        ref,
      });
      const entries = Array.isArray(data) ? data : [data];
      return entries.map((e: any) => ({
        name: String(e?.name ?? ""),
        path: String(e?.path ?? ""),
        type: e?.type ?? "file",
        ...(typeof e?.size === "number" ? { size: e.size } : {}),
      }));
    } catch (e: any) {
      if (e?.status === 404) return [];
      throw e;
    }
  }

  /** Search the repository's code (GitHub code search, scoped to this repo). */
  async searchCode(
    installationId: number,
    owner: string,
    repo: string,
    query: string,
    limit = 10,
  ): Promise<{ path: string; excerpt?: string }[]> {
    const octokit = await this.getOctokit(installationId);
    const { data } = await octokit.rest.search.code({
      q: `${query} repo:${owner}/${repo}`,
      per_page: Math.min(Math.max(limit, 1), 30),
    });
    return (data?.items ?? []).slice(0, limit).map((item: any) => {
      const fragment = item?.text_matches?.[0]?.fragment;
      return {
        path: String(item?.path ?? ""),
        ...(fragment ? { excerpt: fragment.trim().slice(0, 400) } : {}),
      };
    });
  }

  /** Recent commits touching a single path, newest first. */
  async listFileCommits(
    installationId: number,
    owner: string,
    repo: string,
    path: string,
    ref: string,
    perPage = 5,
  ): Promise<{ sha: string; message: string; author?: string; date?: string }[]> {
    const octokit = await this.getOctokit(installationId);
    const { data } = await octokit.rest.repos.listCommits({
      owner,
      repo,
      path,
      sha: ref,
      per_page: Math.min(Math.max(perPage, 1), 20),
    });
    return (data ?? []).map((c: any) => ({
      sha: String(c?.sha ?? "").slice(0, 7),
      message: String(c?.commit?.message ?? "").split("\n")[0] ?? "",
      ...(c?.commit?.author?.name ? { author: String(c.commit.author.name) } : {}),
      ...(c?.commit?.author?.date ? { date: String(c.commit.author.date) } : {}),
    }));
  }

  /** All inline review comments on a PR (used for threads and feedback). */
  async listReviewComments(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<ReviewCommentDetail[]> {
    const octokit = await this.getOctokit(installationId);
    const data: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const res = await octokit.rest.pulls.listReviewComments({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page,
      });
      data.push(...(res.data ?? []));
      if ((res.data ?? []).length < 100) break;
    }
    return data.map(toReviewCommentDetail);
  }

  async getReviewComment(
    installationId: number,
    owner: string,
    repo: string,
    commentId: number,
  ): Promise<ReviewCommentDetail | null> {
    const octokit = await this.getOctokit(installationId);
    try {
      const { data } = await octokit.rest.pulls.getReviewComment({
        owner,
        repo,
        comment_id: commentId,
      });
      return toReviewCommentDetail(data);
    } catch (e: any) {
      if (e?.status === 404) return null;
      throw e;
    }
  }

  /** The comment a reply targets plus every reply beneath it, oldest first. */
  async getReviewCommentThread(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
  ): Promise<{ parent: ReviewCommentDetail | null; replies: ReviewCommentDetail[] }> {
    const [parent, all] = await Promise.all([
      this.getReviewComment(installationId, owner, repo, commentId),
      this.listReviewComments(installationId, owner, repo, pullNumber),
    ]);
    const replies = all
      .filter((c) => c.inReplyToId === commentId)
      .sort((a, b) => a.id - b.id);
    return { parent, replies };
  }

  /** Post a reply under an existing inline review comment. */
  async replyToReviewComment(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
    commentId: number,
    body: string,
  ): Promise<number | null> {
    const octokit = await this.getOctokit(installationId);
    const res = await octokit.rest.pulls.createReplyForReviewComment({
      owner,
      repo,
      pull_number: pullNumber,
      comment_id: commentId,
      body,
    });
    const id = res?.data?.id;
    return typeof id === "number" ? id : null;
  }

  async createCheckRun(
    installationId: number,
    owner: string,
    repo: string,
    headSha: string,
    conclusion: "success" | "neutral" | "failure",
    title: string,
    summary: string,
    text?: string,
  ): Promise<void> {
    const octokit = await this.getOctokit(installationId);
    await octokit.rest.checks.create({
      owner,
      repo,
      name: "AI Code Review",
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: {
        title: title.slice(0, 255),
        summary: summary.slice(0, 65_535),
        text: text?.slice(0, 65_535),
      },
    });
  }
}
