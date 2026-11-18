import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { loadReport, type DashboardReport } from "./dashboard-reports.ts";
import { DashboardRunner } from "./dashboard-runner.ts";

const recordSchema = z.object({
  repository: z.string(),
  branch: z.string(),
  reports: z.array(z.string()),
});
type SavedRun = z.infer<typeof recordSchema>;
type Job = {
  id: string;
  repository: string;
  branch: string;
  status: "Running" | "Passed" | "Failed";
  message: string;
  reportIds: string[];
  setupComplete?: true;
};
type Selection = {
  repository: string;
  branch?: string;
  allowBuildSmoke?: true;
};

export class DashboardJobs {
  private runner: DashboardRunner;
  private manifests: string;
  private active = false;
  jobs: Job[] = [];
  reports: DashboardReport[] = [];

  constructor(config: string | undefined, output: string) {
    this.runner = new DashboardRunner(config, output);
    this.manifests = path.join(output, "dashboard-history");
  }

  async restore() {
    await this.runner.restoreSetups();
    await mkdir(this.manifests, { recursive: true });
    const files = await readdir(this.manifests);
    for (const filename of files
      .filter((name) => /^\d+-[\da-f-]+\.json$/.test(name))
      .sort()) {
      try {
        const record = recordSchema.parse(
          JSON.parse(
            await readFile(path.join(this.manifests, filename), "utf8"),
          ),
        );
        await this.addReports(record);
      } catch (error) {
        console.error(
          `Saved run ${filename} is unavailable: ${message(error)}`,
        );
      }
    }
  }

  repositories() {
    return this.runner.repositories();
  }

  branches(repository: string) {
    return this.runner.branches(repository);
  }

  async start(repositories: Selection[]) {
    if (this.active)
      return {
        status: 409,
        error: "Wait for the current benchmark to finish.",
      };
    this.active = true;
    try {
      const catalog = await this.repositories();
      const available = new Map(catalog.map((item) => [item.fullName, item]));
      const names = new Set();
      const entries = repositories.flatMap(
        ({ repository, branch, allowBuildSmoke }) => {
          const repo = available.get(repository);
          if (!repo || names.has(repository)) return [];
          names.add(repository);
          const job: Job = {
            id: randomUUID(),
            repository,
            branch: branch ?? repo.defaultBranch,
            status: "Running",
            message: "Preparing benchmark.",
            reportIds: [],
          };
          return [{ job, allowBuildSmoke }];
        },
      );
      if (entries.length !== repositories.length) {
        this.active = false;
        return {
          status: 400,
          error:
            "Select distinct repositories from the GitHub repository list.",
        };
      }
      const jobs = entries.map(({ job }) => job);
      this.jobs.unshift(...jobs);
      void Promise.all(
        entries.map(({ job, allowBuildSmoke }) =>
          this.run(job, allowBuildSmoke),
        ),
      ).finally(() => {
        this.active = false;
      });
      return { status: 202, jobs };
    } catch (error) {
      this.active = false;
      throw error;
    }
  }

  private async run(job: Job, allowBuildSmoke = false) {
    try {
      const result = await this.runner.run(
        job.repository,
        job.branch,
        allowBuildSmoke,
        (progress) => {
          job.message = progress;
        },
      );
      if (result.setupComplete) job.setupComplete = true;
      const record = {
        repository: job.repository,
        branch: job.branch,
        reports: result.reports,
      };
      job.reportIds = await this.addReports(record);
      const filename = path.join(
        this.manifests,
        `${Date.now()}-${job.id}.json`,
      );
      const pending = `${filename}.tmp`;
      await writeFile(pending, JSON.stringify(record));
      await rename(pending, filename);
      job.status = result.passed && !result.setupError ? "Passed" : "Failed";
      job.message =
        result.setupError ??
        (result.passed
          ? "Benchmark complete."
          : "A benchmark check failed. Open the report for evidence.");
    } catch (error) {
      job.status = "Failed";
      job.message = message(error);
    }
  }

  private async addReports(record: SavedRun) {
    const added = await Promise.all(
      record.reports.map((source) =>
        loadReport(record.repository, source, randomUUID(), record.branch),
      ),
    );
    this.reports.push(...added);
    return added.map((report) => report.data.id);
  }
}

export function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
