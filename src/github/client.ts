import type { App } from "octokit";
import type { PRFile } from "../types.js";
import { REVIEW_MARKER } from "../review/report.js";

/** The narrow slice of Octokit's REST client the reviewer uses (easy to fake in tests). */
export interface OctokitLike {
  rest: {
    pulls: {
      listFiles: (params: any) => Promise<{ data: any[] }>;
      listReviews: (params: any) => Promise<{ data: any[] }>;
      createReview: (params: any) => Promise<unknown>;
      get: (params: any) => Promise<{ data: any }>;
    };
    repos: {
      getContent: (params: any) => Promise<{ data: any }>;
    };
    issues: {
      createComment: (params: any) => Promise<unknown>;
    };
    checks: {
      create: (params: any) => Promise<unknown>;
    };
  };
}

export interface ReviewComment {
  path: string;
  line: number;
  body: string;
}

/**
 * GitHub API access for review runs. All calls are installation-scoped
 * (no user PATs); the installation octokit comes from an injectable
 * factory so tests never touch the network.
 */
export class GitHubClient {
  constructor(
    private readonly getOctokit: (installationId: number) => Promise<OctokitLike>,
  ) {}

  static fromApp(app: App): GitHubClient {
    return new GitHubClient((installationId) => app.getInstallationOctokit(installationId));
  }

  async listPRFiles(
    installationId: number,
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<PRFile[]> {
    const octokit = await this.getOctokit(installationId);
    const files: PRFile[] = [];
    for (let page = 1; page <= 10; page++) {
      const { data } = await octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: pullNumber,
        per_page: 100,
        page,
      });
      files.push(...(data as PRFile[]));
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
    } catch (e) {
      if ((e as any)?.status === 404) return null;
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
    comments: ReviewComment[],
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
