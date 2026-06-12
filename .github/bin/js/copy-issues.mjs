#!/usr/bin/env node

import { spawn } from 'node:child_process';

const DEFAULT_SOURCE = 'vienthuong/shopware';
const DEFAULT_TARGET = 'gweiermann/shopware';

async function main() {
    const args = parseArgs(process.argv.slice(2));

    if (args.help) {
        printHelp();
        return;
    }

    const source = parseRepo(args.source ?? DEFAULT_SOURCE, '--source');
    const target = parseRepo(args.target ?? DEFAULT_TARGET, '--target');
    const state = args.state ?? 'open';
    const execute = Boolean(args.execute);
    const skipExisting = args.skipExisting !== false;

    if (!['open', 'closed', 'all'].includes(state)) {
        throw new Error(`Invalid --state "${state}". Use open, closed, or all.`);
    }

    const client = new GitHubClient();

    console.log(`${execute ? 'Copying' : 'Dry run for'} ${state} issues from ${source.fullName} to ${target.fullName}`);

    const sourceIssues = await listIssues(client, source, state);
    const targetIssuesByTitle = skipExisting
        ? await listTargetIssuesByTitle(client, target)
        : new Map();

    console.log(`Found ${sourceIssues.length} source issue(s).`);

    const targetLabels = execute
        ? await listLabelsByName(client, target)
        : new Map();

    let created = 0;
    let skipped = 0;

    for (const issue of sourceIssues) {
        if (skipExisting && targetIssuesByTitle.has(issue.title)) {
            skipped += 1;
            console.log(`skip #${issue.number}: target already has issue with same title: ${issue.title}`);
            continue;
        }

        const labels = issue.labels.map((label) => label.name);

        if (!execute) {
            console.log(`would create #${issue.number}: ${issue.title}`);
            console.log(`  labels: ${labels.length > 0 ? labels.join(', ') : '(none)'}`);
            continue;
        }

        await ensureLabels(client, target, issue.labels, targetLabels);

        const createdIssue = await client.request(`/repos/${target.owner}/${target.repo}/issues`, {
            method: 'POST',
            body: {
                title: issue.title,
                body: issue.body ?? '',
                labels,
            },
        });

        created += 1;
        console.log(`created #${createdIssue.number} from source #${issue.number}: ${issue.title}`);

        if (issue.state === 'closed') {
            await client.request(`/repos/${target.owner}/${target.repo}/issues/${createdIssue.number}`, {
                method: 'PATCH',
                body: { state: 'closed' },
            });
            console.log(`  closed target #${createdIssue.number} to match source state`);
        }
    }

    console.log(`${execute ? 'Done' : 'Dry run complete'}: ${created} created, ${skipped} skipped.`);
}

async function listIssues(client, repo, issueState) {
    const issues = await client.paginate(`/repos/${repo.owner}/${repo.repo}/issues`, {
        state: issueState,
        per_page: 100,
        sort: 'created',
        direction: 'asc',
    });

    return issues
        .filter((issue) => issue.pull_request === undefined)
        .map((issue) => ({
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels.map((label) => ({
                name: label.name,
                color: label.color,
                description: label.description,
            })),
        }));
}

async function listTargetIssuesByTitle(client, repo) {
    const issues = await client.paginate(`/repos/${repo.owner}/${repo.repo}/issues`, {
        state: 'all',
        per_page: 100,
    });

    return new Map(
        issues
            .filter((issue) => issue.pull_request === undefined)
            .map((issue) => [issue.title, issue]),
    );
}

async function listLabelsByName(client, repo) {
    const labels = await client.paginate(`/repos/${repo.owner}/${repo.repo}/labels`, {
        per_page: 100,
    });

    return new Map(labels.map((label) => [label.name, label]));
}

async function ensureLabels(client, repo, sourceLabels, targetLabels) {
    for (const label of sourceLabels) {
        if (targetLabels.has(label.name)) {
            continue;
        }

        await client.request(`/repos/${repo.owner}/${repo.repo}/labels`, {
            method: 'POST',
            body: {
                name: label.name,
                color: label.color || 'ededed',
                description: label.description ?? '',
            },
        });

        targetLabels.set(label.name, label);
        console.log(`  created missing label: ${label.name}`);
    }
}

class GitHubClient {
    async paginate(path, query) {
        const pages = await this.run([
            'api',
            '--paginate',
            '--slurp',
            '-X',
            'GET',
            path,
            ...toFields({ ...query, page: 1 }),
        ]);

        return JSON.parse(pages).flat();
    }

    async request(path, options = {}) {
        const output = await this.run([
            'api',
            '-X',
            options.method ?? 'GET',
            path,
            ...toFields(options.query ?? {}),
            ...(options.body === undefined ? [] : ['--input', '-']),
        ], options.body);

        if (output.trim() === '') {
            return null;
        }

        return JSON.parse(output);
    }

    run(args, body) {
        return new Promise((resolve, reject) => {
            const child = spawn('gh', args, {
                stdio: ['pipe', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');

            child.stdout.on('data', (chunk) => {
                stdout += chunk;
            });

            child.stderr.on('data', (chunk) => {
                stderr += chunk;
            });

            child.on('error', (error) => {
                if (error.code === 'ENOENT') {
                    reject(new Error('GitHub CLI `gh` was not found. Install it and run `gh auth login` first.'));
                    return;
                }

                reject(error);
            });

            child.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`gh ${args.join(' ')} failed with exit code ${code}\n${stderr.trim()}`));
                    return;
                }

                resolve(stdout);
            });

            if (body === undefined) {
                child.stdin.end();
                return;
            }

            child.stdin.end(JSON.stringify(body));
        });
    }
}

function toFields(values) {
    return Object.entries(values).flatMap(([key, value]) => ['-f', `${key}=${value}`]);
}

function parseArgs(argv) {
    const parsed = {};

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '--help' || arg === '-h') {
            parsed.help = true;
            continue;
        }

        if (arg === '--execute') {
            parsed.execute = true;
            continue;
        }

        if (arg === '--no-skip-existing') {
            parsed.skipExisting = false;
            continue;
        }

        if (!arg.startsWith('--')) {
            throw new Error(`Unexpected argument: ${arg}`);
        }

        const key = arg.slice(2);
        const value = argv[index + 1];

        if (value === undefined || value.startsWith('--')) {
            throw new Error(`Missing value for ${arg}`);
        }

        parsed[toCamelCase(key)] = value;
        index += 1;
    }

    return parsed;
}

function parseRepo(value, optionName) {
    const match = value.match(/^([^/\s]+)\/([^/\s]+)$/);

    if (!match) {
        throw new Error(`${optionName} must use owner/repo format, got "${value}".`);
    }

    return {
        owner: match[1],
        repo: match[2],
        fullName: value,
    };
}

function toCamelCase(value) {
    return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

function printHelp() {
    console.log(`
Copy GitHub issues from one repository to another.

Copies only:
  - title
  - description/body
  - labels

Comments/replies, assignees, milestones, projects, linked PRs, and reactions are not copied.
Pull requests returned by GitHub's issues API are ignored.

Usage:
  node .github/bin/js/copy-issues.mjs [options]

Options:
  --source owner/repo          Source repository. Default: ${DEFAULT_SOURCE}
  --target owner/repo          Target repository. Default: ${DEFAULT_TARGET}
  --state open|closed|all      Source issue state. Default: open
  --execute                    Actually create issues. Without this, only prints a dry run.
  --no-skip-existing           Do not skip target issues with an exact matching title.
  --help                       Show this help.

Requires GitHub CLI authentication:
  gh auth login
`);
}

await main();
