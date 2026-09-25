// Runs the compiled node against the real TypeSafe API. Dev-only: `TYPESAFE_API_KEY=... npm run smoke`.
import type { IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';

import { JevClassification } from '../dist/nodes/JevClassification/JevClassification.node.js';

// The community-node linter forbids the `process` global in every .ts file. Only this dev script
// needs env, stdout and the exit code, so it declares the small slice it uses.
declare const process: {
	env: Record<string, string | undefined>;
	stdout: { write(text: string): void };
	exitCode: number;
};

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) {
	process.stdout.write('TYPESAFE_API_KEY is not set\n');
	process.exitCode = 1;
} else {
	await main(apiKey);
}

async function main(key: string) {
	const tickets: INodeExecutionData[] = [
		{
			json: {
				id: 1,
				message: 'I was charged twice for my subscription this month, please refund the duplicate.',
			},
		},
		{
			json: {
				id: 2,
				message: 'The mobile app crashes every time I open the reports tab since the last update.',
			},
		},
		{ json: { id: 3, message: 'Hi, can I change the email address on my account?' } },
	];

	const base = {
		inputType: 'text',
		text: (i: number) => tickets[i].json.message as string,
		categories: {
			categories: [
				{ category: 'Billing', description: 'Payments, invoices and refunds' },
				{ category: 'Technical', description: 'Bugs, crashes and errors' },
				{ category: 'Account', description: 'Profile, login and account settings' },
			],
		},
		levels: {
			levels: [
				{ level: 'Calm' },
				{ level: 'Slightly annoyed' },
				{ level: 'Frustrated' },
				{ level: 'Furious' },
			],
		},
	};

	const runs: Array<{ name: string; params: Record<string, unknown>; outputCount: number }> = [
		{
			name: 'classify',
			params: {
				...base,
				operation: 'classify',
				instructions: 'Which team should handle this ticket?',
				options: {},
			},
			outputCount: 4,
		},
		{
			name: 'classify batched (itemsPerRequest 3, concurrency 2)',
			params: {
				...base,
				operation: 'classify',
				instructions: 'Which team should handle this ticket?',
				options: { itemsPerRequest: 3, concurrency: 2 },
			},
			outputCount: 4,
		},
		{
			name: 'score',
			params: {
				...base,
				operation: 'score',
				instructions: 'How frustrated is the customer?',
				options: {},
			},
			outputCount: 1,
		},
		{
			name: 'check',
			params: {
				...base,
				operation: 'check',
				instructions: 'Does the message ask for a refund?',
				yesMeans: 'The customer wants money back',
				noMeans: '',
				options: {},
			},
			outputCount: 2,
		},
		{
			name: 'ask',
			params: {
				inputType: 'item',
				operation: 'ask',
				questions: {
					urgent: { type: 'noul', instructions: 'Does this need a reply within the hour?' },
					language: {
						type: 'choice',
						instructions: 'Which language is the message written in?',
						criteria: { en: null, de: null, other: null },
					},
				},
				options: { concurrency: 2 },
			},
			outputCount: 1,
		},
	];

	let failed = false;
	for (const { name, params, outputCount } of runs) {
		process.stdout.write(`\n== ${name}\n`);
		try {
			const outputs = await new JevClassification().execute.call(makeContext(key, tickets, params));
			const total = outputs.reduce((sum, output) => sum + output.length, 0);
			if (outputs.length !== outputCount || total !== tickets.length) {
				failed = true;
				process.stdout.write(
					`FAIL: expected ${outputCount} outputs with ${tickets.length} items, got ${outputs.length} outputs with ${total} items\n`,
				);
			}
			outputs.forEach((output, index) => {
				for (const item of output) {
					process.stdout.write(
						`output ${index} item ${item.json.id}: ${JSON.stringify(item.json.jev)}\n`,
					);
				}
			});
		} catch (error) {
			failed = true;
			process.stdout.write(`FAIL: ${(error as Error).message}\n`);
		}
	}
	process.stdout.write(failed ? '\nSMOKE FAILED\n' : '\nSMOKE OK\n');
	if (failed) process.exitCode = 1;
}

function makeContext(
	key: string,
	items: INodeExecutionData[],
	params: Record<string, unknown>,
): IExecuteFunctions {
	const ctx = {
		getInputData: () => items,
		getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => {
			const value = params[name];
			if (typeof value === 'function') return value(itemIndex);
			return value ?? fallback;
		},
		getNode: () => ({
			id: '1',
			name: 'Jev Classification',
			type: 'jevClassification',
			typeVersion: 1,
			position: [0, 0],
			parameters: {},
		}),
		continueOnFail: () => false,
		getCredentials: async () => ({
			apiKey: key,
			baseUrl: process.env.TYPESAFE_BASE_URL ?? 'https://api.typesafe.ai',
		}),
		helpers: {
			httpRequestWithAuthentication: async (
				_credential: string,
				opts: { method: string; url: string; body: unknown },
			) => {
				const response = await fetch(opts.url, {
					method: opts.method,
					headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
					body: JSON.stringify(opts.body),
				});
				// Mirror n8n's http helper: JSON when the server sends JSON, raw text otherwise
				// (TypeSafe's edge occasionally answers 503 with a plain-text body).
				const text = await response.text();
				const isJson = (response.headers.get('content-type') ?? '').includes('json');
				return {
					statusCode: response.status,
					headers: Object.fromEntries(response.headers),
					body: isJson ? JSON.parse(text) : text,
				};
			},
		},
	};
	return ctx as unknown as IExecuteFunctions;
}
